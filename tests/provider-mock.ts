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
 *   GET  /v1/messages/:batch_id/events  ?since=<next_cursor | event_id> (or ?cursor=<opaque>). ≤ page_size (1000)
 *                                       per page, { events, next_cursor, has_more }; shuffled within the page; every
 *                                       page after the first repeats ~10 % of the previous page (duplicates across
 *                                       pages, never lost events). Probe semantics (docs/provider-api.md, rows b, c, f):
 *                                       `since` is honoured only when it is one of THIS batch's cursors — an event id,
 *                                       a bogus value or another batch's cursor restarts the stream from the top (200,
 *                                       never 400); `next_cursor` is null once `has_more` is false. A programmed batch
 *                                       (below) answers `has_more = true` with an empty page and an unchanged cursor
 *                                       while not every source event is `released` — the open stream of row c.
 *   GET  /healthz                       {} (no auth), like the real one.
 *   POST /__mock/batches/:batch_id      { events, page_size?, shuffle?, duplicate_across_pages?, released? } — Story 6.3:
 *                                       program a batch's report stream by hand (creating the batch if the POST never
 *                                       happened, e.g. one recorded straight into the DB): `events` are served in
 *                                       that order (shuffled per page when `shuffle`), `page_size` overrides the global
 *                                       one for this batch, `duplicate_across_pages` (default true) repeats ~10 % of the
 *                                       previous page, `released` caps how many source events are visible (default all)
 *                                       — raise it between two poll runs to release the second half of the stream;
 *                                       `endless` (default false) never closes the stream: every page carries one
 *                                       event (cycling through `events`) and a fresh cursor — the page-cap drill.
 *   POST /__mock/reset                  forget every batch, call and override.
 *   POST /__mock/config                 { status?, reject_ids?, latency_ms?, page_size?, blank_body?, events_status?,
 *                                       events_fail_next?, events_retry_after? } — `status` forces the next POSTs to
 *                                       answer that code (e.g. 500 / 422) WITHOUT storing anything for the key (a
 *                                       failed call is not an idempotent success); `blank_body` accepts and STORES the
 *                                       batch for the key but answers 200 with an empty body — the "provider
 *                                       committed, the response was lost" crash drill (a replay of the key then
 *                                       returns the stored batch_id). Story 6.3: `events_status` forces the next
 *                                       `events_fail_next` GET /events (default: every one while set) to answer that
 *                                       code with the probe's error body — a 429 / 503 carries `Retry-After:
 *                                       <events_retry_after>` (header AND body `retry_after`, default 1 s).
 *                                       `events_malformed_next` answers the next N GETs with a 200 whose body is not
 *                                       JSON; `events_null_cursor` (while true) answers every page of a programmed
 *                                       batch with `has_more: true` and `next_cursor: null` — D-8's contract violation.
 *   GET  /__mock/calls                  [{ key, batch_id, status }] — every POST /v1/messages seen, in order.
 *   GET  /__mock/reads                  [{ batch_id, since, status, events, has_more }] — every GET /events seen.
 *
 * `startProviderMock(port)` for Vitest's globalSetup (tests/global-setup.ts); standalone: `pnpm tsx
 * tests/provider-mock.ts` (PROVIDER_MOCK_PORT, default 8787) while `supabase functions serve` points at it
 * through host.docker.internal.
 */
export type MockRecipientEcho = string | { id?: string; external_id?: string; contact_id?: string; recipient_id?: string; email?: string };

export type MockEvent = { event_id: string; type: "delivered" | "opened" | "bounced" | "unsubscribed"; external_id: string; occurred_at: string };

/** A programmed event (Story 6.3): anything JSON — the poller must survive a `weird` type or a foreign recipient. */
export type ProgrammedEvent = Record<string, unknown>;

export type BatchProgram = {
  events: ProgrammedEvent[];
  page_size?: number;
  shuffle?: boolean;
  duplicate_across_pages?: boolean;
  /** How many of `events` (in canonical order) are visible; the rest are "not yet reported" — the stream stays open. */
  released?: number;
  /** Never close: one event per page (cycling) and a fresh cursor every time — the poller must stop at its page cap. */
  endless?: boolean;
};

export type MockCall = { key: string | null; batch_id: string | null; status: number; recipients: number; replay: boolean };

type StoredResponse = { status: number; body: unknown };

type Batch = { batch_id: string; recipients: string[]; accepted: string[]; rejected: string[]; events: MockEvent[]; created_at: string; program?: Required<BatchProgram> };

export type MockConfig = {
  status?: number | null;
  reject_ids?: string[];
  latency_ms?: number;
  page_size?: number;
  blank_body?: boolean;
  /** Story 6.3: force GET /events to answer this code (429 / 503 with Retry-After; 401 / 404 / 500 with the probe's bodies). */
  events_status?: number | null;
  /** How many GETs answer `events_status` before the stream is served again; 0 / absent = every one while it is set. */
  events_fail_next?: number;
  /** Seconds in `Retry-After` (header + body) for a forced 429 / 503. */
  events_retry_after?: number;
  /** Story 6.3 review: answer the next N GET /events with a 200 whose body is not JSON (a malformed 2xx). */
  events_malformed_next?: number;
  /** Story 6.3 review: while true, a programmed batch answers has_more: true with next_cursor: null (cursor_contract_violation). */
  events_null_cursor?: boolean;
};

export type MockRead = { batch_id: string; since: string | null; status: number; events: number; has_more: boolean | null };

const DEFAULT_PAGE_SIZE = 1000;

export type ProviderMockState = {
  byKey: Map<string, StoredResponse>;
  batches: Map<string, Batch>;
  calls: MockCall[];
  reads: MockRead[];
  config: Required<MockConfig>;
  counter: number;
};

export function freshConfig(): Required<MockConfig> {
  return { status: null, reject_ids: [], latency_ms: 0, page_size: DEFAULT_PAGE_SIZE, blank_body: false, events_status: null, events_fail_next: 0, events_retry_after: 1, events_malformed_next: 0, events_null_cursor: false };
}

export function freshState(): ProviderMockState {
  return { byKey: new Map(), batches: new Map(), calls: [], reads: [], config: freshConfig(), counter: 0 };
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

export type EventsPageResponse = { events: Array<MockEvent | ProgrammedEvent>; next_cursor: string | null; has_more: boolean };

/**
 * One page of a batch's events, positional. `offset` = how many events (in canonical order) precede this page.
 * Pages after the first prepend ~10 % of the previous page again (duplicates across pages); the page is
 * shuffled; `next_cursor` is opaque and null once `has_more` is false (probe row c).
 *
 * A programmed batch serves its `events` (its own page size / shuffle / duplicate knobs) up to `released`: past that
 * point the stream is OPEN but empty — `has_more: true`, no events, and the SAME cursor back (probe row c, e3:
 * "has_more means the report stream is still open, not that another page exists"). The cursor is issued at the
 * offset the next page starts from, so a stale cursor kept across runs still returns the items released later
 * (e10 / e15) and a cursor is never wiped by the mock.
 */
export function eventsPage(batch: Batch, offset: number, pageSize: number): EventsPageResponse {
  const program = batch.program;
  const all: Array<MockEvent | ProgrammedEvent> = program ? program.events : batch.events;
  if (program?.endless && all.length > 0) {
    // the stream that never ends: one event per page, always a new cursor, has_more forever
    return { events: [all[offset % all.length]], next_cursor: encodeCursor(batch.batch_id, offset + 1), has_more: true };
  }
  const visible = program ? Math.min(program.released, all.length) : all.length;
  const size = program ? program.page_size : pageSize;
  const duplicate = program ? program.duplicate_across_pages : true;
  const shuffle = program ? program.shuffle : true;
  const start = Math.min(offset, visible);
  const slice = all.slice(start, Math.min(start + size, visible));
  // nothing new → nothing to repeat: an open stream with nothing released yet is an EMPTY page (probe e3)
  const dupCount = duplicate && start > 0 && slice.length > 0 ? Math.max(1, Math.floor(slice.length / 10)) : 0;
  const dups = dupCount > 0 ? all.slice(Math.max(0, start - dupCount), start) : [];
  const raw = [...dups, ...slice];
  const page = shuffle ? shuffled(raw, hashString(`${batch.batch_id}:${start}`)) : raw;
  const nextOffset = start + slice.length;
  if (program) {
    // the stream stays open until every source event has been released (and served); then it closes with a null cursor
    const closed = nextOffset >= all.length;
    return { events: page, next_cursor: closed ? null : encodeCursor(batch.batch_id, nextOffset), has_more: !closed };
  }
  const hasMore = nextOffset < all.length;
  return { events: page, next_cursor: hasMore ? encodeCursor(batch.batch_id, nextOffset) : null, has_more: hasMore };
}

/** Normalise a `POST /__mock/batches/:id` body; `events` must be an array of objects. */
export function parseBatchProgram(raw: unknown): Required<BatchProgram> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as BatchProgram;
  if (!Array.isArray(body.events) || !body.events.every((e) => e && typeof e === "object" && !Array.isArray(e))) return null;
  const pageSize = typeof body.page_size === "number" && body.page_size >= 1 ? Math.floor(body.page_size) : DEFAULT_PAGE_SIZE;
  const released = typeof body.released === "number" && body.released >= 0 ? Math.floor(body.released) : body.events.length;
  return {
    events: body.events,
    page_size: pageSize,
    shuffle: body.shuffle !== false,
    duplicate_across_pages: body.duplicate_across_pages !== false,
    released,
    endless: body.endless === true,
  };
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
        state.reads = fresh.reads;
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
        if (typeof patch.blank_body === "boolean") state.config.blank_body = patch.blank_body;
        if ("events_status" in patch) state.config.events_status = typeof patch.events_status === "number" ? patch.events_status : null;
        if (typeof patch.events_fail_next === "number") state.config.events_fail_next = Math.max(0, Math.floor(patch.events_fail_next));
        if (typeof patch.events_retry_after === "number") state.config.events_retry_after = Math.max(0, patch.events_retry_after);
        if (typeof patch.events_malformed_next === "number") state.config.events_malformed_next = Math.max(0, Math.floor(patch.events_malformed_next));
        if (typeof patch.events_null_cursor === "boolean") state.config.events_null_cursor = patch.events_null_cursor;
        return send(res, 200, state.config);
      }
      if (url.pathname === "/__mock/calls" && method === "GET") return send(res, 200, state.calls);
      if (url.pathname === "/__mock/reads" && method === "GET") return send(res, 200, state.reads);
      const programMatch = url.pathname.match(/^\/__mock\/batches\/([^/]+)$/);
      if (programMatch && method === "POST") {
        // Story 6.3: program (or re-program) one batch's report stream; creates the batch when the POST never happened
        const batchId = decodeURIComponent(programMatch[1]);
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          return send(res, 400, { error: "invalid_json", message: "body must be JSON" });
        }
        const program = parseBatchProgram(parsed);
        if (!program) return send(res, 400, { error: "invalid_program", message: "events must be an array of objects" });
        const existing = state.batches.get(batchId);
        const recipients = [...new Set(program.events.map((e) => normaliseRecipient(e as MockRecipientEcho)).filter((id): id is string => typeof id === "string"))];
        const batch: Batch = existing ?? { batch_id: batchId, recipients, accepted: recipients, rejected: [], events: [], created_at: new Date().toISOString() };
        batch.program = program;
        state.batches.set(batchId, batch);
        return send(res, 200, { batch_id: batchId, events: program.events.length, released: program.released, page_size: program.page_size, shuffle: program.shuffle, duplicate_across_pages: program.duplicate_across_pages });
      }
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
        if (state.config.blank_body) {
          // committed on the provider's side, response lost on the way back: 200 with nothing in it
          res.writeHead(200, { "Content-Length": 0 });
          return res.end();
        }
        return send(res, 200, body);
      }

      const events = url.pathname.match(/^\/v1\/messages\/([^/]+)\/events$/);
      if (events && method === "GET") {
        const requestedId = decodeURIComponent(events[1]);
        const sinceParam = url.searchParams.get("since") ?? url.searchParams.get("cursor");
        // a forced status on the report stream (Story 6.3 drills): the probe's error shapes, Retry-After on 429 / 503
        if (state.config.events_status !== null && state.config.events_status !== 200) {
          const forced = state.config.events_status;
          if (state.config.events_fail_next > 0 && --state.config.events_fail_next === 0) state.config.events_status = null;
          state.reads.push({ batch_id: requestedId, since: sinceParam, status: forced, events: 0, has_more: null });
          if (forced === 429 || forced === 503) {
            const wait = state.config.events_retry_after;
            const body = forced === 429
              ? { error: "rate_limited", message: "too many requests", retry_after: wait }
              : { error: "service_unavailable", message: "reports temporarily unavailable", retry_after: wait };
            const text = JSON.stringify(body);
            res.writeHead(forced, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Retry-After": String(wait) });
            return res.end(text);
          }
          if (forced === 401) return send(res, 401, { error: "unauthorized", message: "Provide your API key as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'." });
          if (forced === 404) return send(res, 404, { error: "not_found", message: "unknown batch_id" });
          return send(res, forced, { error: `forced_${forced}`, message: `mock forced status ${forced}` });
        }
        if (state.config.events_malformed_next > 0) {
          // a 2xx that is not the contract: the poller must record provider_error for the batch and touch no cursor
          state.config.events_malformed_next -= 1;
          state.reads.push({ batch_id: requestedId, since: sinceParam, status: 200, events: 0, has_more: null });
          const text = "<html>not json</html>";
          res.writeHead(200, { "Content-Type": "text/html", "Content-Length": Buffer.byteLength(text) });
          return res.end(text);
        }
        const batch = state.batches.get(requestedId);
        if (!batch) {
          state.reads.push({ batch_id: requestedId, since: sinceParam, status: 404, events: 0, has_more: null });
          return send(res, 404, { error: "not_found", message: "unknown batch_id" });
        }
        // probe rows b / f: `since` (or `cursor`) is honoured only when it is one of THIS batch's opaque cursors; an
        // event id, a bogus value or another batch's cursor is ignored — the full stream again, 200, never a 400
        let offset = 0;
        if (sinceParam) {
          const decoded = decodeCursor(sinceParam);
          if (decoded && decoded.b === batch.batch_id) offset = decoded.o;
        }
        const page = eventsPage(batch, offset, state.config.page_size);
        if (state.config.events_null_cursor && batch.program) {
          // D-8's cursor_contract_violation, unobserved on the real provider: has_more with nothing to follow
          page.has_more = true;
          page.next_cursor = null;
        }
        state.reads.push({ batch_id: batch.batch_id, since: sinceParam, status: 200, events: page.events.length, has_more: page.has_more });
        return send(res, 200, page);
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
