import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireTestLock, anonClient, credentialsFor, serviceClient, signInAs, testStack, type SignedIn, type TestClient } from "./setup";

/**
 * Story 4.2 — confirm exactly once, through the same PostgREST path the portal uses (AC5).
 *
 * As the KILELE owner (a real password session — never the service key, which would skip the
 * role check and prove nothing): two `confirm_send` calls in `Promise.all` for one campaign must
 * produce exactly one `sends` row and both return its id; a third call after a "refresh" returns
 * it again; a stale count is refused with the recount as the hint; the analyst gets `not_owner`;
 * anonymous gets `42501`. The real provider is NEVER called here: Story 4.3's dispatch suite below
 * runs against tests/provider-mock.ts (keep every send test in this one file: Vitest runs files in
 * parallel and two suites would race for the same campaign). Every send a suite creates is deleted
 * in its `afterAll` through the service role (cascade removes its snapshot and provider_batches row),
 * so the shared local DB stays clean and the test is repeatable.
 *
 * Runs against the LOCAL stack only; needs `.env.test` (git-ignored) with TEST_SUPABASE_URL /
 * TEST_SUPABASE_PUBLISHABLE_KEY and logins for the KILELE owner and analyst (see .env.example);
 * unconfigured: skipped with a loud message locally, a hard failure under CI.
 */
const TERMINAL = "(complete,partial,failed)";

const stack = testStack();
const missing = [
  ...(stack ? [] : ["TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY"]),
  ...(credentialsFor("KILELE", "owner") ? [] : ["TEST_KILELE_OWNER_EMAIL/_PASSWORD (or credentials.<host>.txt)"]),
  ...(credentialsFor("KILELE", "analyst") ? [] : ["TEST_KILELE_ANALYST_EMAIL/_PASSWORD"]),
];
const configured = missing.length === 0;

if (!configured) {
  const message = `tests/send-concurrency.test.ts: not configured — missing ${missing.join(", ")} (put them in the git-ignored .env.test; see .env.example).`;
  if (process.env.CI) throw new Error(`${message} CI requires the send concurrency test to run.`);
  process.stderr.write(`\n${"=".repeat(88)}\nSKIPPED: ${message}\n${"=".repeat(88)}\n\n`);
}

type Campaign = { id: string; external_id: string; channel: string | null };

/** The first email/sms campaign of the owner's brand (by external_id) that previews > 0 recipients and has no active send. */
async function pickCampaign(owner: TestClient): Promise<{ campaign: Campaign; expectedCount: number }> {
  const { data: campaigns, error } = await owner
    .from("campaigns")
    .select("id, external_id, channel")
    .in("channel", ["email", "sms"])
    .order("external_id");
  if (error) throw new Error(`campaigns: ${error.message}`);
  const { data: active, error: activeError } = await owner.from("sends").select("campaign_id").not("status", "in", TERMINAL);
  if (activeError) throw new Error(`sends: ${activeError.message}`);
  const busy = new Set((active ?? []).map((s) => s.campaign_id));
  for (const campaign of campaigns ?? []) {
    if (busy.has(campaign.id)) continue;
    const { data: preview, error: previewError } = await owner.rpc("recipient_preview", { p_campaign_id: campaign.id });
    if (previewError) throw new Error(`recipient_preview(${campaign.external_id}): ${previewError.message}`);
    const total = Number(preview?.[0]?.total_count ?? 0);
    if (total > 0) return { campaign, expectedCount: total };
  }
  throw new Error("no email/sms campaign with recipients and no active send — run `pnpm seed` against the local stack");
}

describe.skipIf(!configured)("confirm_send: exactly once through PostgREST (KILELE owner, local stack)", () => {
  let owner: SignedIn;
  let campaign: Campaign;
  let expectedCount: number;
  let sendId: string | undefined;
  const service = configured ? serviceClient() : undefined;

  beforeAll(async () => {
    owner = await signInAs("KILELE", "owner");
    ({ campaign, expectedCount } = await pickCampaign(owner.supabase));
  });

  afterAll(async () => {
    if (!sendId || !service) return;
    // teardown through the service role: cascade removes send_recipients; the campaign is free again
    const { error } = await service.from("sends").delete().eq("id", sendId);
    if (error) throw new Error(`teardown: could not delete send ${sendId}: ${error.message}`);
  });

  it("two concurrent confirms create exactly one send and both return its id", async () => {
    const args = { p_campaign_id: campaign.id, p_expected_count: expectedCount };
    const [a, b] = await Promise.all([owner.supabase.rpc("confirm_send", args), owner.supabase.rpc("confirm_send", args)]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.data?.id).toBeTruthy();
    expect(b.data?.id).toBe(a.data?.id);
    sendId = a.data!.id;

    for (const row of [a.data!, b.data!]) {
      expect(row.status).toBe("confirmed");
      expect(row.source).toBe("portal");
      expect(row.campaign_id).toBe(campaign.id);
      expect(row.brand_id).toBe(owner.brandId);
      expect(row.recipient_count).toBe(expectedCount);
      expect(row.confirmed_by).toBe(owner.email);
      expect(row.confirmed_at).toBeTruthy();
      expect(row.body_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.batch_id).toBeNull(); // dispatch is Story 4.3
    }

    // exactly one PORTAL send for the campaign (4.5's seed send-log rows may sit on the same campaign — 4.2 review [L])
    const { count, error } = await owner.supabase
      .from("sends")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("source", "portal");
    expect(error).toBeNull();
    expect(count).toBe(1);

    // the snapshot is complete: recipient_count = count(send_recipients)
    const { count: recipients, error: recipientsError } = await owner.supabase
      .from("send_recipients")
      .select("*", { count: "exact", head: true })
      .eq("send_id", sendId);
    expect(recipientsError).toBeNull();
    expect(recipients).toBe(expectedCount);
  });

  it("confirming again after a refresh returns the same send, never a second one", async () => {
    const { data, error } = await owner.supabase.rpc("confirm_send", { p_campaign_id: campaign.id, p_expected_count: expectedCount });
    expect(error).toBeNull();
    expect(data?.id).toBe(sendId);
    const { count } = await owner.supabase.from("sends").select("*", { count: "exact", head: true }).eq("campaign_id", campaign.id).eq("source", "portal");
    expect(count).toBe(1);
  });

  it("a stale count is refused with count_mismatch and the recount as the hint", async () => {
    const { data, error } = await owner.supabase.rpc("confirm_send", { p_campaign_id: campaign.id, p_expected_count: expectedCount + 1 });
    expect(data).toBeNull();
    expect(error?.code).toBe("P0001");
    expect(error?.message).toBe("count_mismatch");
    expect(error?.hint).toBe(String(expectedCount));
  });

  it("another brand's campaign is not_in_brand (nothing about it is revealed)", async () => {
    const { error } = await owner.supabase.rpc("confirm_send", { p_campaign_id: "4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e", p_expected_count: 1 });
    expect(error?.code).toBe("P0001");
    expect(error?.message).toBe("not_in_brand");
  });

  it("the KILELE analyst gets not_owner, and nothing is written", async () => {
    const analyst = await signInAs("KILELE", "analyst");
    const { data, error } = await analyst.supabase.rpc("confirm_send", { p_campaign_id: campaign.id, p_expected_count: expectedCount });
    expect(data).toBeNull();
    expect(error?.code).toBe("P0001");
    expect(error?.message).toBe("not_owner");
    const { count } = await analyst.supabase.from("sends").select("*", { count: "exact", head: true }).eq("campaign_id", campaign.id).eq("source", "portal");
    expect(count).toBe(1); // still only the owner's send
  });

  it("anonymous requests are refused outright (no execute grant)", async () => {
    const { data, error } = await anonClient().rpc("confirm_send", { p_campaign_id: campaign.id, p_expected_count: expectedCount });
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

if (!configured) {
  it.todo(`send concurrency test is configured (.env.test with ${missing.join(", ")}) — SKIPPED, not passed`);
}

/**
 * Story 4.3 — dispatch through the provider, crash-safe (AC7), end to end through the locally served Edge
 * Function and the provider mock:
 *
 *   supabase functions serve dispatch-send --env-file supabase/mock.env --no-verify-jwt
 *
 * (`supabase/mock.env` points PROVIDER_BASE_URL at http://host.docker.internal:8787, where Vitest's globalSetup
 * runs tests/provider-mock.ts.) The KILELE owner confirms a send, then invokes `dispatch-send` twice at once:
 * exactly one 202 (the lease), the other `{ skipped: true }`; the send reaches `reporting` with one
 * `provider_batches` row, and the mock saw exactly one distinct Idempotency-Key, `send-<id>`. A third call is
 * skipped; the KAROO owner gets 404 `not_in_brand` (RLS hides the send); the KILELE analyst 403 `not_owner`;
 * no auth 401; a bad cron secret 401. Then, on fresh sends: a provider 4xx → `failed` with the sanitised reason, and a
 * provider 5xx → with `DISPATCH_RETRY_ENABLED=on` (supabase/mock.env since Story 6.3 enabled the sweep, probe row a)
 * the unknown outcome stays `dispatched` under the lease (a further call `lease_unavailable`, no re-POST); with the flag
 * unset it is `partial` immediately with `failure_reason` `provider_503_outcome_unknown`, `accepted_count` null, a
 * further call skipped as `status_partial` (D-7). Crash recovery (4.3 review): a 200 whose body was lost leaves the send
 * `dispatched` (never `failed`); once the lease is expired (service role) a re-invoke replays the SAME
 * `Idempotency-Key`, the mock answers the stored batch_id (`replay: true`) and the send reaches `reporting` with
 * attempts 2 and one distinct key. Skipped loudly when the function is not served (fails under CI).
 */
const FUNCTIONS_URL = stack ? `${stack.url}/functions/v1/dispatch-send` : "";
const MOCK_URL = process.env.PROVIDER_MOCK_URL ?? `http://127.0.0.1:${process.env.PROVIDER_MOCK_PORT ?? 8787}`;
const POLL_MS = 500;
const POLL_LIMIT_MS = 15_000;

/** The cron secret the locally served function was given (supabase/mock.env), for the cron-path assertions. */
function localCronSecret(): string | null {
  if (process.env.TEST_CRON_SECRET) return process.env.TEST_CRON_SECRET;
  if (!existsSync("supabase/mock.env")) return null;
  return dotenv.parse(readFileSync("supabase/mock.env", "utf8")).CRON_SECRET ?? null;
}

/** Story 6.3 (probe row a): `DISPATCH_RETRY_ENABLED=on` in supabase/mock.env — the 5xx case below asserts whichever branch is served. */
function localRetryEnabled(): boolean {
  if (process.env.TEST_DISPATCH_RETRY_ENABLED) return process.env.TEST_DISPATCH_RETRY_ENABLED === "on";
  if (!existsSync("supabase/mock.env")) return false;
  return dotenv.parse(readFileSync("supabase/mock.env", "utf8")).DISPATCH_RETRY_ENABLED === "on";
}

/** Is `dispatch-send` being served? A malformed body must come back as the function's own 400 invalid_input. */
async function functionServed(): Promise<boolean> {
  if (!stack) return false;
  try {
    const res = await fetch(FUNCTIONS_URL, { method: "POST", headers: { apikey: stack.key, "Content-Type": "application/json" }, body: "{" });
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    return res.status === 400 && body?.code === "invalid_input";
  } catch {
    return false;
  }
}

async function mockReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MOCK_URL}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

const dispatchMissing = [
  ...missing,
  ...(credentialsFor("KAROO", "owner") ? [] : ["TEST_KAROO_OWNER_EMAIL/_PASSWORD"]),
  ...((await functionServed()) ? [] : ["`supabase functions serve dispatch-send --env-file supabase/mock.env --no-verify-jwt` (dispatch-send is not served)"]),
  ...((await mockReachable()) ? [] : [`the provider mock at ${MOCK_URL} (tests/global-setup.ts starts it)`]),
];
const dispatchConfigured = dispatchMissing.length === 0;
if (!dispatchConfigured) {
  const message = `tests/send-concurrency.test.ts (dispatch): not configured — missing ${dispatchMissing.join(", ")}.`;
  if (process.env.CI) throw new Error(`${message} CI requires the dispatch test to run.`);
  process.stderr.write(`\n${"=".repeat(88)}\nSKIPPED: ${message}\n${"=".repeat(88)}\n\n`);
}

type DispatchResponse = { status: number; body: Record<string, unknown> };

async function invokeDispatch(sendId: string, headers: Record<string, string>): Promise<DispatchResponse> {
  const res = await fetch(FUNCTIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ send_id: sendId }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

async function mockCalls(): Promise<Array<{ key: string | null; batch_id: string | null; status: number; replay: boolean }>> {
  const res = await fetch(`${MOCK_URL}/__mock/calls`);
  return (await res.json()) as Array<{ key: string | null; batch_id: string | null; status: number; replay: boolean }>;
}

async function mockConfig(patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${MOCK_URL}/__mock/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`mock config: ${res.status}`);
}

async function mockReset(): Promise<void> {
  const res = await fetch(`${MOCK_URL}/__mock/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`mock reset: ${res.status}`);
}

type SendState = { status: string; batch_id: string | null; accepted_count: number | null; rejected_count: number | null; failure_reason: string | null; dispatch_attempts: number; dispatch_lease_until: string | null; provider_responded_at: string | null; recipient_count: number };

async function readSend(client: TestClient, sendId: string): Promise<SendState> {
  const { data, error } = await client
    .from("sends")
    .select("status, batch_id, accepted_count, rejected_count, failure_reason, dispatch_attempts, dispatch_lease_until, provider_responded_at, recipient_count")
    .eq("id", sendId)
    .single();
  if (error || !data) throw new Error(`sends ${sendId}: ${error?.message ?? "not found"}`);
  return data as SendState;
}

/** Poll sends.status every 500 ms until it is one of `until` (≤ 15 s), returning the row and the elapsed time. */
async function pollUntil(client: TestClient, sendId: string, until: string[]): Promise<{ send: SendState; elapsedMs: number }> {
  const started = Date.now();
  for (;;) {
    const send = await readSend(client, sendId);
    if (until.includes(send.status)) return { send, elapsedMs: Date.now() - started };
    if (Date.now() - started > POLL_LIMIT_MS) throw new Error(`send ${sendId} still ${send.status} after ${POLL_LIMIT_MS} ms (waiting for ${until.join("|")})`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Confirm a fresh send on the next free campaign of the owner's brand (the previous suite's send is gone by now). */
async function confirmFreshSend(owner: SignedIn): Promise<{ sendId: string; campaign: Campaign; recipientCount: number }> {
  const { campaign, expectedCount } = await pickCampaign(owner.supabase);
  const { data, error } = await owner.supabase.rpc("confirm_send", { p_campaign_id: campaign.id, p_expected_count: expectedCount });
  if (error || !data) throw new Error(`confirm_send(${campaign.external_id}): ${error?.message ?? "no row"}`);
  return { sendId: data.id, campaign, recipientCount: data.recipient_count };
}

describe.skipIf(!dispatchConfigured)("dispatch-send: exactly once through the Edge Function + provider mock (KILELE owner, local stack)", () => {
  let owner: SignedIn;
  let ownerHeaders: Record<string, string>;
  let sendId: string;
  let recipientCount: number;
  const createdSends: string[] = [];
  const service = dispatchConfigured ? serviceClient() : undefined;
  const cronSecret = localCronSecret();
  let releaseLock: (() => void) | undefined;

  beforeAll(async () => {
    // the poller suite (tests/ingestion.test.ts) must not see this suite's batches inside its poll window (Story 6.3)
    releaseLock = await acquireTestLock("provider-batches");
    await mockReset();
    owner = await signInAs("KILELE", "owner");
    const { data: sessionData } = await owner.supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error("no access token for the KILELE owner");
    ownerHeaders = { Authorization: `Bearer ${token}`, apikey: stack!.key };
    ({ sendId, recipientCount } = await confirmFreshSend(owner));
    createdSends.push(sendId);
  }, 200_000);

  afterAll(async () => {
    try {
      await mockConfig({ status: null, reject_ids: [], latency_ms: 0, blank_body: false }).catch(() => undefined);
      if (!service) return;
      for (const id of createdSends) {
        // teardown through the service role: cascade removes send_recipients + provider_batches
        const { error } = await service.from("sends").delete().eq("id", id);
        if (error) throw new Error(`teardown: could not delete send ${id}: ${error.message}`);
      }
    } finally {
      releaseLock?.();
    }
  });

  it("two concurrent invocations: one 202 takes the lease, the other is skipped", async () => {
    const [a, b] = await Promise.all([invokeDispatch(sendId, ownerHeaders), invokeDispatch(sendId, ownerHeaders)]);
    const responses = [a, b];
    const accepted = responses.filter((r) => r.status === 202);
    const skipped = responses.filter((r) => r.status === 200 && r.body.skipped === true);
    expect(accepted).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(accepted[0].body).toMatchObject({ send_id: sendId, status: "dispatched", dispatch_attempts: 1 });
  });

  it("the send reaches reporting with one provider_batches row, and the mock saw one distinct key send-<id>", async () => {
    const { send, elapsedMs } = await pollUntil(owner.supabase, sendId, ["reporting", "partial", "failed"]);
    process.stdout.write(`dispatch-send: ${recipientCount} recipients → ${send.status} in ${elapsedMs} ms\n`);
    expect(send.status).toBe("reporting");
    expect(send.batch_id).toMatch(/^mock-\d+$/);
    expect(send.accepted_count).toBe(recipientCount);
    expect(send.rejected_count).toBe(0);
    expect(send.failure_reason).toBeNull();
    expect(send.dispatch_attempts).toBe(1);
    expect(send.provider_responded_at).toBeTruthy();

    const { data: batches, error } = await owner.supabase.from("provider_batches").select("send_id, batch_id, polling").eq("send_id", sendId);
    expect(error).toBeNull();
    expect(batches).toHaveLength(1);
    expect(batches![0]).toMatchObject({ send_id: sendId, batch_id: send.batch_id, polling: "active" });

    const calls = await mockCalls();
    const keys = new Set(calls.map((c) => c.key));
    expect([...keys]).toEqual([`send-${sendId}`]);
    expect(calls.filter((c) => c.status === 200 && !c.replay)).toHaveLength(1);
    expect(calls[0].batch_id).toBe(send.batch_id);
  });

  it("a third invocation after the provider answered is skipped (batch recorded), nothing re-POSTed", async () => {
    const res = await invokeDispatch(sendId, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ skipped: true, reason: "batch_recorded", status: "reporting" });
    const calls = await mockCalls();
    expect(calls).toHaveLength(1);
    expect((await readSend(owner.supabase, sendId)).dispatch_attempts).toBe(1);
  });

  it("the KAROO owner gets 404 not_in_brand (RLS hides the send)", async () => {
    const karoo = await signInAs("KAROO", "owner");
    const { data } = await karoo.supabase.auth.getSession();
    const res = await invokeDispatch(sendId, { Authorization: `Bearer ${data.session!.access_token}`, apikey: stack!.key });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "not_in_brand" });
  });

  it("the KILELE analyst gets 403 not_owner", async () => {
    const analyst = await signInAs("KILELE", "analyst");
    const { data } = await analyst.supabase.auth.getSession();
    const res = await invokeDispatch(sendId, { Authorization: `Bearer ${data.session!.access_token}`, apikey: stack!.key });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "not_owner" });
  });

  it("no credentials → 401; a garbage bearer → 401; a wrong cron secret → 401; a non-uuid → 400", async () => {
    expect((await invokeDispatch(sendId, { apikey: stack!.key })).status).toBe(401);
    expect((await invokeDispatch(sendId, { Authorization: "Bearer not-a-jwt", apikey: stack!.key })).status).toBe(401);
    expect((await invokeDispatch(sendId, { "x-cron-secret": "wrong", apikey: stack!.key })).status).toBe(401);
    const bad = await invokeDispatch("not-a-uuid", ownerHeaders);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "invalid_input" });
  });

  it.skipIf(!cronSecret)("the cron secret path: an unknown send is 404 not_found, the recorded send is skipped", async () => {
    const unknown = await invokeDispatch("4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e", { "x-cron-secret": cronSecret!, apikey: stack!.key });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "not_found" });
    const recorded = await invokeDispatch(sendId, { "x-cron-secret": cronSecret!, apikey: stack!.key });
    expect(recorded.status).toBe(200);
    expect(recorded.body).toMatchObject({ skipped: true, reason: "batch_recorded" });
  });

  it("a snapshot whose digest is not body_sha256 is failed with body_hash_mismatch and never POSTed", async () => {
    const fresh = await confirmFreshSend(owner);
    createdSends.push(fresh.sendId);
    // fixture tampering through the service role (the app cannot write sends): the stored digest no longer matches the snapshot
    const { error } = await service!.from("sends").update({ body_sha256: "0".repeat(64) }).eq("id", fresh.sendId);
    expect(error).toBeNull();
    const before = (await mockCalls()).length;
    const res = await invokeDispatch(fresh.sendId, ownerHeaders);
    expect(res.status).toBe(202);
    const { send } = await pollUntil(owner.supabase, fresh.sendId, ["reporting", "partial", "failed"]);
    expect(send.status).toBe("failed");
    expect(send.failure_reason).toBe("body_hash_mismatch");
    expect(send.batch_id).toBeNull();
    expect((await mockCalls()).length).toBe(before); // nothing reached the provider
  });

  it("a provider 4xx marks the send failed with the reason, no provider_batches row", async () => {
    const fresh = await confirmFreshSend(owner);
    createdSends.push(fresh.sendId);
    await mockConfig({ status: 422 });
    try {
      const res = await invokeDispatch(fresh.sendId, ownerHeaders);
      expect(res.status).toBe(202);
      const { send } = await pollUntil(owner.supabase, fresh.sendId, ["reporting", "partial", "failed"]);
      expect(send.status).toBe("failed");
      // sanitised: `provider_<status>: <first 120 chars, whitespace collapsed>` — never the raw body, never a newline
      expect(send.failure_reason).toMatch(/^provider_422: \S/);
      expect(send.failure_reason!.length).toBeLessThanOrEqual("provider_422: ".length + 121);
      expect(send.failure_reason).not.toMatch(/[\r\n]/);
      expect(send.batch_id).toBeNull();
      expect(send.provider_responded_at).toBeTruthy();
      const { count } = await owner.supabase.from("provider_batches").select("*", { count: "exact", head: true }).eq("send_id", fresh.sendId);
      expect(count).toBe(0);
      // a failed send frees the campaign: the owner may confirm it again
      const again = await owner.supabase.rpc("confirm_send", { p_campaign_id: fresh.campaign.id, p_expected_count: fresh.recipientCount });
      expect(again.error).toBeNull();
      expect(again.data?.id).not.toBe(fresh.sendId);
      if (again.data) createdSends.push(again.data.id);
    } finally {
      await mockConfig({ status: null });
    }
  });

  it("a provider 5xx: with retries ON (Story 6.3, DISPATCH_RETRY_ENABLED=on in mock.env) the send stays dispatched under its lease for the sweep to replay; with retries OFF it is partial at once — outcome unknown, nothing fabricated, no re-POST either way", async () => {
    const fresh = await confirmFreshSend(owner);
    createdSends.push(fresh.sendId);
    const before = (await mockCalls()).length;
    await mockConfig({ status: 503 });
    try {
      const res = await invokeDispatch(fresh.sendId, ownerHeaders);
      expect(res.status).toBe(202);
      // wait for the background POST to have happened (the mock records it), then for the outcome to land
      const started = Date.now();
      while ((await mockCalls()).length === before && Date.now() - started < POLL_LIMIT_MS) await new Promise((r) => setTimeout(r, POLL_MS));
      const calls = await mockCalls();
      expect(calls.length).toBe(before + 1);
      expect(calls[calls.length - 1]).toMatchObject({ key: `send-${fresh.sendId}`, status: 503 });
      await new Promise((r) => setTimeout(r, POLL_MS));
      let send = await readSend(owner.supabase, fresh.sendId);
      if (localRetryEnabled()) {
        // retries on: the outcome is unknown and stays unknown under the lease — the sweep (now enabled, 0013) replays
        // the same Idempotency-Key once the 10-min lease expires and caps at 3 attempts (D-7, probe row a)
        expect(send.status).toBe("dispatched");
        expect(send.failure_reason).toBeNull();
        expect(send.batch_id).toBeNull();
        expect(send.accepted_count).toBeNull();
        expect(send.dispatch_attempts).toBe(1);
        expect(send.dispatch_lease_until).toBeTruthy();
        expect(Date.parse(send.dispatch_lease_until!)).toBeGreaterThan(Date.now());
        const again = await invokeDispatch(fresh.sendId, ownerHeaders);
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ skipped: true, reason: "lease_unavailable" });
        expect((await mockCalls()).length).toBe(before + 1);
        return;
      }
      while (send.status === "dispatched" && Date.now() - started < POLL_LIMIT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        send = await readSend(owner.supabase, fresh.sendId);
      }
      expect(send.status).toBe("partial");
      expect(send.failure_reason).toBe("provider_503_outcome_unknown");
      expect(send.batch_id).toBeNull();
      expect(send.accepted_count).toBeNull(); // the portal renders "provider outcome unknown" (4.4)
      expect(send.provider_responded_at).toBeNull();
      expect(send.dispatch_attempts).toBe(1);
      // partial is terminal: a further call is skipped on the pre-check, nothing more reaches the provider
      const again = await invokeDispatch(fresh.sendId, ownerHeaders);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ skipped: true, reason: "status_partial" });
      expect((await mockCalls()).length).toBe(before + 1);
      // ... and the campaign is free again (uq_sends_one_active_per_campaign ignores partial): a fresh confirm succeeds
      const next = await owner.supabase.rpc("confirm_send", { p_campaign_id: fresh.campaign.id, p_expected_count: fresh.recipientCount });
      expect(next.error).toBeNull();
      expect(next.data?.id).toBeTruthy();
      if (next.data?.id) createdSends.push(next.data.id);
    } finally {
      await mockConfig({ status: null });
    }
  });

  it("crash recovery: a 200 with a lost body leaves the send dispatched; after the lease expires a re-invoke replays the same key and lands on the same batch_id", async () => {
    const fresh = await confirmFreshSend(owner);
    createdSends.push(fresh.sendId);
    const before = (await mockCalls()).length;
    await mockConfig({ blank_body: true });
    try {
      // attempt 1: the provider commits the batch, the response body never arrives → outcome unknown, NOT failed
      const first = await invokeDispatch(fresh.sendId, ownerHeaders);
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({ dispatch_attempts: 1 });
      const started = Date.now();
      while ((await mockCalls()).length === before && Date.now() - started < POLL_LIMIT_MS) await new Promise((r) => setTimeout(r, POLL_MS));
      await new Promise((r) => setTimeout(r, POLL_MS));
      const stranded = await readSend(owner.supabase, fresh.sendId);
      expect(stranded.status).toBe("dispatched");
      expect(stranded.batch_id).toBeNull();
      expect(stranded.failure_reason).toBeNull();
      expect(stranded.dispatch_attempts).toBe(1);
      expect((await mockCalls()).slice(before)).toMatchObject([{ key: `send-${fresh.sendId}`, status: 200, replay: false }]);
      // the lease is live: a further call is skipped (nothing re-POSTed)
      expect((await invokeDispatch(fresh.sendId, ownerHeaders)).body).toMatchObject({ skipped: true, reason: "lease_unavailable" });
      expect((await mockCalls()).length).toBe(before + 1);

      // the crash-recovery precondition: the 10-min lease has expired (fixture through the service role — the app cannot write sends)
      await mockConfig({ blank_body: false });
      const { error } = await service!.from("sends").update({ dispatch_lease_until: new Date(Date.now() - 1_000).toISOString() }).eq("id", fresh.sendId);
      expect(error).toBeNull();

      // attempt 2: same derived Idempotency-Key → the mock replays the stored batch → reporting, attempts 2
      const second = await invokeDispatch(fresh.sendId, ownerHeaders);
      expect(second.status).toBe(202);
      expect(second.body).toMatchObject({ send_id: fresh.sendId, status: "dispatched", dispatch_attempts: 2 });
      const { send } = await pollUntil(owner.supabase, fresh.sendId, ["reporting", "partial", "failed"]);
      expect(send.status).toBe("reporting");
      expect(send.dispatch_attempts).toBe(2);
      expect(send.accepted_count).toBe(fresh.recipientCount);
      const calls = (await mockCalls()).slice(before);
      expect(calls).toHaveLength(2);
      expect(new Set(calls.map((c) => c.key)).size).toBe(1);
      expect(calls[1]).toMatchObject({ key: `send-${fresh.sendId}`, replay: true, batch_id: calls[0].batch_id });
      expect(send.batch_id).toBe(calls[0].batch_id);
      const { count } = await owner.supabase.from("provider_batches").select("*", { count: "exact", head: true }).eq("send_id", fresh.sendId);
      expect(count).toBe(1);
    } finally {
      await mockConfig({ blank_body: false });
    }
  });
});

if (!dispatchConfigured) {
  it.todo(`dispatch test is configured (${dispatchMissing.join(", ")}) — SKIPPED, not passed`);
}
