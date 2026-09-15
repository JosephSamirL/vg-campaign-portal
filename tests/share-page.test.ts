import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Story 5.3 — the stranger's page as it renders (AC1, AC3, AC4, AC6). Pure server renders:
 * `useActionState` is replaced so the three states of the form (idle, pending, failed) and the
 * success swap can be painted without a browser. Assertions pin the contract: nothing about the
 * link is revealed on GET (no token, no brand, no campaign, no existence hint), every failure is
 * the same sentence in the same alert, the card lists exactly the RPC's fields and never an id or
 * spend, and `error.tsx` prints neither the message nor the URL.
 */

type Action = { state: unknown; pending: boolean };
const hook: Action = { state: null, pending: false };
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: () => [hook.state, () => {}, hook.pending] };
});
// The action module only builds a Supabase client on call; its identity is all the form needs here.
vi.mock("@/app/(public)/share/[token]/actions", () => ({ unlockShareAction: vi.fn(), unlockShareFormAction: vi.fn() }));
// `Button` → a recorder so the error boundary's onClick identity can be asserted without a DOM.
const clicks: unknown[] = [];
vi.mock("@/components/ui/button", () => ({
  Button: ({ onClick, children, disabled, type }: { onClick?: unknown; children?: React.ReactNode; disabled?: boolean; type?: string }) => {
    clicks.push(onClick);
    return createElement("button", { "data-testid": "share-button", disabled, type }, children);
  },
}));

const TOKEN = "kZ9x-Q3vT7pL0aBcDeFgHiJkLmNoPqRsTuVwXyZ01234";
const FAILURE = "This link is not available or the password is incorrect.";

const { default: SharePage, instant, metadata } = await import("../app/(public)/share/[token]/page");
const { default: ShareError } = await import("../app/(public)/share/[token]/error");
const { ShareUnlockForm } = await import("../components/share/share-unlock-form");
const { SharedResultsCard } = await import("../components/share/shared-results-card");

const row = {
  status: "ok",
  campaign_name: "Promo KIL-0016",
  channel: "email",
  sent_at: "2026-02-09T00:08:45+00:00",
  reported_sent: 10640,
  reported_delivered: 10214,
  reported_bounced: 426,
  reported_opens: 12679,
  reported_clicks: 1183,
  delivered_rate: 96,
  bounce_rate: 4,
  open_rate: 119.16,
  click_rate: 11.12,
  unsubscribe_rate: null as unknown as number,
  captions: {
    delivered_rate: "Delivered ÷ sent, **one per contact**",
    bounce_rate: "Bounced ÷ sent",
    open_rate: "Opens ÷ delivered; total opens, so it can exceed 100 %",
    click_rate: "Clicks ÷ delivered",
    unsubscribe_rate: "Unsubscribes ÷ delivered",
    source: "as reported by the source",
  },
};

beforeEach(() => {
  hook.state = null;
  hook.pending = false;
  clicks.length = 0;
});

describe("/share/[token] page (GET)", () => {
  it("opts out of the static shell and asks robots to stay away", () => {
    expect(instant).toBe(false);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("renders only the password form — no token, no brand, no campaign, no existence hint, no database read", async () => {
    const html = renderToStaticMarkup(await SharePage({ params: Promise.resolve({ token: TOKEN }) }));
    expect(html).toContain("Campaign results");
    expect(html).toContain("Enter the password you were given.");
    expect(html).toMatch(/<input[^>]*type="password"[^>]*/);
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toMatch(/autocapitalize="off"/i);
    expect(html).toMatch(/autocorrect="off"/i);
    expect(html).toMatch(/spellcheck="false"/i);
    // the token rides only in the hidden field that feeds the action — never in visible text
    expect(html.replace(/<input type="hidden" name="token" value="[^"]*"\/>/, "")).not.toContain(TOKEN.slice(0, 12));
    expect(html).not.toMatch(/role="alert"/);
    expect(html).not.toMatch(/Kilele|KIL-|brand|expires|expiry|revoked|Forgot|Request access|Contact the owner/i);
  });
});

describe("ShareUnlockForm", () => {
  it("pending: field and button are disabled with a spinner", () => {
    hook.pending = true;
    const html = renderToStaticMarkup(createElement(ShareUnlockForm, { token: TOKEN }));
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("animate-spin");
  });

  it.each([
    ["share_denied", "share_denied"],
    ["rate_limited", "rate_limited"],
    ["invalid_input", "invalid_input"],
    ["unavailable", "unavailable"],
  ])("failure %s: one identical alert, no code, no retry-after, same tree", (_name, code) => {
    hook.state = { ok: false, code, message: FAILURE };
    const html = renderToStaticMarkup(createElement(ShareUnlockForm, { token: TOKEN }));
    expect(html).toContain(FAILURE);
    expect(html).toMatch(/role="alert"/);
    expect(html).not.toContain(code);
    expect(html).not.toMatch(/retry|wait|minute|too many|attempt/i);
    // the password field is still there (cleared by the form reset) and nothing else changed
    expect(html).toMatch(/<input[^>]*type="password"/);
  });

  it("every failure code renders byte-identical markup", () => {
    const paint = (code: string) => {
      hook.state = { ok: false, code, message: FAILURE };
      return renderToStaticMarkup(createElement(ShareUnlockForm, { token: TOKEN }));
    };
    const denied = paint("share_denied");
    expect(paint("rate_limited")).toBe(denied);
    expect(paint("invalid_input")).toBe(denied);
    expect(paint("unavailable")).toBe(denied);
  });

  it("success: swaps to the results card and drops the form", () => {
    hook.state = { ok: true, data: row };
    const html = renderToStaticMarkup(createElement(ShareUnlockForm, { token: TOKEN }));
    expect(html).toContain('data-testid="shared-results-card"');
    expect(html).toContain("Promo KIL-0016");
    expect(html).not.toMatch(/<input[^>]*type="password"/);
    expect(html).not.toContain(TOKEN);
  });
});

describe("SharedResultsCard", () => {
  it("renders the campaign, channel, formatted date, the five counts, the five rates with captions, and the source line", () => {
    const html = renderToStaticMarkup(createElement(SharedResultsCard, { data: row }));
    expect(html).toContain("Promo KIL-0016");
    expect(html).toContain("email");
    expect(html).toContain("09 Feb 2026, 00:08 UTC");
    for (const n of ["10,640", "10,214", "426", "12,679", "1,183"]) expect(html).toContain(n);
    expect(html).toContain("96.00%");
    expect(html).toContain("4.00%");
    expect(html).toContain("119.16%"); // unclamped, as-is
    expect(html).toContain("11.12%");
    // unsubscribe_rate null → a dash, still captioned
    expect(html).toMatch(/data-testid="rate-unsubscribe_rate"[^>]*>[\s\S]*?—/);
    expect(html).toContain("Unsubscribes ÷ delivered");
    // captions come from the row (rule_text markup rendered), never literals
    expect(html).toContain("<strong>one per contact</strong>");
    expect(html).toContain("total opens, so it can exceed 100 %");
    expect(html).toContain("as reported by the source");
  });

  it("never prints ids, brand, spend or anything outside the row", () => {
    const leaky = { ...row, id: "11111111-1111-4111-8111-111111111111", brand_id: "bbbbbbbb-1111-4111-8111-111111111111", spend: 120, campaign_id: "cccccccc-1111-4111-8111-111111111111" };
    const html = renderToStaticMarkup(createElement(SharedResultsCard, { data: leaky as unknown as typeof row }));
    expect(html).not.toContain("11111111");
    expect(html).not.toContain("bbbbbbbb");
    expect(html).not.toContain("cccccccc");
    expect(html).not.toMatch(/120(?!,)/);
    expect(html).not.toMatch(/spend/i);
  });

  it("tolerates missing captions and null values without crashing or inventing numbers", () => {
    const sparse = { ...row, captions: null as unknown as typeof row.captions, sent_at: null as unknown as string, reported_opens: null as unknown as number };
    const html = renderToStaticMarkup(createElement(SharedResultsCard, { data: sparse }));
    expect(html).toContain('data-testid="shared-results-card"');
    expect(html).toContain("—");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });
});

describe("/share/[token] error boundary", () => {
  it("prints the fixed sentence with Try again wired to `retry`, and neither the message, the URL nor the token", () => {
    const retry = vi.fn();
    const reset = vi.fn();
    const error = Object.assign(new Error(`fetch failed for /share/${TOKEN}`), { digest: "abc123" });
    const html = renderToStaticMarkup(createElement(ShareError, { error, retry, reset } as never));
    expect(html).toContain("Something broke on our side — nothing was changed.");
    expect(html).toMatch(/data-testid="share-button"[^>]*>Try again</);
    expect(clicks).toEqual([retry]);
    expect(clicks[0]).not.toBe(reset);
    expect(html).not.toContain("fetch failed");
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("/share/");
    expect(html).not.toContain("abc123");
  });
});
