import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonClient, credentialsFor, serviceClient, signInAs, testStack, type SignedIn, type TestClient } from "./setup";

/**
 * Story 4.2 — confirm exactly once, through the same PostgREST path the portal uses (AC5).
 *
 * As the KILELE owner (a real password session — never the service key, which would skip the
 * role check and prove nothing): two `confirm_send` calls in `Promise.all` for one campaign must
 * produce exactly one `sends` row and both return its id; a third call after a "refresh" returns
 * it again; a stale count is refused with the recount as the hint; the analyst gets `not_owner`;
 * anonymous gets `42501`. The provider is NOT called here — Story 4.3 adds dispatch and extends
 * this file (keep every send test in this one file: Vitest runs files in parallel and two suites
 * would race for the same campaign). The send stays `confirmed` and is deleted in `afterAll`
 * through the service role (cascade removes its snapshot), so the shared local DB stays clean
 * and the test is repeatable.
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

    // exactly one sends row for the campaign (the local seed holds no sends until Story 4.5)
    const { count, error } = await owner.supabase
      .from("sends")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaign.id);
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
    const { count } = await owner.supabase.from("sends").select("*", { count: "exact", head: true }).eq("campaign_id", campaign.id);
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
    const { count } = await analyst.supabase.from("sends").select("*", { count: "exact", head: true }).eq("campaign_id", campaign.id);
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
