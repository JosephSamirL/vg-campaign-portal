/**
 * poll-events — fetch delivery reports for every recent provider batch and ingest them (Story 6.3; architecture
 * D-7, D-8, D-14; docs/provider-api.md `## Probe 2026-09-15` rows b, c, c2, e — which override D-8's cursor
 * fallback wherever they differ).
 *
 * Called by pg_cron through pg_net (0013_cron_poll.sql: `internal.request_poll(window_hours)` inserts the
 * `internal.poll_log` row as `requested`, then POSTs `{ poll_log_id, window_hours }` here with `x-cron-secret`).
 * `verify_jwt = false` (config.toml): the secret IS the authentication; anything else → 401 { code, message }.
 *
 * The run:
 *   running    update internal.poll_log set status = 'running' where id = $1 and status = 'requested' (CAS: a
 *              re-delivered request for a row that already ran answers 409 and does nothing)
 *   batches    provider_batches ⋈ sends where batch_id is not null and dispatched_at is inside the window,
 *              REGARDLESS of sends.status (a `partial` send still gets reports), oldest-polled first
 *              (`last_polled_at asc nulls first`); no new batch starts after 50 s (pg_net's timeout is 60 s)
 *   per batch  ONE transaction on a direct Postgres connection (_shared/db.ts): pg_try_advisory_xact_lock(
 *              hashtext(batch_id)) — false → skip (another run holds it); then ≤ 10 pages, each page re-checking
 *              the 50-s deadline first (10 pages × 20-s timeouts must never outlive pg_net's 60 s):
 *                since  = the stored next_cursor, or omitted — NEVER an event id (probe b: the real provider
 *                         ignores one and replays the whole stream; ingest's (batch_id, event_id) dedupe absorbs it)
 *                2xx    internal.ingest_provider_events(send_id, batch_id, events) → inserted / duplicates, then the
 *                         cursor COMPARE-AND-SET on the value read before the page (`next_cursor is not distinct
 *                         from $expected`; 0 rows → stop this batch); the last NON-NULL cursor is kept even when the
 *                         final page comes back `next_cursor = null` (probe c: a stale cursor still returns late
 *                         items, and a batch keeps being polled for the rest of the window)
 *                stop   on an empty page, `next_cursor = null`, an unchanged cursor, `has_more = false`, or the page
 *                         cap — never on `has_more` alone (an open stream with nothing new is normal)
 *                has_more = true with next_cursor = null → `cursor_contract_violation:<batch_id>`, stop the batch
 *                401    auth_error — abort the run (the key is wrong for every batch)
 *                429 / 503  honour Retry-After (header → body `retry_after` → 5 s): ≤ 10 s and inside the budget →
 *                         wait and retry the same page; otherwise this BATCH is `rate_limited` (429) / `deferred`
 *                         (503) and the run continues with the next batch (probe e: isolated 16–18 s 503s on ~30 %
 *                         of reads are "not an error"; a whole run must not stop on one of them). Its last_polled_at
 *                         is left untouched so it heads the next run.
 *                404 / other 4xx / 5xx / timeout / unreadable body → `provider_error` for this batch, next batch
 *                any exception inside the batch (ingest raising, a deadlock, a statement timeout) → the transaction
 *                         rolls back, `provider_error:<batch_id>:<message>`, last_polled_at bumped OUTSIDE the
 *                         rolled-back transaction, next batch — a batch that keeps failing never wedges the run
 *              Error paths never write next_cursor / last_event_id. last_polled_at is bumped after a provider_error
 *              or an ingested page (round-robin: a batch that keeps failing cannot starve the others) and left alone
 *              on 401 / un-waitable 429 / 503 (the batch is retried first); last_ok_at moves only after an ingested
 *              page — a `cursor_contract_violation` bumps last_polled_at only.
 *   end        ALWAYS: internal.complete_sends() (reporting → complete 24 h after dispatch), then poll_log(status,
 *              finished_at, batches, pages, inserted, duplicates, error) — compare-and-set on status = 'running',
 *              so a row poll-log-reconcile already closed as failed / no_response is never overwritten. Status
 *              precedence: auth_error > provider_error > rate_limited > deferred > ok; an uncaught exception → failed.
 *   response   200 { status, batches, pages, inserted, duplicates } — the run is recorded whatever it found.
 *   logs       one JSON line per step: { fn: 'poll-events', poll_log_id, batch_id, step, ok, ms, … }.
 */
import { dbClient, missingDbEnv, type Sql } from "../_shared/db.ts";
import { logStep, stopwatch } from "../_shared/log.ts";
import { getEvents, missingProviderEnv } from "../_shared/provider.ts";

const FN = "poll-events";
const RUN_BUDGET_MS = 50_000;
const MAX_PAGES_PER_BATCH = 10;
const MAX_WAIT_S = 10;
const MAX_WINDOW_HOURS = 24 * 30;
const ERROR_TEXT_MAX = 1000;

type RunStatus = "ok" | "auth_error" | "provider_error" | "rate_limited" | "deferred";
/** Higher wins when the run's batches disagree. */
const STATUS_RANK: Record<RunStatus, number> = { ok: 0, deferred: 1, rate_limited: 2, provider_error: 3, auth_error: 4 };

type BatchRow = { send_id: string; batch_id: string };
type CursorRow = { next_cursor: string | null; last_event_id: string | null };
type IngestRow = { inserted: number; duplicates: number; foreign_recipient: number; unknown_type: number; last_event_id: string | null };

type Totals = { batches: number; skipped: number; pages: number; inserted: number; duplicates: number; foreign: number; unknown: number; errors: string[]; status: RunStatus };

/** `skipTouch`: leave last_polled_at alone (an un-waitable 429 / 503 — the batch should head the next run). */
type BatchOutcome = { status: RunStatus; abortRun: boolean; skipTouch?: boolean; error?: string };

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fail(status: number, code: string, message: string): Response {
  return json(status, { code, message });
}

/** Constant-time-ish comparison for the cron secret (lengths differ → false without leaking where). */
function secretEquals(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function worse(a: RunStatus, b: RunStatus): RunStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One batch, one transaction: the advisory lock, the page loop with the compare-and-set cursor, the timestamps.
 * Returns the batch's status contribution and whether the run must stop (401 / 429 / 503 that cannot be waited out).
 */
async function pollBatch(sql: Sql, pollLogId: number, batch: BatchRow, deadline: number, totals: Totals): Promise<BatchOutcome> {
  const { send_id: sendId, batch_id: batchId } = batch;
  const log = (step: string, ok: boolean, ms: number, extra: Record<string, unknown> = {}) =>
    logStep({ fn: FN, send_id: sendId, poll_log_id: pollLogId, batch_id: batchId, step, ok, ms, ...extra });

  return await sql.begin(async (tx): Promise<BatchOutcome> => {
    let t = stopwatch();
    const [{ locked }] = await tx<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${batchId})) as locked`;
    if (!locked) {
      log("lock", false, t(), { reason: "held_elsewhere" });
      totals.skipped += 1;
      return { status: "ok", abortRun: false };
    }
    totals.batches += 1;

    const [cursorRow] = await tx<CursorRow[]>`select next_cursor, last_event_id from public.provider_batches where send_id = ${sendId}`;
    let expected: string | null = cursorRow?.next_cursor ?? null;
    log("lock", true, t(), { cursor: expected !== null });

    let outcome: BatchOutcome = { status: "ok", abortRun: false };
    let touched = false; // an ingested page moved last_ok_at (and last_polled_at) already

    for (let page = 1; page <= MAX_PAGES_PER_BATCH; page++) {
      if (Date.now() >= deadline) {
        // the run budget applies per page too: ten 20-s timeouts inside one transaction would outlive pg_net's 60 s
        log("budget", false, 0, { page, outcome: "deadline" });
        break;
      }
      // probe row b: `since` carries the stored next_cursor only; a batch with none omits it (never an event id)
      t = stopwatch();
      const result = await getEvents(batchId, expected);
      const ms = t();

      if (result.status === 401) {
        log("get", false, ms, { page, status: 401, outcome: "auth_error" });
        outcome = { status: "auth_error", abortRun: true, error: "auth_error" };
        break;
      }

      if (result.status === 429 || result.status === 503) {
        const wait = Math.max(1, result.retryAfter ?? 5); // never a zero wait: a `Retry-After: 0` must not spin
        const kind: RunStatus = result.status === 429 ? "rate_limited" : "deferred";
        if (wait <= MAX_WAIT_S && Date.now() + wait * 1000 < deadline) {
          log("get", false, ms, { page, status: result.status, retry_after_s: wait, outcome: "wait" });
          await sleep(wait * 1000);
          page -= 1; // the same page again — a wait is not a page
          continue;
        }
        // un-waitable: this batch is deferred / rate-limited, the run goes on (only a 401 aborts the run);
        // last_polled_at stays untouched so the batch is first next time
        log("get", false, ms, { page, status: result.status, retry_after_s: wait, outcome: kind });
        outcome = { status: kind, abortRun: false, skipTouch: true, error: `${kind}:${batchId}:retry_after_${wait}s` };
        break;
      }

      if (!result.body) {
        // 404 (unknown batch), other 4xx / 5xx, timeout, network, unreadable or malformed 2xx body
        const detail = result.status === 0 ? (result.error ?? "no_response") : `${result.status}${result.error ? `:${result.error}` : ""}`;
        log("get", false, ms, { page, status: result.status, outcome: "provider_error", error: result.error, body: result.text });
        outcome = { status: "provider_error", abortRun: false, error: `provider_error:${batchId}:${detail}` };
        break;
      }

      const { events, next_cursor: nextCursor, has_more: hasMore } = result.body;
      log("get", true, ms, { page, status: result.status, events: events.length, has_more: hasMore, cursor_changed: nextCursor !== null && nextCursor !== expected });

      // ingest the page (dedupe on (batch_id, event_id), foreign recipients dropped — 6.2), even an empty one is harmless
      t = stopwatch();
      // the `::jsonb` cast makes postgres.js serialise the array itself (a pre-stringified value would arrive double-encoded)
      const [ingested] = await tx<IngestRow[]>`select * from internal.ingest_provider_events(${sendId}::uuid, ${batchId}, ${events as unknown as string}::jsonb)`;
      totals.pages += 1;
      totals.inserted += ingested?.inserted ?? 0;
      totals.duplicates += ingested?.duplicates ?? 0;
      totals.foreign += ingested?.foreign_recipient ?? 0;
      totals.unknown += ingested?.unknown_type ?? 0;
      log("ingest", true, t(), { page, inserted: ingested?.inserted ?? 0, duplicates: ingested?.duplicates ?? 0, foreign_recipient: ingested?.foreign_recipient ?? 0, unknown_type: ingested?.unknown_type ?? 0 });

      if (hasMore && nextCursor === null) {
        // D-8: unobserved on the real provider, kept — the page was ingested, the cursor columns stay untouched;
        // last_polled_at only: the batch is recorded provider_error, so "reports last synced" must not advance
        t = stopwatch();
        await tx`update public.provider_batches set last_polled_at = now() where send_id = ${sendId}`;
        touched = true;
        log("cursor", false, t(), { page, outcome: "cursor_contract_violation" });
        outcome = { status: "provider_error", abortRun: false, error: `cursor_contract_violation:${batchId}` };
        break;
      }

      // probe row c: keep the last NON-NULL cursor — a null on the final page never wipes it
      const newCursor = nextCursor ?? expected;
      t = stopwatch();
      const cas = await tx<{ send_id: string }[]>`
        update public.provider_batches
           set next_cursor = ${newCursor},
               last_event_id = coalesce(${ingested?.last_event_id ?? null}, last_event_id),
               last_polled_at = now(),
               last_ok_at = now()
         where send_id = ${sendId}
           and next_cursor is not distinct from ${expected}
         returning send_id`;
      touched = true;
      if (cas.length === 0) {
        log("cursor", false, t(), { page, outcome: "cas_miss" });
        break; // someone else moved the cursor under us: stop this batch, nothing is lost (the next run re-reads it)
      }
      log("cursor", true, t(), { page, cursor_changed: newCursor !== expected });

      if (events.length === 0 || nextCursor === null || nextCursor === expected || !hasMore) break;
      expected = nextCursor;
    }

    if (!touched && !outcome.abortRun && !outcome.skipTouch) {
      // a failed attempt still counts as a poll (round-robin), but never as a success
      await tx`update public.provider_batches set last_polled_at = now() where send_id = ${sendId}`;
    }
    return outcome;
  });
}

async function run(sql: Sql, pollLogId: number, windowHours: number): Promise<Totals> {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const totals: Totals = { batches: 0, skipped: 0, pages: 0, inserted: 0, duplicates: 0, foreign: 0, unknown: 0, errors: [], status: "ok" };

  let t = stopwatch();
  const batches = await sql<BatchRow[]>`
    select pb.send_id, pb.batch_id
      from public.provider_batches pb
      join public.sends s on s.id = pb.send_id
     where pb.batch_id is not null
       and s.dispatched_at > now() - make_interval(hours => ${windowHours})
     order by pb.last_polled_at asc nulls first, s.dispatched_at asc, pb.batch_id asc`;
  logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "batches", ok: true, ms: t(), count: batches.length, window_hours: windowHours });

  let stopped: string | null = null;
  for (const batch of batches) {
    if (Date.now() >= deadline) {
      stopped = "budget";
      break;
    }
    let outcome: BatchOutcome;
    try {
      outcome = await pollBatch(sql, pollLogId, batch, deadline, totals);
    } catch (error) {
      // the batch's transaction rolled back (ingest raised, deadlock, statement timeout, …): provider_error for this
      // batch, last_polled_at bumped outside the rolled-back transaction so it does not head every run, next batch
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      logStep({ fn: FN, send_id: batch.send_id, poll_log_id: pollLogId, batch_id: batch.batch_id, step: "batch", ok: false, ms: 0, error: message });
      try {
        await sql`update public.provider_batches set last_polled_at = now() where send_id = ${batch.send_id}`;
      } catch (touchError) {
        logStep({ fn: FN, send_id: batch.send_id, poll_log_id: pollLogId, batch_id: batch.batch_id, step: "touch", ok: false, ms: 0, error: touchError instanceof Error ? touchError.message : String(touchError) });
      }
      outcome = { status: "provider_error", abortRun: false, error: `provider_error:${batch.batch_id}:${message.slice(0, 200)}` };
    }
    totals.status = worse(totals.status, outcome.status);
    if (outcome.error) totals.errors.push(outcome.error);
    if (outcome.abortRun) {
      stopped = outcome.status;
      break;
    }
  }
  if (stopped) logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "stop", ok: stopped === "budget", ms: 0, reason: stopped, remaining: batches.length - totals.batches - totals.skipped });

  // every run ends here, whatever the provider did (D-8)
  t = stopwatch();
  const [{ completed }] = await sql<{ completed: number }[]>`select internal.complete_sends() as completed`;
  logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "complete_sends", ok: true, ms: t(), completed });
  return totals;
}

/**
 * Close the run's poll_log row — compare-and-set on `status = 'running'`: a run that outlived the 10-minute reconcile
 * window was already closed as failed / no_response and keeps that verdict (the row says what the operator saw).
 */
async function finish(sql: Sql, pollLogId: number, status: RunStatus | "failed", totals: Totals | null, error: string | null): Promise<boolean> {
  const text = error ? error.slice(0, ERROR_TEXT_MAX) : null;
  const rows = await sql<{ id: number }[]>`
    update internal.poll_log
       set status = ${status}::internal.poll_status,
           finished_at = now(),
           batches = ${totals?.batches ?? null},
           pages = ${totals?.pages ?? null},
           inserted = ${totals?.inserted ?? null},
           duplicates = ${totals?.duplicates ?? null},
           error = ${text}
     where id = ${pollLogId}
       and status = 'running'
     returning id`;
  if (rows.length === 0) logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "finish", ok: false, ms: 0, reason: "already_closed", status });
  return rows.length > 0;
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return fail(405, "invalid_input", "POST only");

  // auth — the cron secret only (D-7: the cron path signs with a shared secret, not a JWT)
  let t = stopwatch();
  const given = req.headers.get("x-cron-secret");
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  if (given === null || !expected || !secretEquals(given, expected)) {
    logStep({ fn: FN, send_id: null, step: "auth", ok: false, ms: t() });
    return fail(401, "unauthorized", "x-cron-secret required");
  }

  // input
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_input", "body must be JSON { poll_log_id, window_hours }");
  }
  // a plain object with two JSON numbers — `null`, an array, a primitive, `true` or "1e3" are all 400, never a 500
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "invalid_input", "body must be a JSON object { poll_log_id, window_hours }");
  const body = parsed as { poll_log_id?: unknown; window_hours?: unknown };
  const pollLogId = body.poll_log_id;
  const windowHours = body.window_hours;
  if (typeof pollLogId !== "number" || !Number.isInteger(pollLogId) || pollLogId <= 0) return fail(400, "invalid_input", "poll_log_id must be a positive integer");
  if (typeof windowHours !== "number" || !Number.isInteger(windowHours) || windowHours <= 0 || windowHours > MAX_WINDOW_HOURS) return fail(400, "invalid_input", `window_hours must be an integer in 1..${MAX_WINDOW_HOURS}`);
  logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "auth", ok: true, ms: t(), window_hours: windowHours });

  const unset = [...missingProviderEnv(), ...missingDbEnv()];
  if (unset.length > 0) {
    logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "config", ok: false, ms: 0, missing: unset });
    return fail(500, "misconfigured", `secrets not set: ${unset.join(", ")}`);
  }

  const sql = dbClient();
  try {
    // running — CAS from requested: a re-delivered request for a row that already ran does nothing
    t = stopwatch();
    const claimed = await sql<{ id: number }[]>`update internal.poll_log set status = 'running' where id = ${pollLogId} and status = 'requested' returning id`;
    if (claimed.length === 0) {
      logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "running", ok: false, ms: t(), reason: "not_requested" });
      return fail(409, "poll_not_requested", "poll_log row is not in status requested");
    }
    logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "running", ok: true, ms: t() });

    let totals: Totals | null = null;
    try {
      totals = await run(sql, pollLogId, windowHours);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "run", ok: false, ms: 0, error: message });
      try {
        await sql`select internal.complete_sends()`;
      } catch {
        // the run already failed; the poll_log row below is what matters
      }
      await finish(sql, pollLogId, "failed", null, `failed: ${message}`);
      return json(200, { status: "failed", batches: null, pages: null, inserted: null, duplicates: null });
    }

    const error = totals.errors.length > 0 ? totals.errors.join("; ") : null;
    t = stopwatch();
    await finish(sql, pollLogId, totals.status, totals, error);
    logStep({ fn: FN, send_id: null, poll_log_id: pollLogId, step: "finish", ok: totals.status === "ok", ms: t(), status: totals.status, batches: totals.batches, skipped: totals.skipped, pages: totals.pages, inserted: totals.inserted, duplicates: totals.duplicates, foreign_recipient: totals.foreign, unknown_type: totals.unknown, error });
    return json(200, { status: totals.status, batches: totals.batches, pages: totals.pages, inserted: totals.inserted, duplicates: totals.duplicates });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (error) {
    logStep({ fn: FN, send_id: null, step: "handle", ok: false, ms: 0, error: error instanceof Error ? error.message : String(error) });
    return fail(500, "internal", "unexpected error");
  }
});
