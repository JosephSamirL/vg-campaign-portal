import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fail, wrapRpc } from "../lib/actions";
import { rpcMessage } from "../lib/rpc-codes";
import { credentialsFor, serviceClient, signInAs, testStack, type SignedIn } from "./setup";

/**
 * Story 5.2 — the share-link server actions (AC1, AC2, AC4, AC5).
 *
 * Unit block: the actions run against a recording fake of the server client, so the zod gate
 * (`min(8)`, no trim; ISO expiry or null), the exact RPC arguments, the once-returned URL
 * (host from `x-forwarded-host` / `host`, `https` unless localhost) and the `revalidatePath`
 * call are pinned without a database. Integration block (local stack, KILELE owner + analyst):
 * the same RPCs through the same PostgREST path the actions use — the analyst → `not_owner`,
 * a 7-char password → `invalid_input`, `'       x'` accepted and stored untrimmed, revoke flips
 * the view's `status`. Every link created here is deleted in `afterAll` (service role).
 */

type FakeError = { code: string; message: string; hint?: string | null };
type Rpc = { name: string; args: Record<string, unknown> | undefined };

const rpcCalls: Rpc[] = [];
let rpcResult: { data: unknown; error: FakeError | null } = { data: null, error: null };
let viewRow: { campaign_id: string } | null = null;
let requestHeaders = new Headers();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcResult);
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: table === "v_share_links" ? viewRow : null, error: null }),
      };
      return chain;
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
  }),
}));

const { createShareLinkAction, revokeShareLinkAction } = await import("../app/(portal)/campaigns/[id]/actions");

const CAMPAIGN = "c7d9869d-ae35-400e-9777-f8cf725e2103";
const LINK = "3f7a1b2c-9d8e-4f60-a1b2-c3d4e5f60718";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"; // 43 chars, the RPC's shape

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: TOKEN, error: null };
  viewRow = { campaign_id: CAMPAIGN };
  requestHeaders = new Headers({ host: "portal.example.com" });
  revalidatePath.mockClear();
});

describe("lib/rpc-codes — share copy", () => {
  it("has share-context copy for the three codes the owner RPCs raise, and keeps the send copy as the default", () => {
    expect(rpcMessage("not_owner", null, "share")).toBe("Only the brand owner can publish or revoke share links.");
    expect(rpcMessage("invalid_input", null, "share")).toBe("The password needs at least 8 characters and the expiry must be in the future.");
    expect(rpcMessage("not_in_brand", null, "share")).toBe("That campaign isn't in your brand.");
    expect(rpcMessage("not_owner")).toBe("Only the brand owner can send.");
    expect(rpcMessage("share_denied")).toBe("That share link can't be opened.");
    expect(rpcMessage("rate_limited")).toBe("Too many attempts — wait a minute and try again.");
  });

  it("fail() and wrapRpc() take the context through to the copy", async () => {
    expect(fail("not_owner", null, "share")).toEqual({ ok: false, code: "not_owner", message: "Only the brand owner can publish or revoke share links." });
    const res = await wrapRpc(Promise.resolve({ data: null, error: { code: "P0001", message: "invalid_input", hint: null } }), "share");
    expect(res).toEqual({ ok: false, code: "invalid_input", message: "The password needs at least 8 characters and the expiry must be in the future." });
  });
});

describe("createShareLinkAction — zod before any RPC (AC1)", () => {
  it("rejects a 7-character password with invalid_input and never calls the RPC", async () => {
    const res = await createShareLinkAction({ campaign_id: CAMPAIGN, password: "1234567", expires_at: null });
    expect(res).toEqual({ ok: false, code: "invalid_input", message: rpcMessage("invalid_input", null, "share") });
    expect(rpcCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not trim: 7 spaces are refused, 7 spaces + x are accepted and sent to the RPC untouched", async () => {
    const spaces = await createShareLinkAction({ campaign_id: CAMPAIGN, password: "       ", expires_at: null });
    expect(spaces).toMatchObject({ ok: false, code: "invalid_input" });
    expect(rpcCalls).toEqual([]);

    const res = await createShareLinkAction({ campaign_id: CAMPAIGN, password: "       x", expires_at: null });
    expect(res).toEqual({ ok: true, data: { token: TOKEN, url: `https://portal.example.com/share/${TOKEN}` } });
    expect(rpcCalls).toEqual([{ name: "create_share_link", args: { p_campaign_id: CAMPAIGN, p_password: "       x" } }]);
    expect(revalidatePath).toHaveBeenCalledWith(`/campaigns/${CAMPAIGN}`);
  });

  it("rejects a malformed campaign id, an empty-string expiry and a non-ISO expiry; passes an ISO expiry through as p_expires_at", async () => {
    expect(await createShareLinkAction({ campaign_id: "nope", password: "12345678", expires_at: null })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: "" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: "tomorrow" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await createShareLinkAction(null)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(rpcCalls).toEqual([]);

    const res = await createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: "2027-01-01T10:00:00.000Z" });
    expect(res.ok).toBe(true);
    expect(rpcCalls).toEqual([{ name: "create_share_link", args: { p_campaign_id: CAMPAIGN, p_password: "12345678", p_expires_at: "2027-01-01T10:00:00.000Z" } }]);
  });
});

describe("createShareLinkAction — the URL shown once (AC2)", () => {
  it("prefers x-forwarded-host over host, and is https everywhere but localhost / 127.0.0.1", async () => {
    requestHeaders = new Headers({ host: "internal:3000", "x-forwarded-host": "vg-campaign-portal.vercel.app" });
    let res = await createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: null });
    expect(res).toEqual({ ok: true, data: { token: TOKEN, url: `https://vg-campaign-portal.vercel.app/share/${TOKEN}` } });

    requestHeaders = new Headers({ host: "localhost:3000" });
    res = await createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: null });
    expect(res).toEqual({ ok: true, data: { token: TOKEN, url: `http://localhost:3000/share/${TOKEN}` } });

    requestHeaders = new Headers({ host: "127.0.0.1:3045" });
    res = await createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: null });
    expect(res).toEqual({ ok: true, data: { token: TOKEN, url: `http://127.0.0.1:3045/share/${TOKEN}` } });

    // no host at all: a root-relative path the browser can prefix with its own origin
    requestHeaders = new Headers();
    res = await createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: null });
    expect(res).toEqual({ ok: true, data: { token: TOKEN, url: `/share/${TOKEN}` } });
  });

  it("relays the RPC's refusals with the share copy and never throws for an expected code (AC4, AC5)", async () => {
    for (const code of ["not_owner", "not_in_brand", "invalid_input"] as const) {
      rpcResult = { data: null, error: { code: "P0001", message: code, hint: null } };
      const res = await createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: null });
      expect(res).toEqual({ ok: false, code, message: rpcMessage(code, null, "share") });
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("throws for anything outside the contract so error.tsx renders", async () => {
    rpcResult = { data: null, error: { code: "42501", message: "permission denied for function create_share_link" } };
    await expect(createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: null })).rejects.toThrow(/42501/);
    rpcResult = { data: 42, error: null };
    await expect(createShareLinkAction({ campaign_id: CAMPAIGN, password: "12345678", expires_at: null })).rejects.toThrow(/token/);
  });
});

describe("revokeShareLinkAction (AC3, AC5)", () => {
  it("validates the id, calls revoke_share_link with p_id and revalidates the link's campaign page", async () => {
    rpcResult = { data: null, error: null };
    expect(await revokeShareLinkAction("abc")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await revokeShareLinkAction(undefined)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(rpcCalls).toEqual([]);

    const res = await revokeShareLinkAction(LINK);
    expect(res).toEqual({ ok: true, data: { id: LINK } });
    expect(rpcCalls).toEqual([{ name: "revoke_share_link", args: { p_id: LINK } }]);
    expect(revalidatePath).toHaveBeenCalledWith(`/campaigns/${CAMPAIGN}`);
  });

  it("relays not_owner / not_in_brand with the share copy", async () => {
    rpcResult = { data: null, error: { code: "P0001", message: "not_owner", hint: null } };
    expect(await revokeShareLinkAction(LINK)).toEqual({ ok: false, code: "not_owner", message: "Only the brand owner can publish or revoke share links." });
    rpcResult = { data: null, error: { code: "P0001", message: "not_in_brand", hint: null } };
    expect(await revokeShareLinkAction(LINK)).toEqual({ ok: false, code: "not_in_brand", message: "That campaign isn't in your brand." });
    expect(revalidatePath).not.toHaveBeenCalled();
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
  const message = `tests/share-actions.test.ts: not configured — missing ${missing.join(", ")} (git-ignored .env.test; see .env.example).`;
  if (process.env.CI) throw new Error(`${message} CI requires the share action tests to run.`);
  process.stderr.write(`\n${"=".repeat(88)}\nSKIPPED: ${message}\n${"=".repeat(88)}\n\n`);
}

describe.skipIf(!configured)("share RPCs through PostgREST as the actions call them (KILELE, local stack)", () => {
  let owner: SignedIn;
  let analyst: SignedIn;
  let campaignId: string;
  const created: string[] = [];
  const service = configured ? serviceClient() : undefined;

  beforeAll(async () => {
    [owner, analyst] = await Promise.all([signInAs("KILELE", "owner"), signInAs("KILELE", "analyst")]);
    const { data, error } = await owner.supabase.from("campaigns").select("id").order("external_id").limit(1).single();
    if (error) throw new Error(`campaigns: ${error.message}`);
    campaignId = data.id;
  });

  afterAll(async () => {
    if (!service) return;
    // every link this file created is removed (the RPCs are the only write path for users; the service role deletes)
    for (const id of created) await service.from("share_links").delete().eq("id", id);
  });

  async function ownLinkIds(): Promise<string[]> {
    const { data, error } = await owner.supabase.from("v_share_links").select("id").eq("campaign_id", campaignId);
    if (error) throw new Error(`v_share_links: ${error.message}`);
    return (data ?? []).map((r) => r.id).filter((id): id is string => id !== null);
  }

  it("the analyst's create_share_link maps to { ok: false, code: 'not_owner' } and writes nothing", async () => {
    const before = await ownLinkIds();
    const res = await wrapRpc(analyst.supabase.rpc("create_share_link", { p_campaign_id: campaignId, p_password: "12345678" }), "share");
    expect(res).toEqual({ ok: false, code: "not_owner", message: "Only the brand owner can publish or revoke share links." });
    expect(await ownLinkIds()).toEqual(before);
  });

  it("the owner's 7-char password maps to invalid_input; 7 spaces + x is accepted and the row is active in v_share_links", async () => {
    const short = await wrapRpc(owner.supabase.rpc("create_share_link", { p_campaign_id: campaignId, p_password: "1234567" }), "share");
    expect(short).toMatchObject({ ok: false, code: "invalid_input" });

    const before = await ownLinkIds();
    const res = await wrapRpc(owner.supabase.rpc("create_share_link", { p_campaign_id: campaignId, p_password: "       x" }), "share");
    if (!res.ok) throw new Error(`expected a token, got ${res.code}`);
    expect(res.data).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const after = await ownLinkIds();
    const [id] = after.filter((x) => !before.includes(x));
    expect(id).toBeDefined();
    created.push(id);
    const { data: row } = await owner.supabase.from("v_share_links").select("*").eq("id", id).single();
    expect(row).toMatchObject({ campaign_id: campaignId, status: "active", revoked_at: null, expires_at: null });
    expect(row?.created_by).toBe(owner.userId);
    // the stranger's door accepts the untrimmed password and refuses the trimmed one (5.1's guarantee the UI must not break)
    const anon = await import("./setup").then((m) => m.anonClient());
    const { data: ok } = await anon.rpc("get_shared_results", { p_token: res.data, p_password: "       x" }).single();
    expect(ok?.status).toBe("ok");
    const { data: denied } = await anon.rpc("get_shared_results", { p_token: res.data, p_password: "x" }).single();
    expect(denied?.status).toBe("share_denied");
  });

  it("revoke: the analyst → not_owner, a foreign id → not_in_brand, the owner flips status to revoked, a second revoke is a no-op", async () => {
    const before = await ownLinkIds();
    const create = await wrapRpc(owner.supabase.rpc("create_share_link", { p_campaign_id: campaignId, p_password: "12345678", p_expires_at: new Date(Date.now() + 86_400_000).toISOString() }), "share");
    if (!create.ok) throw new Error(`expected a token, got ${create.code}`);
    const [id] = (await ownLinkIds()).filter((x) => !before.includes(x));
    created.push(id);

    expect(await wrapRpc(analyst.supabase.rpc("revoke_share_link", { p_id: id }), "share")).toMatchObject({ ok: false, code: "not_owner" });
    expect(await wrapRpc(owner.supabase.rpc("revoke_share_link", { p_id: "4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e" }), "share")).toMatchObject({ ok: false, code: "not_in_brand" });
    const { data: still } = await owner.supabase.from("v_share_links").select("status").eq("id", id).single();
    expect(still?.status).toBe("active");

    expect(await wrapRpc(owner.supabase.rpc("revoke_share_link", { p_id: id }), "share")).toEqual({ ok: true, data: null });
    const { data: revoked } = await owner.supabase.from("v_share_links").select("status, revoked_at").eq("id", id).single();
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revoked_at).not.toBeNull();

    expect(await wrapRpc(owner.supabase.rpc("revoke_share_link", { p_id: id }), "share")).toEqual({ ok: true, data: null });
    const { data: again } = await owner.supabase.from("v_share_links").select("revoked_at").eq("id", id).single();
    expect(again?.revoked_at).toBe(revoked?.revoked_at);
  });
});
