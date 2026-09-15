import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../lib/database.types";

/**
 * Story 5.2 — the share components' markup contracts (AC1, AC2, AC3, AC5, AC6). Pure server
 * renders, as in Story 4.4: the client components hydrate their handlers in the browser, so here
 * the markup is the first paint — the closed dialog with its password / expiry fields, the URL
 * panel with the link exactly once, the list with one Revoke per active row for an owner and
 * none for an analyst. The pure helpers (`datetime-local` → ISO, relative → absolute URL) are
 * unit-tested directly.
 */

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {} }),
}));
// The server actions import `next/headers`; the components only need their identities here.
vi.mock("@/app/(portal)/campaigns/[id]/actions", () => ({
  createShareLinkAction: vi.fn(),
  revokeShareLinkAction: vi.fn(),
}));

const { ShareLinkForm, ShareLinkCreatedPanel, toExpiresAt, absoluteShareUrl } = await import("../components/share/share-link-form");
const { ShareLinkList, ShareLinkStatusBadge } = await import("../components/share/share-link-list");

type ShareLinkRow = Database["public"]["Views"]["v_share_links"]["Row"];

const CAMPAIGN = "c7d9869d-ae35-400e-9777-f8cf725e2103";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const URL_ = `https://vg-campaign-portal.vercel.app/share/${TOKEN}`;

const base: ShareLinkRow = {
  id: "3f7a1b2c-9d8e-4f60-a1b2-c3d4e5f60718",
  brand_id: "b",
  campaign_id: CAMPAIGN,
  created_by: "u",
  created_at: "2026-09-15T09:51:00+00:00",
  expires_at: null,
  revoked_at: null,
  status: "active",
};

describe("ShareLinkForm — the Publish button and the closed dialog (AC1, AC6)", () => {
  it("renders 'Publish results', a closed dialog with a password field (no trim, no autocomplete help) and an optional datetime-local expiry", () => {
    const html = renderToStaticMarkup(createElement(ShareLinkForm, { campaignId: CAMPAIGN, campaignLabel: "Nairobi launch" }));
    expect(html).toMatch(/<button[^>]*data-testid="publish-button"[^>]*>Publish results<\/button>/);
    expect(html).not.toMatch(/<button[^>]*data-testid="publish-button"[^>]*disabled/);
    expect(html).toContain("<dialog");
    expect(html).not.toContain(" open");
    expect(html).toContain('data-testid="share-link-dialog"');
    expect(html).toContain("Publish results for Nairobi launch");
    // the password field, exactly as the story specifies it
    expect(html).toMatch(/<input[^>]*type="password"[^>]*/);
    expect(html).toMatch(/<input[^>]*name="password"[^>]*/);
    expect(html).toMatch(/<input[^>]*autocomplete="new-password"[^>]*/i);
    expect(html).toMatch(/<input[^>]*autocapitalize="off"[^>]*/i);
    expect(html).toMatch(/<input[^>]*autocorrect="off"[^>]*/i);
    expect(html).toMatch(/<input[^>]*spellcheck="false"[^>]*/i);
    expect(html).toContain("At least 8 characters. Spaces count.");
    // the optional expiry
    expect(html).toMatch(/<input[^>]*type="datetime-local"[^>]*/);
    expect(html).toMatch(/<input[^>]*name="expires_at"[^>]*/);
    expect(html).not.toMatch(/<input[^>]*name="expires_at"[^>]*required/);
    // the submit is enabled on the first paint, and there is no URL panel yet
    expect(html).toMatch(/<button[^>]*data-testid="share-link-submit"/);
    expect(html).not.toMatch(/<button[^>]*data-testid="share-link-submit"[^>]*disabled/);
    expect(html).not.toContain("share-link-url");
    expect(html).not.toContain("cannot be shown again");
  });
});

describe("ShareLinkCreatedPanel — the URL shown once (AC2)", () => {
  it("shows the full URL exactly once in a read-only input, a Copy button and the 'cannot be shown again' warning; no form", () => {
    const html = renderToStaticMarkup(createElement(ShareLinkCreatedPanel, { url: URL_, onCopy: () => {} }));
    expect(html.split(URL_).length - 1).toBe(1);
    expect(html).toMatch(new RegExp(`<input[^>]*readonly=""[^>]*value="${URL_.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i"));
    expect(html).toContain('data-testid="share-link-url"');
    expect(html).toMatch(/<button[^>]*data-testid="share-link-copy"[^>]*>Copy<\/button>/);
    expect(html).toContain("Copy it now — this link cannot be shown again.");
    expect(html).not.toContain('type="password"');
  });
});

describe("share-link-form helpers", () => {
  it("toExpiresAt: empty → null, a datetime-local value → an ISO-8601 UTC instant, garbage → the sentinel the action refuses", () => {
    expect(toExpiresAt("")).toBeNull();
    expect(toExpiresAt("   ")).toBeNull();
    const iso = toExpiresAt("2027-01-01T10:00");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(iso as string).getTime()).toBe(new Date("2027-01-01T10:00").getTime());
    expect(toExpiresAt("not a date")).toBe("invalid");
  });

  it("absoluteShareUrl: an absolute URL is returned verbatim, a root-relative one gets the browser's origin", () => {
    expect(absoluteShareUrl(URL_, "https://elsewhere.example")).toBe(URL_);
    expect(absoluteShareUrl(`/share/${TOKEN}`, "http://localhost:3000")).toBe(`http://localhost:3000/share/${TOKEN}`);
  });
});

describe("ShareLinkList (AC3, AC5, AC6)", () => {
  it("renders the empty sentence and no list for no links", () => {
    const html = renderToStaticMarkup(createElement(ShareLinkList, { links: [], isOwner: true }));
    expect(html).toContain("No share links yet");
    expect(html).toContain('data-testid="empty-state"');
    expect(html).not.toContain("share-link-list");
  });

  it("lists rows in the order given with created date, expiry ('never' when null) and the view's status badge", () => {
    const links: ShareLinkRow[] = [
      { ...base, id: "l3", created_at: "2026-09-15T12:00:00+00:00", expires_at: "2026-10-01T00:00:00+00:00", status: "active" },
      { ...base, id: "l2", created_at: "2026-09-14T12:00:00+00:00", expires_at: "2026-09-15T00:00:00+00:00", status: "expired" },
      { ...base, id: "l1", created_at: "2026-09-13T12:00:00+00:00", revoked_at: "2026-09-13T13:00:00+00:00", status: "revoked" },
    ];
    const html = renderToStaticMarkup(createElement(ShareLinkList, { links, isOwner: true }));
    expect(html).toContain('data-testid="share-link-list"');
    expect(html.indexOf('data-link-id="l3"')).toBeLessThan(html.indexOf('data-link-id="l2"'));
    expect(html.indexOf('data-link-id="l2"')).toBeLessThan(html.indexOf('data-link-id="l1"'));
    expect(html).toContain("15 Sep 2026, 12:00 UTC");
    expect(html).toContain("01 Oct 2026, 00:00 UTC");
    expect(html).toContain('data-testid="share-link-expiry">never<');
    expect(html).toContain('data-testid="share-link-status" data-status="active"');
    expect(html).toContain('data-testid="share-link-status" data-status="expired"');
    expect(html).toContain('data-testid="share-link-status" data-status="revoked"');
    // the view's status column is rendered, never recomputed from revoked_at / expires_at
    expect(html).not.toContain("Invalid Date");
  });

  it("gives an owner a Revoke button on active rows only, and an analyst none at all", () => {
    const links: ShareLinkRow[] = [
      { ...base, id: "a", status: "active" },
      { ...base, id: "r", status: "revoked", revoked_at: "2026-09-13T13:00:00+00:00" },
      { ...base, id: "e", status: "expired", expires_at: "2026-09-01T00:00:00+00:00" },
    ];
    const owner = renderToStaticMarkup(createElement(ShareLinkList, { links, isOwner: true }));
    expect(owner.match(/data-testid="share-link-revoke"/g)?.length).toBe(1);
    expect(owner).not.toContain('data-testid="share-link-revoke-alert"');
    expect(owner).toMatch(/data-link-id="a"[\s\S]*?data-testid="share-link-revoke"[\s\S]*?data-link-id="r"/);
    expect(owner).toMatch(/<button[^>]*data-testid="share-link-revoke"[^>]*>Revoke<\/button>/);

    const analyst = renderToStaticMarkup(createElement(ShareLinkList, { links, isOwner: false }));
    expect(analyst).not.toContain('data-testid="share-link-revoke"');
    expect(analyst).not.toContain("Revoke<");
    expect(analyst).toContain('data-status="active"');
  });

  it("renders a badge per status value the view can emit, and a plain badge for anything else", () => {
    for (const status of ["active", "revoked", "expired"]) {
      expect(renderToStaticMarkup(createElement(ShareLinkStatusBadge, { status }))).toContain(`data-status="${status}"`);
    }
    expect(renderToStaticMarkup(createElement(ShareLinkStatusBadge, { status: null }))).toContain('data-status="unknown"');
  });
});
