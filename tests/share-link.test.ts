import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceClient, signInAs, testStack, type SignedIn, type TestClient } from "./setup";

/**
 * Story 5.3 — the share door from the stranger's side (AC5), against the LOCAL stack as `anon`.
 *
 * The KILELE owner creates two links through `create_share_link` (the same RPC the 5.2 action
 * wraps): one is burned by the rate-limit case (a limited token stays limited 15 min), the other
 * carries the success → revoke → denied sequence. Every stranger call goes through
 * `createAnonClient()` — the page's own client — and `unlockShareAction` is called directly with a
 * `FormData`, so the "one sentence for every failure" contract is pinned on the action itself, not
 * on a re-implementation. PostgREST refusals (`42501`) prove `anon` can reach nothing but the RPC.
 * `afterAll` deletes the two links (service role, teardown only) so the shared local DB is left as
 * found; `internal.share_attempts` rows for burned tokens are harmless (fresh tokens every run).
 */

// The app's anon client reads NEXT_PUBLIC_SUPABASE_*; `.env.local` may point those at the hosted
// project, so re-target them at the local test stack before the action is ever called.
const stack = testStack();
if (stack) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = stack.url;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = stack.key;
}

const { createAnonClient } = await import("../lib/supabase/anon");
const { SHARE_FAILURE_MESSAGE } = await import("../app/(public)/share/[token]/copy");
const { unlockShareAction, unlockShareFormAction } = await import("../app/(public)/share/[token]/actions");

const PASSWORD = "  stranger pass 1"; // leading spaces on purpose: nothing may trim
const WRONG = "not the password";

function form(password?: string): FormData {
  const fd = new FormData();
  if (password !== undefined) fd.append("password", password);
  return fd;
}

/** A token that is shaped like a real one (43 URL-safe chars) but was never issued. */
function guessedToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < 43; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const OK_KEYS = [
  "status",
  "campaign_name",
  "channel",
  "sent_at",
  "reported_sent",
  "reported_delivered",
  "reported_bounced",
  "reported_opens",
  "reported_clicks",
  "delivered_rate",
  "bounce_rate",
  "open_rate",
  "click_rate",
  "unsubscribe_rate",
  "captions",
];

describe("share link — a stranger opens the link (Story 5.3)", () => {
  let owner: SignedIn;
  let anon: TestClient;
  let campaignId: string;
  let limitedToken: string; // link 1: burned by the rate-limit case
  let goodToken: string; // link 2: success, then revoked
  let goodLinkId: string;
  const createdIds: string[] = [];

  async function ownLinkIds(): Promise<Set<string>> {
    const { data, error } = await owner.supabase.from("v_share_links").select("id").eq("campaign_id", campaignId);
    if (error) throw new Error(`v_share_links: ${error.message}`);
    return new Set((data ?? []).map((r) => r.id as string));
  }

  beforeAll(async () => {
    if (!stack) throw new Error("tests/share-link.test.ts: TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY are not set (.env.test)");
    owner = await signInAs("KILELE", "owner");
    anon = createAnonClient();

    const { data: campaign, error: cErr } = await owner.supabase.from("campaigns").select("id").limit(1).single();
    if (cErr || !campaign) throw new Error(`no KILELE campaign: ${cErr?.message ?? "none"}`);
    campaignId = campaign.id;

    const before = await ownLinkIds();
    const first = await owner.supabase.rpc("create_share_link", { p_campaign_id: campaignId, p_password: PASSWORD });
    if (first.error || typeof first.data !== "string") throw new Error(`create_share_link (1): ${first.error?.message ?? "no token"}`);
    limitedToken = first.data;
    const afterFirst = await ownLinkIds();
    const second = await owner.supabase.rpc("create_share_link", { p_campaign_id: campaignId, p_password: PASSWORD });
    if (second.error || typeof second.data !== "string") throw new Error(`create_share_link (2): ${second.error?.message ?? "no token"}`);
    goodToken = second.data;
    const afterSecond = await ownLinkIds();

    for (const id of afterSecond) if (!before.has(id)) createdIds.push(id);
    const [secondId] = [...afterSecond].filter((id) => !afterFirst.has(id));
    if (!secondId) throw new Error("could not identify the second link's id");
    goodLinkId = secondId;
  });

  afterAll(async () => {
    if (createdIds.length === 0) return;
    const { error } = await serviceClient().from("share_links").delete().in("id", createdIds);
    if (error) throw new Error(`cleanup share_links: ${error.message}`);
    await owner?.supabase.auth.signOut();
  });

  it("issues 43-char URL-safe tokens and never renders them anywhere but the RPC result", () => {
    expect(limitedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(goodToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(limitedToken).not.toBe(goodToken);
  });

  it("a guessed token is denied — one row, status share_denied, nothing else in it", async () => {
    const { data, error } = await anon.rpc("get_shared_results", { p_token: guessedToken(), p_password: PASSWORD }).single();
    expect(error).toBeNull();
    expect(data?.status).toBe("share_denied");
    expect(data?.campaign_name).toBeNull();
    expect(data?.reported_sent).toBeNull();
    expect(data?.captions).toBeNull();
  });

  it("10 wrong passwords are share_denied, the 11th is rate_limited, and the action says the same sentence for both", async () => {
    const statuses: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { data, error } = await anon.rpc("get_shared_results", { p_token: limitedToken, p_password: WRONG }).single();
      expect(error).toBeNull();
      statuses.push(data?.status ?? "?");
    }
    expect(statuses).toEqual(Array(10).fill("share_denied"));

    const eleventh = await anon.rpc("get_shared_results", { p_token: limitedToken, p_password: WRONG }).single();
    expect(eleventh.error).toBeNull();
    expect(eleventh.data?.status).toBe("rate_limited");
    expect(eleventh.data?.campaign_name).toBeNull();

    // through the action: rate_limited (still limited) and share_denied (a wrong password on the good link)
    const limited = await unlockShareAction(limitedToken, null, form(WRONG));
    expect(limited.ok).toBe(false);
    if (limited.ok) throw new Error("unreachable");
    expect(limited.code).toBe("rate_limited");
    expect(limited.message).toBe(SHARE_FAILURE_MESSAGE);

    const denied = await unlockShareAction(goodToken, null, form(WRONG));
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.code).toBe("share_denied");
    expect(denied.message).toBe(SHARE_FAILURE_MESSAGE);

    // the right password on the limited token is refused too — the limit is per token, not per password
    const rightButLimited = await unlockShareAction(limitedToken, null, form(PASSWORD));
    expect(rightButLimited).toMatchObject({ ok: false, code: "rate_limited", message: SHARE_FAILURE_MESSAGE });
  });

  it("an empty / missing password never reaches the RPC and gets the identical sentence", async () => {
    const empty = await unlockShareAction(goodToken, null, form(""));
    expect(empty).toMatchObject({ ok: false, message: SHARE_FAILURE_MESSAGE });
    const missing = await unlockShareAction(goodToken, null, form());
    expect(missing).toMatchObject({ ok: false, message: SHARE_FAILURE_MESSAGE });
    // …and the action's failure sentence is the one constant, with no code, digest or retry-after in it
    expect(SHARE_FAILURE_MESSAGE).toBe("This link is not available or the password is incorrect.");
  });

  it("the correct password unlocks one aggregate row with a campaign name and no ids, brand or spend", async () => {
    const res = await unlockShareAction(goodToken, null, form(PASSWORD));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.status).toBe("ok");
    expect(typeof res.data.campaign_name).toBe("string");
    expect(res.data.campaign_name.length).toBeGreaterThan(0);
    expect(typeof res.data.reported_sent).toBe("number");
    expect(Object.keys(res.data).sort()).toEqual([...OK_KEYS].sort());
    for (const forbidden of ["id", "campaign_id", "brand_id", "spend", "token_hash", "password_hash"]) {
      expect(res.data).not.toHaveProperty(forbidden);
    }
    const captions = res.data.captions as Record<string, string>;
    expect(captions.source).toBe("as reported by the source");
    for (const key of ["delivered_rate", "bounce_rate", "open_rate", "click_rate", "unsubscribe_rate"]) {
      expect(typeof captions[key]).toBe("string");
    }
  });

  it("the form action reads the token from the hidden field and is the same door", async () => {
    const fd = form(WRONG);
    fd.append("token", goodToken);
    expect(await unlockShareFormAction(null, fd)).toMatchObject({ ok: false, code: "share_denied", message: SHARE_FAILURE_MESSAGE });
    const noToken = await unlockShareFormAction(null, form(PASSWORD));
    expect(noToken).toMatchObject({ ok: false, message: SHARE_FAILURE_MESSAGE });
    const good = form(PASSWORD);
    good.append("token", goodToken);
    const res = await unlockShareFormAction(null, good);
    expect(res.ok).toBe(true);
  });

  it("a password with its leading spaces stripped is a different password", async () => {
    const trimmed = await unlockShareAction(goodToken, null, form(PASSWORD.trim()));
    expect(trimmed).toMatchObject({ ok: false, code: "share_denied", message: SHARE_FAILURE_MESSAGE });
  });

  it("after the owner revokes the link, the correct password is denied with the same sentence", async () => {
    const { error } = await owner.supabase.rpc("revoke_share_link", { p_id: goodLinkId });
    expect(error).toBeNull();
    const { data: row } = await owner.supabase.from("v_share_links").select("status").eq("id", goodLinkId).single();
    expect(row?.status).toBe("revoked");

    const res = await unlockShareAction(goodToken, null, form(PASSWORD));
    expect(res).toMatchObject({ ok: false, code: "share_denied", message: SHARE_FAILURE_MESSAGE });
  });

  it.each(["share_links", "campaigns", "contacts"] as const)("anon: select on %s is refused by PostgREST (42501)", async (table) => {
    const { data, error } = await anon.from(table).select("*").limit(1);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("anon: create_share_link is refused", async () => {
    const { error } = await anon.rpc("create_share_link", { p_campaign_id: campaignId, p_password: PASSWORD });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("the anon client carries no session and does not persist one", async () => {
    const { data } = await anon.auth.getSession();
    expect(data.session).toBeNull();
  });
});
