import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fail, wrapRpc } from "../lib/actions";
import { RPC_CODES, isRpcCode, rpcMessage } from "../lib/rpc-codes";
import { credentialsFor, serviceClient, signInAs, testStack, type SignedIn, type TestClient } from "./setup";

/**
 * Story 4.4 — the server-action side of the send flow (AC2, AC4, AC5).
 *
 * `wrapRpc` is the only place a PostgREST error becomes an action result: a `P0001` whose message
 * is one of the RPC codes maps to `{ ok: false, code, message, hint }`; anything else throws so the
 * route's `error.tsx` renders. The unit block pins that with fake thenables; the integration block
 * runs the real RPCs through the same PostgREST path the actions use, as the KILELE analyst
 * (→ `not_owner`) and owner with a stale count (→ `count_mismatch`, hint = the recount). Neither
 * call writes a `sends` row, but `afterAll` still sweeps any portal send on the campaigns it
 * touched (service role), so the shared local DB is left as found. The provider is never called.
 */

type FakeError = { code: string; message: string; hint?: string | null; details?: string | null };
const thenable = <T>(data: T | null, error: FakeError | null) => Promise.resolve({ data, error });

describe("lib/rpc-codes", () => {
  it("lists exactly the architecture's error contract", () => {
    expect([...RPC_CODES]).toEqual(["not_owner", "not_in_brand", "count_mismatch", "invalid_input", "send_in_progress", "share_denied", "rate_limited"]);
    expect(isRpcCode("not_owner")).toBe(true);
    expect(isRpcCode("division_by_zero")).toBe(false);
    expect(isRpcCode(undefined)).toBe(false);
  });

  it("has a sentence for every code and substitutes the count into count_mismatch", () => {
    for (const code of RPC_CODES) expect(rpcMessage(code).length).toBeGreaterThan(10);
    expect(rpcMessage("not_owner")).toBe("Only the brand owner can send.");
    expect(rpcMessage("count_mismatch", "50063")).toBe("The list changed since you looked — 50,063 now. Confirm again.");
    // no hint: the sentence still reads, never "undefined now"
    expect(rpcMessage("count_mismatch")).not.toContain("undefined");
  });
});

describe("wrapRpc / fail", () => {
  it("returns { ok: true, data } for a successful query", async () => {
    await expect(wrapRpc(thenable({ id: "s1" }, null))).resolves.toEqual({ ok: true, data: { id: "s1" } });
  });

  it("maps a P0001 with a known message to the code, copy and hint", async () => {
    const res = await wrapRpc(thenable(null, { code: "P0001", message: "count_mismatch", hint: "50063" }));
    expect(res).toEqual({ ok: false, code: "count_mismatch", message: "The list changed since you looked — 50,063 now. Confirm again.", hint: "50063" });
    const owner = await wrapRpc(thenable(null, { code: "P0001", message: "not_owner", hint: null }));
    expect(owner).toEqual({ ok: false, code: "not_owner", message: "Only the brand owner can send." });
  });

  it("throws (for error.tsx) on an unknown message, a non-P0001 code, or a PostgREST error", async () => {
    await expect(wrapRpc(thenable(null, { code: "P0001", message: "something_else" }))).rejects.toThrow(/something_else/);
    await expect(wrapRpc(thenable(null, { code: "42501", message: "not_owner" }))).rejects.toThrow(/42501/);
    await expect(wrapRpc(thenable(null, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }))).rejects.toThrow(/PGRST116/);
  });

  it("fail() builds the wrapper from a code (and an optional hint)", () => {
    expect(fail("invalid_input")).toEqual({ ok: false, code: "invalid_input", message: "This campaign can't be sent (no recipients or unsupported channel)." });
    expect(fail("count_mismatch", "7")).toEqual({ ok: false, code: "count_mismatch", message: "The list changed since you looked — 7 now. Confirm again.", hint: "7" });
  });
});

const stack = testStack();
const missing = [
  ...(stack ? [] : ["TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY"]),
  ...(credentialsFor("KILELE", "owner") ? [] : ["TEST_KILELE_OWNER_EMAIL/_PASSWORD"]),
  ...(credentialsFor("KILELE", "analyst") ? [] : ["TEST_KILELE_ANALYST_EMAIL/_PASSWORD"]),
];
const configured = missing.length === 0;
if (!configured) {
  const message = `tests/send-actions.test.ts: not configured — missing ${missing.join(", ")} (git-ignored .env.test; see .env.example).`;
  if (process.env.CI) throw new Error(`${message} CI requires the send action tests to run.`);
  process.stderr.write(`\n${"=".repeat(88)}\nSKIPPED: ${message}\n${"=".repeat(88)}\n\n`);
}

/** The first email/sms campaign (by external_id) whose preview is > 0 — no send is created here, so an active send does not matter. */
async function pickCampaign(client: TestClient): Promise<{ id: string; total: number }> {
  const { data: campaigns, error } = await client.from("campaigns").select("id, external_id").in("channel", ["email", "sms"]).order("external_id");
  if (error) throw new Error(`campaigns: ${error.message}`);
  for (const campaign of campaigns ?? []) {
    const { data, error: previewError } = await client.rpc("recipient_preview", { p_campaign_id: campaign.id }).single();
    if (previewError) throw new Error(`recipient_preview(${campaign.external_id}): ${previewError.message}`);
    if (Number(data.total_count) > 0) return { id: campaign.id, total: Number(data.total_count) };
  }
  throw new Error("no email/sms campaign with recipients — run `pnpm seed` against the local stack");
}

describe.skipIf(!configured)("send actions through PostgREST (KILELE, local stack)", () => {
  let owner: SignedIn;
  let analyst: SignedIn;
  let campaignId: string;
  let total: number;
  let before: number;
  const service = configured ? serviceClient() : undefined;

  beforeAll(async () => {
    [owner, analyst] = await Promise.all([signInAs("KILELE", "owner"), signInAs("KILELE", "analyst")]);
    ({ id: campaignId, total } = await pickCampaign(owner.supabase));
    const { count } = await owner.supabase.from("sends").select("*", { count: "exact", head: true }).eq("campaign_id", campaignId);
    before = count ?? 0;
  });

  afterAll(async () => {
    if (!service || !campaignId) return;
    // nothing here should have written a send; if one slipped through, remove it (cascade) so the DB is as found
    const { data } = await service.from("sends").select("id").eq("campaign_id", campaignId).eq("source", "portal").is("batch_id", null).eq("status", "confirmed");
    const { count } = await service.from("sends").select("*", { count: "exact", head: true }).eq("campaign_id", campaignId);
    if ((count ?? 0) > before) for (const row of data ?? []) await service.from("sends").delete().eq("id", row.id);
  });

  it("previewSendAction's RPC maps to the seven preview fields through wrapRpc", async () => {
    const res = await wrapRpc(analyst.supabase.rpc("recipient_preview", { p_campaign_id: campaignId }).single());
    if (!res.ok) throw new Error(`expected ok, got ${res.code}`);
    expect(Number(res.data.total_count)).toBe(total);
    expect(["email", "sms"]).toContain(res.data.channel);
    expect(res.data.rule_text.length).toBeGreaterThan(0);
    const excluded = Number(res.data.not_contactable) + Number(res.data.no_address) + Number(res.data.country_mismatch_or_unknown);
    expect(excluded).toBeGreaterThanOrEqual(0);
  });

  it("an analyst confirming maps to { ok: false, code: 'not_owner' } — the RPC refuses, the action only maps", async () => {
    const res = await wrapRpc(analyst.supabase.rpc("confirm_send", { p_campaign_id: campaignId, p_expected_count: total }));
    expect(res).toMatchObject({ ok: false, code: "not_owner", message: "Only the brand owner can send." });
    const { count } = await owner.supabase.from("sends").select("*", { count: "exact", head: true }).eq("campaign_id", campaignId);
    expect(count).toBe(before);
  });

  it("an owner with a stale count maps to count_mismatch with the recount as the hint (D-6)", async () => {
    const res = await wrapRpc(owner.supabase.rpc("confirm_send", { p_campaign_id: campaignId, p_expected_count: total + 1 }));
    if (res.ok) throw new Error("expected count_mismatch, got a send");
    expect(res.code).toBe("count_mismatch");
    expect(res.hint).toBe(String(total));
    expect(res.message).toBe(`The list changed since you looked — ${total.toLocaleString("en-US")} now. Confirm again.`);
    const { count } = await owner.supabase.from("sends").select("*", { count: "exact", head: true }).eq("campaign_id", campaignId);
    expect(count).toBe(before);
  });

  it("another brand's campaign maps to not_in_brand, an unsupported channel to invalid_input", async () => {
    const foreign = await wrapRpc(owner.supabase.rpc("recipient_preview", { p_campaign_id: "4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e" }).single());
    expect(foreign).toMatchObject({ ok: false, code: "not_in_brand" });
    const { data: push } = await owner.supabase.from("campaigns").select("id").not("channel", "in", "(email,sms)").limit(1).maybeSingle();
    if (push) {
      const res = await wrapRpc(owner.supabase.rpc("recipient_preview", { p_campaign_id: push.id }).single());
      expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    }
  });
});
