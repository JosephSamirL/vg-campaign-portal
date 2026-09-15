import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireTestLock, testStack } from "./setup";

/**
 * Story 6.3 — the poller against the messy report stream, end to end through the locally served Edge Function
 * and the provider mock (AC6; docs/provider-api.md `## Probe 2026-09-15` rows b, c, e):
 *
 *   supabase functions serve --env-file supabase/mock.env --no-verify-jwt
 *
 * (`supabase/mock.env` points PROVIDER_BASE_URL at http://host.docker.internal:8787, where Vitest's globalSetup runs
 * tests/provider-mock.ts; the function reaches `internal.*` over the SUPABASE_DB_URL the CLI injects.) The fixture is
 * a synthetic brand of its own — a campaign, five contacts, a confirmed portal send with its five-row snapshot
 * (`body_sha256` computed exactly as `confirm_send` does) — built in SQL over DATABASE_URL (the same direct
 * connection `scripts/seed` uses; the shape mirrors 0012's pgTAP fixture) so that nothing in KILELE / KAROO moves
 * while the send and share suites run in parallel against the same stack. The dispatch outcome is recorded through
 * the 0008 functions as batch `B-ING-<n>`, and the mock is programmed to serve that batch's twelve events shuffled,
 * duplicated across pages of four, and released in two halves across two `poll-events` invocations. The resulting `events`, `contacts.suppressed_at` and
 * `v_campaign_performance` row must equal a clean single-run ingest of the same twelve; a further run changes
 * nothing (`ok`, `inserted = 0`). Then the provider's mood: a 503 with a long Retry-After → `deferred`, the next run
 * `ok`; a short Retry-After is waited out inside one run; 401 → `auth_error`; 404 → `provider_error`; and `since`
 * never carries an event id. The 6.3 review's drills are folded in below: the 10-page cap, a concurrent run skipping
 * the locked batch, `cursor_contract_violation`, a malformed 2xx, 429 short / long, an exception inside the batch
 * (caught per batch, `last_polled_at` bumped, the run goes on), and `finish()`'s compare-and-set against a row the
 * reconcile job already closed. Everything the suite creates is deleted in `afterAll`. Skipped loudly when the function
 * is not served (fails under CI).
 */
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const stack = testStack();
const FUNCTIONS_URL = stack ? `${stack.url}/functions/v1/poll-events` : "";
const MOCK_URL = process.env.PROVIDER_MOCK_URL ?? `http://127.0.0.1:${process.env.PROVIDER_MOCK_PORT ?? 8787}`;

/** The direct DB connection for fixtures + `internal.*` reads: TEST_DATABASE_URL, else DATABASE_URL, else the local stack. Never hosted. */
function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? LOCAL_DB_URL;
  if (/supabase\.co|pooler\.supabase\.com/.test(url) && process.env.ALLOW_HOSTED_TESTS !== "1") return null;
  return url;
}

/** The cron secret the locally served function was given (supabase/mock.env). */
function localCronSecret(): string | null {
  if (process.env.TEST_CRON_SECRET) return process.env.TEST_CRON_SECRET;
  if (!existsSync("supabase/mock.env")) return null;
  return dotenv.parse(readFileSync("supabase/mock.env", "utf8")).CRON_SECRET ?? null;
}

/** Is `poll-events` being served? A request without the secret must come back as the function's own 401 unauthorized. */
async function functionServed(): Promise<boolean> {
  if (!stack) return false;
  try {
    const res = await fetch(FUNCTIONS_URL, { method: "POST", headers: { apikey: stack.key, "Content-Type": "application/json" }, body: "{}" });
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    return res.status === 401 && body?.code === "unauthorized";
  } catch {
    return false;
  }
}

async function mockReachable(): Promise<boolean> {
  try {
    return (await fetch(`${MOCK_URL}/healthz`)).ok;
  } catch {
    return false;
  }
}

const cronSecret = localCronSecret();
const missing = [
  ...(stack ? [] : ["TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY"]),
  ...(databaseUrl() ? [] : ["a LOCAL DATABASE_URL / TEST_DATABASE_URL (a hosted URL is refused)"]),
  ...(cronSecret ? [] : ["CRON_SECRET in supabase/mock.env (or TEST_CRON_SECRET)"]),
  ...((await functionServed()) ? [] : ["`supabase functions serve --env-file supabase/mock.env --no-verify-jwt` (poll-events is not served)"]),
  ...((await mockReachable()) ? [] : [`the provider mock at ${MOCK_URL} (tests/global-setup.ts starts it)`]),
];
const configured = missing.length === 0;
if (!configured) {
  const message = `tests/ingestion.test.ts: not configured — missing ${missing.join(", ")}.`;
  if (process.env.CI) throw new Error(`${message} CI requires the ingestion test to run.`);
  process.stderr.write(`\n${"=".repeat(88)}\nSKIPPED: ${message}\n${"=".repeat(88)}\n\n`);
}

type PollResponse = { status: number; body: { status?: string; batches?: number; pages?: number; inserted?: number; duplicates?: number; code?: string } };
type PollLogRow = { id: number; status: string; finished_at: string | null; batches: number | null; pages: number | null; inserted: number | null; duplicates: number | null; error: string | null };
type MockRead = { batch_id: string; since: string | null; status: number; events: number; has_more: boolean | null };

const T0 = Date.parse("2026-09-15T12:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** The twelve programmed events (AC6): delivered ×5, bounced ×2, opened ×3 (one repeat), unsubscribed ×1, one `weird`. */
function programmedEvents(batchId: string, contacts: string[]): Array<Record<string, unknown>> {
  const [c1, c2, c3, c4, c5] = contacts;
  const ev = (n: number, recipient: string, type: string, minute: number) => ({ event_id: `${batchId}-ev-${n}`, recipient_id: recipient, type, occurred_at: at(minute), brand_code: "account" });
  return [
    ev(1, c1, "delivered", 1),
    ev(2, c2, "delivered", 1),
    ev(3, c3, "delivered", 2),
    ev(4, c4, "delivered", 2),
    ev(5, c5, "delivered", 3),
    ev(6, c2, "bounced", 4),
    ev(7, c1, "opened", 5),
    ev(8, c3, "opened", 6),
    ev(9, c4, "bounced", 7),
    ev(10, c1, "opened", 8), // a repeat open for c1 — opens are counted per event, never collapsed
    ev(11, c5, "unsubscribed", 9),
    ev(12, c3, "weird", 10), // an unknown type inserts as `unknown` and aborts nothing
  ];
}

describe.skipIf(!configured)("poll-events: the messy stream lands once, in any order, across runs (synthetic brand, local stack)", () => {
  const sql = configured ? postgres(databaseUrl()!, { max: 1 }) : (null as unknown as ReturnType<typeof postgres>);
  let brandId: string;
  let campaignId: string;
  let sendId: string;
  let batchId: string;
  const contactIds: string[] = [];
  const contactExternalIds: string[] = [];
  const tag = `${Date.now().toString(36)}`;

  async function mock(path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${MOCK_URL}${path}`, body === undefined ? { method: "POST" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`mock ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async function mockReads(): Promise<MockRead[]> {
    return (await (await fetch(`${MOCK_URL}/__mock/reads`)).json()) as MockRead[];
  }
  async function program(overrides: { page_size?: number; shuffle?: boolean; duplicate_across_pages?: boolean; released?: number; endless?: boolean }): Promise<void> {
    await mock(`/__mock/batches/${encodeURIComponent(batchId)}`, { events: programmedEvents(batchId, contactExternalIds), ...overrides });
  }

  async function requestPollLog(): Promise<number> {
    const [row] = await sql<{ id: number }[]>`insert into internal.poll_log (status) values ('requested') returning id`;
    return Number(row.id);
  }
  async function poll(pollLogId: number, headers: Record<string, string> = { "x-cron-secret": cronSecret! }, windowHours = 48): Promise<PollResponse> {
    const res = await fetch(FUNCTIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: stack!.key, ...headers },
      body: JSON.stringify({ poll_log_id: pollLogId, window_hours: windowHours }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as PollResponse["body"] };
  }
  /** Insert a requested row, run the function against it, return the response and the finished row. */
  async function run(): Promise<{ res: PollResponse; log: PollLogRow }> {
    const id = await requestPollLog();
    const res = await poll(id);
    const [log] = await sql<PollLogRow[]>`select id, status::text as status, finished_at, batches, pages, inserted, duplicates, error from internal.poll_log where id = ${id}`;
    return { res, log: { ...log, id: Number(log.id) } };
  }

  type Snapshot = { events: unknown[]; contacts: unknown[]; performance: unknown[] };
  async function snapshot(): Promise<Snapshot> {
    const events = await sql`select event_id, type::text as type, contact_id, batch_id, occurred_at from public.events where send_id = ${sendId} order by event_id`;
    const contacts = await sql`select id, suppressed_at, suppressed_reason from public.contacts where id = any(${contactIds}::uuid[]) order by external_id`;
    const performance = await sql`select source, send_id, sent, delivered, bounced, opens, clicks, unsubscribes, delivered_rate, bounce_rate, open_rate, click_rate, unsubscribe_rate from public.v_campaign_performance where send_id = ${sendId}`;
    return { events: events.map((r) => ({ ...r })), contacts: contacts.map((r) => ({ ...r })), performance: performance.map((r) => ({ ...r })) };
  }
  /** Back to "dispatched, nothing reported yet": events gone, suppression cleared, cursor columns null. */
  async function resetWorld(): Promise<void> {
    await sql`delete from public.events where send_id = ${sendId}`;
    await sql`update public.contacts set suppressed_at = null, suppressed_reason = null where id = any(${contactIds}::uuid[])`;
    await sql`update public.provider_batches set next_cursor = null, last_event_id = null, last_polled_at = null, last_ok_at = null where send_id = ${sendId}`;
  }

  let releaseLock: (() => void) | undefined;

  beforeAll(async () => {
    // the dispatch suite (tests/send-concurrency.test.ts) creates real batches inside the poll window — one at a time
    releaseLock = await acquireTestLock("provider-batches");
    await mock("/__mock/reset");

    // the fixture, in its own brand: a campaign, five contactable contacts, a confirmed portal send whose snapshot is
    // exactly those five (external_ids in contact_id order, body_sha256 as confirm_send computes it — 4.2)
    const [brand] = await sql<{ id: string }[]>`insert into public.brands (code, name) values (${`INGTEST-${tag}`}, ${`Ingestion test brand ${tag}`}) returning id`;
    brandId = brand.id;
    const [campaign] = await sql<{ id: string }[]>`
      insert into public.campaigns (brand_id, external_id, name, channel, target_country, sent_at)
      values (${brandId}, ${`ING-${tag}`}, ${`Ingestion test ${tag}`}, 'email', 'ZZ', now()) returning id`;
    campaignId = campaign.id;
    for (let i = 1; i <= 5; i++) {
      const externalId = `ING-${tag}-C${i}`;
      const [c] = await sql<{ id: string }[]>`
        insert into public.contacts (brand_id, external_id, email, full_name, country, consent_marketing, status, signup_at)
        values (${brandId}, ${externalId}, ${`ing-${tag}-c${i}@vg-eval.test`}, ${`Ingestion ${i}`}, 'ZZ', true, 'active', now()) returning id`;
      contactIds.push(c.id);
      contactExternalIds.push(externalId);
    }
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from internal.recipient_classification(${campaignId}::uuid) where reason is null`;
    if (n !== 5) throw new Error(`fixture: expected 5 recipients, the classification says ${n}`);
    const [send] = await sql<{ id: string }[]>`
      insert into public.sends (brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, body_sha256)
      select ${brandId}, ${campaignId}, 'confirmed', 'portal', 5, ${`ingestion-${tag}@vg-eval.test`}, now(),
             encode(sha256(convert_to(string_agg(r.external_id, E'\n' order by r.contact_id), 'UTF8')), 'hex')
        from internal.recipient_classification(${campaignId}::uuid) r where r.reason is null
      returning id`;
    sendId = send.id;
    await sql`
      insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
      select ${sendId}, ${brandId}, r.contact_id, r.external_id, r.address
        from internal.recipient_classification(${campaignId}::uuid) r where r.reason is null`;

    // the dispatch outcome, recorded as the Edge Function would (0008): lease → batch B-ING-<n>, all five accepted
    batchId = `B-ING-${tag}`;
    const leased = await sql`select id from public.dispatch_take_lease(${sendId}::uuid)`;
    if (leased.length !== 1) throw new Error("fixture: dispatch_take_lease returned no row");
    const recorded = await sql<{ status: string; batch_id: string; accepted_count: number }[]>`
      select status::text as status, batch_id, accepted_count from public.dispatch_record_result(${sendId}::uuid, ${batchId}, ${contactExternalIds}::text[], 0)`;
    if (recorded.length !== 1 || recorded[0].status !== "reporting" || recorded[0].accepted_count !== 5) throw new Error(`fixture: dispatch_record_result → ${JSON.stringify(recorded)}`);
  }, 200_000);

  afterAll(async () => {
    try {
      await mock("/__mock/config", { events_status: null, events_fail_next: 0, events_retry_after: 1, events_malformed_next: 0, events_null_cursor: false }).catch(() => undefined);
      if (!sql) return;
      try {
        if (sendId) {
          await sql`delete from public.events where send_id = ${sendId}`;
          await sql`delete from public.sends where id = ${sendId}`; // cascade: send_recipients + provider_batches
        }
        if (contactIds.length > 0) await sql`delete from public.contacts where id = any(${contactIds}::uuid[])`;
        if (campaignId) await sql`delete from public.campaigns where id = ${campaignId}`;
        if (brandId) await sql`delete from public.brands where id = ${brandId}`;
      } finally {
        await sql.end({ timeout: 5 });
      }
    } finally {
      releaseLock?.();
    }
  });

  let messy: Snapshot;

  it("guards: no secret → 401, a wrong secret → 401, a bad body → 400, a row that is not `requested` → 409 — nothing runs", async () => {
    const id = await requestPollLog();
    expect((await poll(id, {})).status).toBe(401);
    expect((await poll(id, { "x-cron-secret": "wrong" })).status).toBe(401);
    const bad = await fetch(FUNCTIONS_URL, { method: "POST", headers: { "Content-Type": "application/json", apikey: stack!.key, "x-cron-secret": cronSecret! }, body: "{" });
    expect(bad.status).toBe(400);
    // 6.3 review [L]: a JSON null / array / primitive body and coercible ids are 400 invalid_input, never a 500
    for (const body of ["null", "[]", "42", '"x"', JSON.stringify({ poll_log_id: String(id), window_hours: 48 }), JSON.stringify({ poll_log_id: id, window_hours: "1e3" }), JSON.stringify({ poll_log_id: true, window_hours: 48 })]) {
      const res = await fetch(FUNCTIONS_URL, { method: "POST", headers: { "Content-Type": "application/json", apikey: stack!.key, "x-cron-secret": cronSecret! }, body });
      expect(res.status, body).toBe(400);
      expect(((await res.json()) as { code?: string }).code, body).toBe("invalid_input");
    }
    const [row] = await sql<{ status: string }[]>`select status::text as status from internal.poll_log where id = ${id}`;
    expect(row.status).toBe("requested"); // untouched by the refused calls
    await sql`update internal.poll_log set status = 'ok', finished_at = now() where id = ${id}`;
    const again = await poll(id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("poll_not_requested");
    expect(await mockReads()).toHaveLength(0);
  });

  it("run 1 (shuffled, duplicated across pages of 4, 6 of 12 released): the first half lands, the cursor is kept, the stream stays open", async () => {
    await program({ page_size: 4, shuffle: true, duplicate_across_pages: true, released: 6 });
    const { res, log } = await run();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", batches: 1 });
    expect(log.status).toBe("ok");
    expect(log.finished_at).toBeTruthy();
    expect(log.error).toBeNull();
    expect(log.batches).toBe(1);
    // 4 + 2 released; the duplicated page overlap is absorbed by the (batch_id, event_id) dedupe
    expect(log.inserted).toBe(6);
    expect(log.duplicates).toBeGreaterThanOrEqual(1);
    const [batch] = await sql<{ next_cursor: string | null; last_event_id: string | null; last_ok_at: string | null; last_polled_at: string | null }[]>`select next_cursor, last_event_id, last_ok_at, last_polled_at from public.provider_batches where send_id = ${sendId}`;
    expect(batch.next_cursor).toBeTruthy();
    expect(batch.last_event_id).toMatch(new RegExp(`^${batchId}-ev-\\d+$`)); // positional last item of the last page, never max()
    expect(batch.last_ok_at).toBeTruthy();
    expect(batch.last_polled_at).toBeTruthy();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.events where send_id = ${sendId}`;
    expect(n).toBe(6);
    // the reads: first without `since`, then with the mock's opaque cursor — never an event id (probe row b)
    const reads = await mockReads();
    expect(reads[0]).toMatchObject({ batch_id: batchId, since: null, status: 200 });
    for (const r of reads.slice(1)) {
      expect(r.since).toBeTruthy();
      expect(r.since).not.toMatch(/-ev-/);
    }
    // the poller stopped on the open-but-empty page / unchanged cursor, not on has_more (which is still true)
    expect(reads[reads.length - 1]).toMatchObject({ has_more: true });
  });

  it("run 2 (all 12 released): the second half lands through the kept cursor; the stream closes and the last non-null cursor survives", async () => {
    await program({ page_size: 4, shuffle: true, duplicate_across_pages: true, released: 12 });
    const before = (await mockReads()).length;
    const { res, log } = await run();
    expect(res.body.status).toBe("ok");
    expect(log.status).toBe("ok");
    expect(log.inserted).toBe(6);
    const reads = (await mockReads()).slice(before);
    expect(reads[0].since).toBeTruthy(); // resumed from the stored cursor, not from the top
    expect(reads[reads.length - 1]).toMatchObject({ has_more: false });
    const [batch] = await sql<{ next_cursor: string | null }[]>`select next_cursor from public.provider_batches where send_id = ${sendId}`;
    expect(batch.next_cursor).toBeTruthy(); // a null on the final page never wipes the cursor (probe row c)
    messy = await snapshot();
    expect(messy.events).toHaveLength(12);
  });

  it("run 3 changes nothing: ok, inserted = 0 (the late-items re-read is all duplicates)", async () => {
    const { res, log } = await run();
    expect(res.body).toMatchObject({ status: "ok", inserted: 0 });
    expect(log.status).toBe("ok");
    expect(log.inserted).toBe(0);
    expect(log.duplicates).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(messy);
  });

  it("the messy two-run result equals a clean single-run ingest: events, suppressed_at, v_campaign_performance", async () => {
    await resetWorld();
    await program({ page_size: 4, shuffle: false, duplicate_across_pages: false, released: 12 });
    const { log } = await run();
    expect(log.status).toBe("ok");
    expect(log.inserted).toBe(12);
    expect(log.duplicates).toBe(0);
    const clean = await snapshot();
    expect(clean.events).toHaveLength(12);
    expect(messy).toEqual(clean);

    // and the picture is the right one: c2 / c4 bounced, c5 unsubscribed (suppressed at the event's time), c1 / c3 untouched
    const byExternal = new Map(contactExternalIds.map((ext, i) => [ext, (clean.contacts as Array<{ id: string; suppressed_at: Date | null; suppressed_reason: string | null }>).find((c) => c.id === contactIds[i])!]));
    expect(byExternal.get(contactExternalIds[0])?.suppressed_at).toBeNull();
    expect(byExternal.get(contactExternalIds[1])?.suppressed_reason).toBe("bounced");
    expect(byExternal.get(contactExternalIds[2])?.suppressed_at).toBeNull();
    expect(byExternal.get(contactExternalIds[3])?.suppressed_reason).toBe("bounced");
    expect(byExternal.get(contactExternalIds[4])?.suppressed_reason).toBe("unsubscribed");
    expect(new Date(byExternal.get(contactExternalIds[4])!.suppressed_at!).toISOString()).toBe(at(9));
    expect(clean.performance).toHaveLength(1);
    expect(clean.performance[0]).toMatchObject({ source: "portal", send_id: sendId, sent: 5, delivered: 5, bounced: 2, opens: 3, clicks: 0 });
    expect(Number((clean.performance[0] as { unsubscribes: string }).unsubscribes)).toBe(1); // bigint → string over the wire (6.2 kept 3.1's column type)
    expect(Number((clean.performance[0] as { delivered_rate: string }).delivered_rate)).toBe(100);
    expect(Number((clean.performance[0] as { bounce_rate: string }).bounce_rate)).toBe(40);
    expect(Number((clean.performance[0] as { open_rate: string }).open_rate)).toBe(60);
    expect(Number((clean.performance[0] as { unsubscribe_rate: string }).unsubscribe_rate)).toBe(20);
    const types = (clean.events as Array<{ type: string }>).map((e) => e.type).sort();
    expect(types.filter((t) => t === "unknown")).toHaveLength(1);

    // the brand's "reports last synced" is the batch's last_ok_at (the view; RLS scopes it per brand in the portal)
    const [sync] = await sql<{ last_ok_at: string | null }[]>`select last_ok_at from public.v_last_sync where brand_id = ${brandId}`;
    expect(sync?.last_ok_at).toBeTruthy();
    const [{ last_ok_at: batchOk }] = await sql<{ last_ok_at: string }[]>`select last_ok_at from public.provider_batches where send_id = ${sendId}`;
    expect(new Date(sync.last_ok_at!).getTime()).toBe(new Date(batchOk).getTime());
    const [status] = await sql<{ status: string }[]>`select status from public.last_poll_status()`;
    expect(status?.status).toBe("ok");
  });

  it("a 503 with a short Retry-After is waited out inside the run (ok); a long one ends the run as `deferred`, and the next run is `ok` — nothing is lost either way", async () => {
    await resetWorld();
    await program({ page_size: 4, shuffle: true, duplicate_across_pages: true, released: 12 });
    // one 503 (Retry-After: 1) then the stream: the poller waits and continues — ~30 % of the real provider's reads are 503s
    await mock("/__mock/config", { events_status: 503, events_fail_next: 1, events_retry_after: 1 });
    const before = (await mockReads()).length;
    const first = await run();
    expect(first.log.status).toBe("ok");
    expect(first.log.inserted).toBe(12);
    const reads = (await mockReads()).slice(before);
    expect(reads[0]).toMatchObject({ status: 503 });
    expect(reads[1]).toMatchObject({ status: 200, since: reads[0].since }); // the same page again after the wait

    // a 503 the run cannot wait out (Retry-After: 30 s > the 10-s cap) → deferred, cursor untouched, then ok
    await resetWorld();
    await mock("/__mock/config", { events_status: 503, events_fail_next: 1, events_retry_after: 30 });
    const deferred = await run();
    expect(deferred.res.body.status).toBe("deferred");
    expect(deferred.log.status).toBe("deferred");
    expect(deferred.log.error).toContain(`deferred:${batchId}`);
    expect(deferred.log.inserted).toBe(0);
    expect(deferred.log.finished_at).toBeTruthy();
    const [batch] = await sql<{ next_cursor: string | null; last_ok_at: string | null; last_polled_at: string | null }[]>`select next_cursor, last_ok_at, last_polled_at from public.provider_batches where send_id = ${sendId}`;
    expect(batch.next_cursor).toBeNull();
    expect(batch.last_ok_at).toBeNull();
    expect(batch.last_polled_at).toBeNull(); // untouched on purpose: the deferred batch heads the next run
    expect(deferred.log.batches).toBe(1); // the batch was attempted, the run went on (only a 401 aborts it)
    const ok = await run();
    expect(ok.log.status).toBe("ok");
    expect(ok.log.inserted).toBe(12);
    expect(await snapshot()).toEqual(messy);
  });

  it("429: a short Retry-After is waited out (ok); a long one leaves THIS batch rate_limited and the run goes on — cursor and last_polled_at untouched", async () => {
    await resetWorld();
    await program({ page_size: 4, shuffle: false, duplicate_across_pages: false, released: 12 });
    await mock("/__mock/config", { events_status: 429, events_fail_next: 1, events_retry_after: 1 });
    const before = (await mockReads()).length;
    const short = await run();
    expect(short.log.status).toBe("ok");
    expect(short.log.inserted).toBe(12);
    const reads = (await mockReads()).slice(before);
    expect(reads[0]).toMatchObject({ status: 429 });
    expect(reads[1]).toMatchObject({ status: 200, since: reads[0].since });

    await resetWorld();
    await mock("/__mock/config", { events_status: 429, events_fail_next: 1, events_retry_after: 11 });
    const long = await run();
    expect(long.res.body.status).toBe("rate_limited");
    expect(long.log.status).toBe("rate_limited");
    expect(long.log.error).toBe(`rate_limited:${batchId}:retry_after_11s`);
    expect(long.log.batches).toBe(1);
    expect(long.log.inserted).toBe(0);
    const [batch] = await sql<{ next_cursor: string | null; last_ok_at: string | null; last_polled_at: string | null }[]>`select next_cursor, last_ok_at, last_polled_at from public.provider_batches where send_id = ${sendId}`;
    expect(batch).toEqual({ next_cursor: null, last_ok_at: null, last_polled_at: null });
    const ok = await run();
    expect(ok.log.status).toBe("ok");
    expect(ok.log.inserted).toBe(12);
  });

  it("the page cap: an endless stream (a fresh cursor and one event per page, has_more forever) stops after 10 pages — ok, pages = 10", async () => {
    await resetWorld();
    await program({ endless: true, shuffle: false, duplicate_across_pages: false });
    const before = (await mockReads()).length;
    const { res, log } = await run();
    expect(res.body).toMatchObject({ status: "ok", batches: 1, pages: 10 });
    expect(log.pages).toBe(10);
    expect(log.inserted).toBe(10); // ten distinct events, one per page
    const reads = (await mockReads()).slice(before);
    expect(reads).toHaveLength(10);
    expect(reads.every((r) => r.status === 200 && r.has_more === true)).toBe(true);
    const [batch] = await sql<{ next_cursor: string | null }[]>`select next_cursor from public.provider_batches where send_id = ${sendId}`;
    expect(batch.next_cursor).toBeTruthy(); // the last page's cursor is kept: the next run resumes there
    await program({ page_size: 4, shuffle: false, duplicate_across_pages: false, released: 12 }); // back to a closing stream
  });

  it("has_more = true with next_cursor = null → cursor_contract_violation: the page is ingested, provider_error for the batch, cursor columns and last_ok_at untouched, last_polled_at bumped", async () => {
    await resetWorld();
    await program({ page_size: 4, shuffle: false, duplicate_across_pages: false, released: 12 });
    await mock("/__mock/config", { events_null_cursor: true });
    const { res, log } = await run();
    await mock("/__mock/config", { events_null_cursor: false });
    expect(res.body.status).toBe("provider_error");
    expect(log.status).toBe("provider_error");
    expect(log.error).toBe(`cursor_contract_violation:${batchId}`);
    expect(log.pages).toBe(1);
    expect(log.inserted).toBe(4); // the first page landed before the violation was seen
    const [batch] = await sql<{ next_cursor: string | null; last_event_id: string | null; last_ok_at: string | null; last_polled_at: string | null }[]>`select next_cursor, last_event_id, last_ok_at, last_polled_at from public.provider_batches where send_id = ${sendId}`;
    expect(batch.next_cursor).toBeNull();
    expect(batch.last_event_id).toBeNull();
    expect(batch.last_ok_at).toBeNull(); // "reports last synced" must not advance on a run the page calls failed
    expect(batch.last_polled_at).toBeTruthy(); // but it counted as a poll (round-robin)
    const ok = await run();
    expect(ok.log.status).toBe("ok");
    expect(ok.log.inserted).toBe(8);
  });

  it("a malformed 2xx (200, not JSON) → provider_error for the batch, nothing written but last_polled_at; the next run is ok", async () => {
    await resetWorld();
    await mock("/__mock/config", { events_malformed_next: 1 });
    const { log } = await run();
    expect(log.status).toBe("provider_error");
    expect(log.error).toMatch(new RegExp(`^provider_error:${batchId}:200`));
    expect(log.inserted).toBe(0);
    const [batch] = await sql<{ next_cursor: string | null; last_ok_at: string | null; last_polled_at: string | null }[]>`select next_cursor, last_ok_at, last_polled_at from public.provider_batches where send_id = ${sendId}`;
    expect(batch.next_cursor).toBeNull();
    expect(batch.last_ok_at).toBeNull();
    expect(batch.last_polled_at).toBeTruthy();
    const ok = await run();
    expect(ok.log.status).toBe("ok");
    expect(ok.log.inserted).toBe(12);
  });

  it("an exception inside the batch (ingest raising) is caught per batch: provider_error for it, last_polled_at bumped outside the rolled-back transaction, the run finishes — never `failed`", async () => {
    await resetWorld();
    // a fault only this send can hit: a BEFORE INSERT trigger on events that raises for its send_id (dropped in finally)
    await sql.unsafe(`create or replace function public.tmp_ing_poison_${tag}() returns trigger language plpgsql as $$ begin raise exception 'poisoned page'; end $$`);
    await sql.unsafe(`create trigger tmp_ing_poison_${tag} before insert on public.events for each row when (new.send_id = '${sendId}'::uuid) execute function public.tmp_ing_poison_${tag}()`);
    try {
      const { res, log } = await run();
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("provider_error");
      expect(log.status).toBe("provider_error");
      expect(log.error).toContain(`provider_error:${batchId}:PostgresError: poisoned page`);
      expect(log.finished_at).toBeTruthy();
      expect(log.batches).toBe(1);
      expect(log.inserted).toBe(0);
      const [batch] = await sql<{ next_cursor: string | null; last_ok_at: string | null; last_polled_at: string | null }[]>`select next_cursor, last_ok_at, last_polled_at from public.provider_batches where send_id = ${sendId}`;
      expect(batch.next_cursor).toBeNull();
      expect(batch.last_ok_at).toBeNull();
      expect(batch.last_polled_at).toBeTruthy(); // bumped outside the transaction: the batch does not head every run
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.events where send_id = ${sendId}`;
      expect(n).toBe(0);
    } finally {
      await sql.unsafe(`drop trigger if exists tmp_ing_poison_${tag} on public.events`);
      await sql.unsafe(`drop function if exists public.tmp_ing_poison_${tag}()`);
    }
    const ok = await run();
    expect(ok.log.status).toBe("ok");
    expect(ok.log.inserted).toBe(12);
  });

  it("two concurrent runs: the second skips the batch the first holds (batches 0, ok); both finish; nothing is ingested twice", async () => {
    await resetWorld();
    // the first run sleeps 3 s on a 503 while holding the batch's advisory lock; the second arrives 500 ms later
    await mock("/__mock/config", { events_status: 503, events_fail_next: 1, events_retry_after: 3 });
    const idA = await requestPollLog();
    const idB = await requestPollLog();
    const a = poll(idA);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const b = poll(idB);
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect([resA.body.batches, resB.body.batches].sort()).toEqual([0, 1]);
    expect([resA.body.status, resB.body.status]).toEqual(["ok", "ok"]);
    const logs = await sql<PollLogRow[]>`select id, status::text as status, finished_at, batches, pages, inserted, duplicates, error from internal.poll_log where id in (${idA}, ${idB}) order by id`;
    expect(logs.every((l) => l.status === "ok" && l.finished_at !== null)).toBe(true);
    expect(logs.map((l) => l.inserted).sort()).toEqual([0, 12]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.events where send_id = ${sendId}`;
    expect(n).toBe(12);
  });

  it("finish() is compare-and-set: a row poll-log-reconcile closed as failed / no_response while the run was still going keeps that verdict", async () => {
    await resetWorld();
    await mock("/__mock/config", { events_status: 503, events_fail_next: 1, events_retry_after: 3 });
    const id = await requestPollLog();
    const running = poll(id);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const [claimed] = await sql<{ status: string }[]>`select status::text as status from internal.poll_log where id = ${id}`;
    expect(claimed.status).toBe("running");
    await sql`update internal.poll_log set status = 'failed', finished_at = now(), error = 'no_response' where id = ${id}`; // the reconcile job's verdict
    const res = await running;
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok"); // the function's own result is still reported to pg_net
    const [log] = await sql<PollLogRow[]>`select id, status::text as status, finished_at, batches, pages, inserted, duplicates, error from internal.poll_log where id = ${id}`;
    expect(log.status).toBe("failed");
    expect(log.error).toBe("no_response"); // not overwritten
    expect(log.batches).toBeNull();
    // the ingest itself happened: the batch landed, and the next run is a clean ok / 0
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.events where send_id = ${sendId}`;
    expect(n).toBe(12);
    const again = await run();
    expect(again.log.status).toBe("ok");
    expect(again.log.inserted).toBe(0);
  });

  it("401 → auth_error (run aborted), 404 → provider_error (batch skipped, run continues); neither touches the cursor", async () => {
    const [before] = await sql<{ next_cursor: string | null; last_ok_at: string | null }[]>`select next_cursor, last_ok_at from public.provider_batches where send_id = ${sendId}`;
    await mock("/__mock/config", { events_status: 401, events_fail_next: 1 });
    const auth = await run();
    expect(auth.log.status).toBe("auth_error");
    expect(auth.log.error).toBe("auth_error");
    await mock("/__mock/config", { events_status: 404, events_fail_next: 1 });
    const notFound = await run();
    expect(notFound.log.status).toBe("provider_error");
    expect(notFound.log.error).toContain(`provider_error:${batchId}:404`);
    expect(notFound.log.batches).toBe(1);
    const [after] = await sql<{ next_cursor: string | null; last_ok_at: string | null }[]>`select next_cursor, last_ok_at from public.provider_batches where send_id = ${sendId}`;
    expect(after).toEqual(before);
    // every run ends with complete_sends() and a finished row, whatever the provider did
    for (const r of [auth, notFound]) expect(r.log.finished_at).toBeTruthy();
    const okAgain = await run();
    expect(okAgain.log.status).toBe("ok");
  });

  it("a batch outside the window is not polled; a batch of a `partial` send still is", async () => {
    await sql`update public.sends set dispatched_at = now() - interval '3 days' where id = ${sendId}`;
    const before = (await mockReads()).length;
    const narrow = await requestPollLog();
    const res = await poll(narrow, { "x-cron-secret": cronSecret! }, 48);
    expect(res.body).toMatchObject({ status: "ok", batches: 0 });
    expect((await mockReads()).length).toBe(before);
    const wide = await requestPollLog();
    const res2 = await poll(wide, { "x-cron-secret": cronSecret! }, 168);
    expect(res2.body).toMatchObject({ status: "ok", batches: 1 });
    await sql`update public.sends set dispatched_at = now(), status = 'partial' where id = ${sendId}`;
    const partial = await run();
    expect(partial.res.body).toMatchObject({ status: "ok", batches: 1 });
    await sql`update public.sends set status = 'reporting' where id = ${sendId}`;
  });
});

if (!configured) {
  it.todo(`ingestion test is configured (${missing.join(", ")}) — SKIPPED, not passed`);
}
