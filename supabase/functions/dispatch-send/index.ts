/**
 * dispatch-send — confirmed → dispatched (lease) → POST /v1/messages → reporting | partial | failed
 * (Story 4.3; architecture D-7, D-2, D-14; Step-3 amendments #4, #6, #12; Story-Time amendment S7).
 *
 * `verify_jwt = false` (config.toml): `sb_secret_` keys are not JWTs, so the platform check is off and THIS
 * function authenticates every caller itself, one of two ways:
 *   - `x-cron-secret: <CRON_SECRET>`   — the pg_cron sweep (0009_cron_dispatch.sql, via pg_net + Vault). The
 *                                        send is loaded through the service-role client.
 *   - `Authorization: Bearer <user jwt>` — the portal (Story 4.4's server action forwards the session). The
 *                                        send is loaded through a USER-SCOPED client: RLS proves the brand (no
 *                                        row → 404 not_in_brand) and `current_app_role()` must be `owner`
 *                                        (else 403 not_owner — an analyst can read the send but never dispatch
 *                                        it, S7). Anything else → 401.
 *
 * Then, always through the service-role client (the `dispatch_*` functions are granted to service_role only):
 *   1. pre-check   status in (confirmed, dispatched) and batch_id is null, else 200 { skipped, reason }
 *   2. lease       rpc dispatch_take_lease — the exact CAS UPDATE (10-min lease, attempts + 1, cap 3);
 *                  zero rows → 200 { skipped: true } (a concurrent invocation holds it, or the cap is reached)
 *   3. respond     202 { send_id, status: 'dispatched', dispatch_attempts } — the dialog does not wait for the
 *                  provider; the page polls sends.status (D-12)
 *   4. background  EdgeRuntime.waitUntil(run()):
 *        recipients  rpc dispatch_recipients (one jsonb row, ordered by contact_id)
 *        hash        sha256(external_ids joined by '\n') must equal sends.body_sha256 (4.2's digest) — a
 *                    mismatch means the snapshot is not what was confirmed: failed / body_hash_mismatch, no POST
 *        post        POST /v1/messages with Idempotency-Key `send-<send_id>` (derived, never random: a replay
 *                    after a crash is the same request) and a 60 s timeout
 *        outcome     2xx with a batch_id → dispatch_record_result (accepted ∩ recipients, rejected ∩ recipients,
 *                    reporting | partial, provider_batches)
 *                    2xx with no batch_id / an unreadable or non-JSON body → OUTCOME UNKNOWN: the provider may have
 *                    accepted the batch under this key, so the send stays `dispatched` (never `failed`); the next
 *                    attempt replays the same Idempotency-Key and reads the same batch_id (4.3 review [M])
 *                    4xx → dispatch_mark_failed (failure_reason = `provider_<status>: <first 120 chars, no newlines>`;
 *                    the raw body is in the log line only)
 *                    5xx / timeout / network → never re-POST in this invocation. While `DISPATCH_RETRY_ENABLED`
 *                    is not `on` (the sweep is disabled — D-7, Story 6.1 row a: it is enabled together with
 *                    the secret in Story 6.3) the outcome is unknown and stays unknown: dispatch_mark_partial
 *                    → `partial` with failure_reason `provider_<status>_outcome_unknown` /
 *                    `provider_unreachable_outcome_unknown`, accepted_count null (the portal reads "provider
 *                    outcome unknown"). With retries on, the send stays `dispatched` under its lease: the sweep
 *                    replays the same Idempotency-Key once the lease expires and caps at 3 attempts.
 *   Every transition is CAS on `status = 'dispatched' and batch_id is null` inside the SQL functions.
 *   One JSON log line per step: { fn, send_id, step, ok, ms }.
 *
 * The provider secrets are checked before the lease: a deploy without PROVIDER_BASE_URL / PROVIDER_API_KEY answers
 * `500 misconfigured` and never consumes one of the three attempts. The SQL side of the unknown-outcome paths
 * (`dispatch_mark_partial`, the sweep's cap reason and 24-h ceiling, the `batch_id` collision inside
 * `dispatch_record_result`) landed in `0012_events_ingest.sql` (Story 6.2).
 */
import { logStep, stopwatch } from "../_shared/log.ts";
import { failureReason, missingProviderEnv, postMessages, recipientId, type ProviderRecipientEcho, type Recipient } from "../_shared/provider.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

const FN = "dispatch-send";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_TIMEOUT_MS = 60_000;

/** Retries (the sweep replaying the same key) are opt-in per environment; unset or anything but `on` means off (D-7). */
function retryEnabled(): boolean {
  return Deno.env.get("DISPATCH_RETRY_ENABLED") === "on";
}

/** The stored reason for an unknown outcome: the code first (the portal renders the part before ':'), detail after. */
function unknownOutcomeReason(result: { kind: "server_error"; status: number } | { kind: "network_error"; error: string }): string {
  if (result.kind === "server_error") return `provider_${result.status}_outcome_unknown`;
  const flat = result.error.replace(/\s+/g, " ").trim().slice(0, 120);
  return flat ? `provider_unreachable_outcome_unknown: ${flat}` : "provider_unreachable_outcome_unknown";
}

type SendRow = {
  id: string;
  status: string;
  batch_id: string | null;
  recipient_count: number;
  body_sha256: string | null;
  dispatch_attempts: number;
  campaigns: { external_id: string } | null;
  brands: { code: string } | null;
};

type EdgeRuntimeLike = { waitUntil: (promise: Promise<unknown>) => void };

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fail(status: number, code: string, message: string): Response {
  return json(status, { code, message });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time-ish comparison for the cron secret (lengths differ → false without leaking where). */
function secretEquals(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const SEND_COLUMNS = "id, status, batch_id, recipient_count, body_sha256, dispatch_attempts, campaigns(external_id), brands(code)";

/** The provider's echo (`accepted` / `rejected`) normalised to ids and intersected with the snapshot: distinct ids the send actually carried. */
function snapshotIds(echo: ProviderRecipientEcho[], snapshot: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  for (const item of echo) {
    const id = recipientId(item);
    if (id !== null && snapshot.has(id)) seen.add(id);
  }
  return [...seen];
}

/** The background half: recipients → hash check → POST → outcome. Never throws out (the response is already sent). */
async function run(sendId: string, send: SendRow): Promise<void> {
  const service = serviceClient();

  // recipients — one jsonb row, ordered by contact_id (PostgREST max_rows would truncate a per-row result)
  let t = stopwatch();
  const { data: list, error: listError } = await service.rpc("dispatch_recipients", { p_send_id: sendId });
  if (listError || !Array.isArray(list)) {
    logStep({ fn: FN, send_id: sendId, step: "recipients", ok: false, ms: t(), error: listError?.message ?? "not an array" });
    return; // stays dispatched under the lease; the sweep retries
  }
  const recipients = (list as Recipient[]).filter((r) => r && typeof r.external_id === "string");
  logStep({ fn: FN, send_id: sendId, step: "recipients", ok: true, ms: t(), count: recipients.length });

  // hash — the canonical list is external_ids joined by '\n' in contact_id order (Story 4.2's string_agg)
  t = stopwatch();
  const digest = await sha256Hex(recipients.map((r) => r.external_id).join("\n"));
  const hashOk = recipients.length === send.recipient_count && !!send.body_sha256 && digest === send.body_sha256;
  logStep({ fn: FN, send_id: sendId, step: "hash", ok: hashOk, ms: t(), count: recipients.length, expected: send.recipient_count });
  if (!hashOk) {
    t = stopwatch();
    const { data, error } = await service.rpc("dispatch_mark_failed", { p_send_id: sendId, p_reason: "body_hash_mismatch" });
    logStep({ fn: FN, send_id: sendId, step: "mark_failed", ok: !error, ms: t(), reason: "body_hash_mismatch", rows: Array.isArray(data) ? data.length : 0, error: error?.message });
    return;
  }

  // post — Idempotency-Key derived from the send id (FR-18): a replay is the same request, delivered once
  t = stopwatch();
  const result = await postMessages(
    { campaign: send.campaigns?.external_id, brand: send.brands?.code, recipients },
    `send-${sendId}`,
    AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  );
  const postMs = t();

  if (result.kind === "ok") {
    const batchId = typeof result.body.batch_id === "string" && result.body.batch_id ? result.body.batch_id : null;
    const accepted = Array.isArray(result.body.accepted) ? result.body.accepted : [];
    const rejected = Array.isArray(result.body.rejected) ? result.body.rejected : [];
    if (!batchId) {
      // a 2xx without a batch_id is an UNKNOWN outcome, not a failure: the provider may have accepted the batch under
      // this key. Leave `dispatched`; the next attempt (lease expiry → Retry / sweep) replays the same Idempotency-Key.
      logStep({ fn: FN, send_id: sendId, step: "post", ok: false, ms: postMs, status: result.status, outcome: "outcome_unknown", reason: "no_batch_id", body: result.text.slice(0, 500), left: "dispatched" });
      return;
    }
    // both echoes normalised the same way and intersected with the snapshot, so accepted + rejected ≤ recipient_count
    const snapshot = new Set(recipients.map((r) => r.external_id));
    const acceptedIds = snapshotIds(accepted, snapshot);
    const rejectedIds = snapshotIds(rejected, snapshot);
    logStep({ fn: FN, send_id: sendId, step: "post", ok: true, ms: postMs, status: result.status, batch_id: batchId, accepted: acceptedIds.length, rejected: rejectedIds.length, echoed_accepted: accepted.length, echoed_rejected: rejected.length });
    t = stopwatch();
    const { data, error } = await service.rpc("dispatch_record_result", {
      p_send_id: sendId,
      p_batch_id: batchId,
      p_accepted_ids: acceptedIds,
      p_rejected_count: rejectedIds.length,
    });
    const row = Array.isArray(data) && data.length > 0 ? (data[0] as { status: string; accepted_count: number }) : null;
    logStep({ fn: FN, send_id: sendId, step: "record_result", ok: !error, ms: t(), rows: Array.isArray(data) ? data.length : 0, status: row?.status, accepted_count: row?.accepted_count, error: error?.message });
    return;
  }

  if (result.kind === "unreadable") {
    // the status line said 2xx but the body never arrived / was not JSON: same unknown outcome as above
    logStep({ fn: FN, send_id: sendId, step: "post", ok: false, ms: postMs, status: result.status, outcome: "outcome_unknown", reason: result.error, left: "dispatched" });
    return;
  }

  if (result.kind === "client_error") {
    // the raw body (which may echo recipient addresses) goes to the log only; the stored reason is sanitised
    logStep({ fn: FN, send_id: sendId, step: "post", ok: false, ms: postMs, status: result.status, body: result.text.slice(0, 500) });
    t = stopwatch();
    const { data, error } = await service.rpc("dispatch_mark_failed", { p_send_id: sendId, p_reason: failureReason(result.status, result.text) });
    logStep({ fn: FN, send_id: sendId, step: "mark_failed", ok: !error, ms: t(), reason: `provider_${result.status}`, rows: Array.isArray(data) ? data.length : 0, error: error?.message });
    return;
  }

  // 5xx / timeout / network: the outcome is unknown. Retries on → leave `dispatched` (the lease expires in 10 min and
  // the sweep replays the same key). Retries off (the default until Story 6.3 enables the sweep) → partial now, D-7.
  const retry = retryEnabled();
  logStep({
    fn: FN,
    send_id: sendId,
    step: "post",
    ok: false,
    ms: postMs,
    outcome: result.kind,
    status: result.kind === "server_error" ? result.status : undefined,
    error: result.kind === "network_error" ? result.error : undefined,
    retry_enabled: retry,
    left: retry ? "dispatched" : "partial",
  });
  if (retry) return;
  const reason = unknownOutcomeReason(result);
  t = stopwatch();
  const { data, error } = await service.rpc("dispatch_mark_partial", { p_send_id: sendId, p_reason: reason });
  logStep({ fn: FN, send_id: sendId, step: "mark_partial", ok: !error, ms: t(), reason: failureReasonPrefix(reason), rows: Array.isArray(data) ? data.length : 0, error: error?.message });
}

/** The code before ':' — what the portal shows (components/send/send-status.tsx does the same). */
function failureReasonPrefix(reason: string): string {
  const colon = reason.indexOf(":");
  return (colon === -1 ? reason : reason.slice(0, colon)).trim();
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return fail(405, "invalid_input", "POST only");

  // input
  let sendId: unknown;
  try {
    ({ send_id: sendId } = (await req.json()) as { send_id?: unknown });
  } catch {
    return fail(400, "invalid_input", "body must be JSON { send_id }");
  }
  if (typeof sendId !== "string" || !UUID.test(sendId)) return fail(400, "invalid_input", "send_id must be a uuid");

  // auth — cron secret, or a user JWT that resolves to an owner
  let t = stopwatch();
  const cronSecret = req.headers.get("x-cron-secret");
  const authorization = req.headers.get("authorization");
  let caller: "cron" | "user";
  let loader: ReturnType<typeof serviceClient>;
  if (cronSecret !== null) {
    const expected = Deno.env.get("CRON_SECRET") ?? "";
    if (!expected || !secretEquals(cronSecret, expected)) {
      logStep({ fn: FN, send_id: sendId, step: "auth", ok: false, ms: t(), caller: "cron" });
      return fail(401, "unauthorized", "bad cron secret");
    }
    caller = "cron";
    loader = serviceClient();
  } else if (authorization && /^bearer\s+\S+/i.test(authorization)) {
    const user = userClient(authorization);
    const { data: auth, error: authError } = await user.auth.getUser();
    if (authError || !auth?.user) {
      logStep({ fn: FN, send_id: sendId, step: "auth", ok: false, ms: t(), caller: "user", error: authError?.message ?? "no user" });
      return fail(401, "unauthorized", "invalid or expired session");
    }
    const { data: role, error: roleError } = await user.rpc("current_app_role");
    if (roleError || role !== "owner") {
      logStep({ fn: FN, send_id: sendId, step: "auth", ok: false, ms: t(), caller: "user", role: role ?? null, error: roleError?.message });
      return fail(403, "not_owner", "only a brand owner can dispatch a send");
    }
    caller = "user";
    loader = user;
  } else {
    logStep({ fn: FN, send_id: sendId, step: "auth", ok: false, ms: t(), caller: "none" });
    return fail(401, "unauthorized", "x-cron-secret or Authorization: Bearer <jwt> required");
  }
  logStep({ fn: FN, send_id: sendId, step: "auth", ok: true, ms: t(), caller });

  // load — through the caller's client: for a user, RLS proves the brand
  t = stopwatch();
  const { data: loaded, error: loadError } = await loader.from("sends").select(SEND_COLUMNS).eq("id", sendId).maybeSingle();
  if (loadError) {
    logStep({ fn: FN, send_id: sendId, step: "load", ok: false, ms: t(), error: loadError.message });
    return fail(500, "internal", "could not load the send");
  }
  if (!loaded) {
    logStep({ fn: FN, send_id: sendId, step: "load", ok: false, ms: t(), reason: "no_row" });
    return caller === "user" ? fail(404, "not_in_brand", "no such send in your brand") : fail(404, "not_found", "no such send");
  }
  const send = loaded as unknown as SendRow;
  logStep({ fn: FN, send_id: sendId, step: "load", ok: true, ms: t(), status: send.status, batch_id: send.batch_id });

  // pre-check — only confirmed | dispatched with no batch_id is dispatchable
  if (send.batch_id !== null) return json(200, { skipped: true, reason: "batch_recorded", status: send.status });
  if (send.status !== "confirmed" && send.status !== "dispatched") return json(200, { skipped: true, reason: `status_${send.status}`, status: send.status });

  // provider secrets — checked BEFORE the lease so a misconfigured deploy never consumes an attempt
  const unset = missingProviderEnv();
  if (unset.length > 0) {
    logStep({ fn: FN, send_id: sendId, step: "config", ok: false, ms: 0, missing: unset });
    return fail(500, "misconfigured", `provider secrets not set: ${unset.join(", ")}`);
  }

  // lease — the CAS; zero rows = someone else holds it or the cap is reached
  t = stopwatch();
  const { data: leased, error: leaseError } = await serviceClient().rpc("dispatch_take_lease", { p_send_id: sendId });
  if (leaseError) {
    logStep({ fn: FN, send_id: sendId, step: "lease", ok: false, ms: t(), error: leaseError.message });
    return fail(500, "internal", "could not take the dispatch lease");
  }
  const leasedRow = Array.isArray(leased) && leased.length > 0 ? (leased[0] as { status: string; dispatch_attempts: number; body_sha256: string | null; recipient_count: number }) : null;
  if (!leasedRow) {
    logStep({ fn: FN, send_id: sendId, step: "lease", ok: false, ms: t(), reason: "no_row" });
    return json(200, { skipped: true, reason: "lease_unavailable" });
  }
  logStep({ fn: FN, send_id: sendId, step: "lease", ok: true, ms: t(), dispatch_attempts: leasedRow.dispatch_attempts });

  // respond first, then do the provider round-trip in the background (the page polls sends.status)
  const work = run(sendId, { ...send, ...leasedRow }).catch((error) => {
    logStep({ fn: FN, send_id: sendId, step: "run", ok: false, ms: 0, error: error instanceof Error ? error.message : String(error) });
  });
  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(work);
  } else {
    await work; // no background runtime (unit harness): finish inline before answering
  }
  return json(202, { send_id: sendId, status: leasedRow.status, dispatch_attempts: leasedRow.dispatch_attempts });
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (error) {
    logStep({ fn: FN, send_id: null, step: "handle", ok: false, ms: 0, error: error instanceof Error ? error.message : String(error) });
    return fail(500, "internal", "unexpected error");
  }
});
