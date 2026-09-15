import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

/**
 * Story 4.3 — the provider mock (architecture D-14, Step-3 amendment #15): CI and local development never
 * dispatch a real batch. Mirrors docs/provider-api.md closely enough for the Edge Function and, for Epic 6,
 * serves the messy report stream the brief promises (shuffled within a page, ~10 % duplicated across pages)
 * that the provider's own docs deny.
 *
 *   POST /v1/messages                   401 without `Authorization` / `X-API-Key`. Keyed on `Idempotency-Key`:
 *                                       a replayed key returns the stored response verbatim (same batch_id,
 *                                       same accepted/rejected). New key → batch_id 'mock-<n>', accepted =
 *                                       the normalised recipient ids minus state.reject_ids, rejected = the
 *                                       rest; the recipients are stored and the delivery events pre-generated.
 *   GET  /v1/messages/:batch_id/events  ?since=<event_id> | ?cursor=<opaque>. ≤ page_size (1000) per page,
 *                                       { events, next_cursor, has_more }; shuffled within the page; every page
 *                                       after the first repeats ~10 % of the previous page (duplicates across
 *                                       pages, never lost events).
 *   GET  /healthz                       {} (no auth), like the real one.
 *   POST /__mock/reset                  forget every batch, call and override.
 *   POST /__mock/config                 { status?, reject_ids?, latency_ms?, page_size? } — `status` forces the
 *                                       next POSTs to answer that code (e.g. 500 / 422) WITHOUT storing anything
 *                                       for the key (a failed call is not an idempotent success).
 *   GET  /__mock/calls                  [{ key, batch_id, status }] — every POST /v1/messages seen, in order.
 *
 * `startProviderMock(port)` for Vitest's globalSetup (tests/global-setup.ts); standalone: `pnpm tsx
 * tests/provider-mock.ts` (PROVIDER_MOCK_PORT, default 8787) while `supabase functions serve` points at it
 * through host.docker.internal.
 */
export type MockRecipientEcho = string | { id?: string; external_id?: string; contact_id?: string; recipient_id?: string; email?: string };

export type MockEvent = { event_id: string; type: "delivered" | "opened" | "bounced" | "unsubscribed"; external_id: string; occurred_at: string };

export type MockCall = { key: string | null; batch_id: string | null; status: number; recipients: number; replay: boolean };

type StoredResponse = { status: number; body: unknown };

type Batch = { batch_id: string; recipients: string[]; accepted: string[]; rejected: string[]; events: MockEvent[]; created_at: string };

export type MockConfig = { status?: number | null; reject_ids?: string[]; latency_ms?: number; page_size?: number };

const DEFAULT_PAGE_SIZE = 1000;

export type ProviderMockState = {
  byKey: Map<string, StoredResponse>;
  batches: Map<string, Batch>;
  calls: MockCall[];
  config: Required<MockConfig>;
  counter: number;
};

export function freshState(): ProviderMockState {
  return { byKey: new Map(), batches: new Map(), calls: [], config: { status: null, reject_ids: [], latency_ms: 0, page_size: DEFAULT_PAGE_SIZE }, counter: 0 };
}

/** The provider keys a recipient on id / external_id / contact_id / recipient_id / email. */
export function normaliseRecipient(item: MockRecipientEcho): string | null {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return null;
  const id = item.external_id ?? item.id ?? item.contact_id ?? item.recipient_id ?? item.email;
  return typeof id === "string" ? id : null;
}

/** A small deterministic PRNG (mulberry32) so a page's shuffle is stable for a given batch + offset. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const next = prng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Every accepted recipient is delivered; every 10th opens, every 25th bounces, every 50th unsubscribes. */
export function generateEvents(batchId: string, accepted: string[], startedAt: Date): MockEvent[] {
  const events: MockEvent[] = [];
  let n = 0;
  const at = (offsetSeconds: number) => new Date(startedAt.getTime() + offsetSeconds * 1000).toISOString();
  accepted.forEach((id, i) => events.push({ event_id: `${batchId}-ev-${++n}`, type: "delivered", external_id: id, occurred_at: at(i) }));
  accepted.forEach((id, i) => {
    if (i % 25 === 24) events.push({ event_id: `${batchId}-ev-${++n}`, type: "bounced", external_id: id, occurred_at: at(accepted.length + i) });
    else if (i % 10 === 9) events.push({ event_id: `${batchId}-ev-${++n}`, type: "opened", external_id: id, occurred_at: at(accepted.length + i) });
    if (i % 50 === 49) events.push({ event_id: `${batchId}-ev-${++n}`, type: "unsubscribed", external_id: id, occurred_at: at(2 * accepted.length + i) });
  });
  return events;
}

function encodeCursor(batchId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ b: batchId, o: offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { b: string; o: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { b?: unknown; o?: unknown };
    if (typeof parsed.b === "string" && typeof parsed.o === "number" && parsed.o >= 0) return { b: parsed.b, o: parsed.o };
  } catch {
    // fall through
  }
  return null;
}

/**
 * One page of a batch's events, positional. `offset` = how many events (in canonical order) precede this page.
 * Pages after the first prepend ~10 % of the previous page again (duplicates across pages); the page is
 * shuffled; `next_cursor` is opaque and null once `has_more` is false.
 */
export function eventsPage(batch: Batch, offset: number, pageSize: number): { events: MockEvent[]; next_cursor: string | null; has_more: boolean } {
  const all = batch.events;
  const slice = all.slice(offset, offset + pageSize);
  const dupCount = offset > 0 ? Math.max(1, Math.floor(slice.length / 10)) : 0;
  const dups = offset > 0 ? all.slice(Math.max(0, offset - dupCount), offset) : [];
  const page = shuffled([...dups, ...slice], hashString(`${batch.batch_id}:${offset}`));
  const nextOffset = offset + slice.length;
  const hasMore = nextOffset < all.length;
  return { events: page, next_cursor: hasMore ? encodeCursor(batch.batch_id, nextOffset) : null, has_more: hasMore };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function authorised(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];
  return (typeof auth === "string" && /^bearer\s+\S+/i.test(auth)) || (typeof apiKey === "string" && apiKey.length > 0);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createProviderMock(state: ProviderMockState = freshState()): { server: Server; state: ProviderMockState } {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://mock");
      const method = req.method ?? "GET";

      // control surface (no auth)
      if (url.pathname === "/__mock/reset" && method === "POST") {
        await readBody(req);
        const fresh = freshState();
        state.byKey = fresh.byKey;
        state.batches = fresh.batches;
        state.calls = fresh.calls;
        state.config = fresh.config;
        state.counter = 0;
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/__mock/config" && method === "POST") {
        const raw = await readBody(req);
        const patch = (raw ? JSON.parse(raw) : {}) as MockConfig;
        if ("status" in patch) state.config.status = typeof patch.status === "number" ? patch.status : null;
        if (Array.isArray(patch.reject_ids)) state.config.reject_ids = patch.reject_ids.filter((x): x is string => typeof x === "string");
        if (typeof patch.latency_ms === "number") state.config.latency_ms = Math.max(0, patch.latency_ms);
        if (typeof patch.page_size === "number") state.config.page_size = Math.min(DEFAULT_PAGE_SIZE, Math.max(1, Math.floor(patch.page_size)));
        return send(res, 200, state.config);
      }
      if (url.pathname === "/__mock/calls" && method === "GET") return send(res, 200, state.calls);
      if (url.pathname === "/__mock/batches" && method === "GET") {
        return send(res, 200, [...state.batches.values()].map((b) => ({ batch_id: b.batch_id, recipients: b.recipients.length, accepted: b.accepted.length, rejected: b.rejected.length, events: b.events.length })));
      }
      if (url.pathname === "/healthz" && method === "GET") return send(res, 200, {});

      // the provider proper
      if (!authorised(req)) return send(res, 401, { error: "unauthorized", message: "Authorization: Bearer <API_KEY> or X-API-Key required" });

      if (url.pathname === "/v1/messages" && method === "POST") {
        const raw = await readBody(req);
        if (state.config.latency_ms > 0) await sleep(state.config.latency_ms);
        const keyHeader = req.headers["idempotency-key"];
        const key = typeof keyHeader === "string" && keyHeader.length > 0 ? keyHeader : null;

        // a forced status (5xx / 4xx drills): answered, recorded, never stored for the key
        if (state.config.status !== null && state.config.status !== 200) {
          state.calls.push({ key, batch_id: null, status: state.config.status, recipients: -1, replay: false });
          return send(res, state.config.status, { error: `forced_${state.config.status}`, message: `mock forced status ${state.config.status}` });
        }

        // replay: the stored response, verbatim
        if (key && state.byKey.has(key)) {
          const stored = state.byKey.get(key)!;
          const batchId = (stored.body as { batch_id?: string }).batch_id ?? null;
          state.calls.push({ key, batch_id: batchId, status: stored.status, recipients: -1, replay: true });
          return send(res, stored.status, stored.body);
        }

        let parsed: { recipients?: unknown };
        try {
          parsed = raw ? (JSON.parse(raw) as { recipients?: unknown }) : {};
        } catch {
          state.calls.push({ key, batch_id: null, status: 400, recipients: -1, replay: false });
          return send(res, 400, { error: "invalid_json", message: "body must be JSON" });
        }
        if (!Array.isArray(parsed.recipients) || parsed.recipients.length === 0) {
          state.calls.push({ key, batch_id: null, status: 422, recipients: 0, replay: false });
          return send(res, 422, { error: "invalid_recipients", message: "recipients must be a non-empty array" });
        }
        if (parsed.recipients.length > 100_000) {
          state.calls.push({ key, batch_id: null, status: 422, recipients: parsed.recipients.length, replay: false });
          return send(res, 422, { error: "too_many_recipients", message: "up to 100,000 recipients per call" });
        }
        const ids = (parsed.recipients as MockRecipientEcho[]).map(normaliseRecipient).filter((id): id is string => typeof id === "string");
        const reject = new Set(state.config.reject_ids);
        const accepted = ids.filter((id) => !reject.has(id));
        const rejected = ids.filter((id) => reject.has(id));
        const batchId = `mock-${++state.counter}`;
        const batch: Batch = { batch_id: batchId, recipients: ids, accepted, rejected, events: generateEvents(batchId, accepted, new Date()), created_at: new Date().toISOString() };
        state.batches.set(batchId, batch);
        const body = { batch_id: batchId, accepted, rejected };
        if (key) state.byKey.set(key, { status: 200, body });
        state.calls.push({ key, batch_id: batchId, status: 200, recipients: ids.length, replay: false });
        return send(res, 200, body);
      }

      const events = url.pathname.match(/^\/v1\/messages\/([^/]+)\/events$/);
      if (events && method === "GET") {
        const batch = state.batches.get(decodeURIComponent(events[1]));
        if (!batch) return send(res, 404, { error: "not_found", message: "unknown batch_id" });
        let offset = 0;
        const cursor = url.searchParams.get("cursor");
        const since = url.searchParams.get("since");
        if (cursor) {
          const decoded = decodeCursor(cursor);
          if (!decoded || decoded.b !== batch.batch_id) return send(res, 400, { error: "invalid_cursor", message: "cursor does not belong to this batch" });
          offset = Math.min(decoded.o, batch.events.length);
        } else if (since) {
          const index = batch.events.findIndex((e) => e.event_id === since);
          offset = index >= 0 ? index + 1 : 0; // an unknown `since` restarts from the beginning (the real one may differ: probe, 6.1)
        }
        return send(res, 200, eventsPage(batch, offset, state.config.page_size));
      }

      return send(res, 404, { error: "not_found", message: `${method} ${url.pathname}` });
    } catch (error) {
      send(res, 500, { error: "mock_error", message: error instanceof Error ? error.message : String(error) });
    }
  });
  return { server, state };
}

export type RunningMock = { url: string; port: number; state: ProviderMockState; close: () => Promise<void> };

/** Start the mock on `port` (0 = ephemeral). Rejects with the listen error (EADDRINUSE when one is already up). */
export function startProviderMock(port = Number(process.env.PROVIDER_MOCK_PORT ?? 8787), host = "0.0.0.0"): Promise<RunningMock> {
  const { server, state } = createProviderMock();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        state,
        close: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isMain) {
  startProviderMock()
    .then((mock) => {
      process.stdout.write(`provider mock listening on ${mock.url} (Edge Runtime: http://host.docker.internal:${mock.port})\n`);
      const stop = () => mock.close().finally(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((error) => {
      process.stderr.write(`provider mock: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
