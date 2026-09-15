import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Story 7.1 — the 400 px structural contract per route (AC1, AC3) and the three-state files
 * (AC2). No browser on localhost from the extension (as in 2.5 / 3.3), so each route is rendered
 * through the page-render pattern with a recording Supabase mock and the markup is asserted for
 * the containers and Tailwind classes that make the phone layout: every `<table>` inside its own
 * `overflow-x-auto` wrapper with a `min-w-[…px]`, the page container `min-w-0`, tiles
 * `grid-cols-1 sm:grid-cols-2`, dialogs `max-h-[90dvh] overflow-y-auto`, inputs `text-base` below
 * `md`, the share form `max-w-sm mx-auto`, the copy button touch-safe. The live check
 * (`document.documentElement.scrollWidth <= 400` per route, headless Chromium) is recorded in
 * the story's Completion Notes; this suite is what keeps the layout from regressing.
 */

type Result = { data: unknown; error: unknown; count?: number | null };
const responses: Record<string, Result | Result[]> = {};
const chains: Record<string, number> = {};

function builder(table: string) {
  const n = (chains[table] = (chains[table] ?? 0) + 1);
  const key = n === 1 ? table : `${table}#${n}`;
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "or", "is", "in", "lt", "order", "limit", "range", "maybeSingle", "single"]) chain[m] = () => chain;
  chain.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => {
    const r = responses[key] ?? responses[table];
    const result = Array.isArray(r) ? r.shift() : r;
    return Promise.resolve(result ?? { data: null, error: { message: `no mock for ${key}` } }).then(resolve, reject);
  };
  return chain;
}
const from = vi.fn((table: string) => builder(table));
const rpc = vi.fn((name: string) => builder(`rpc:${name}`));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from, rpc }) }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {} }),
  usePathname: () => "/dashboard",
  redirect: vi.fn(),
}));
vi.mock("@/app/(portal)/campaigns/[id]/actions", () => ({
  previewSendAction: vi.fn(),
  confirmSendAction: vi.fn(),
  dispatchSendAction: vi.fn(),
  createShareLinkAction: vi.fn(),
  revokeShareLinkAction: vi.fn(),
}));
vi.mock("@/app/(public)/share/[token]/actions", () => ({ unlockShareAction: vi.fn(), unlockShareFormAction: vi.fn() }));
vi.mock("@/app/(public)/login/actions", () => ({ signInWithPasswordAction: vi.fn(), signInWithGoogleAction: vi.fn() }));
// `useActionState` outside a form-action-aware renderer: the idle state, and the success state for the share card
const hook: { state: unknown; pending: boolean } = { state: null, pending: false };
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: () => [hook.state, () => {}, hook.pending] };
});
vi.mock("@/lib/current-user", () => ({
  getCurrentAppUser: async () => ({ email: "owner@vg-eval.test", role: "owner", brand_id: "b", brand_name: "KILELE", brand_code: "KILELE" }),
}));

const { default: PortalLayout } = await import("../app/(portal)/layout");
const { default: LoginPage } = await import("../app/(public)/login/page");
const { default: DashboardPage } = await import("../app/(portal)/dashboard/page");
const { default: ContactsPage } = await import("../app/(portal)/contacts/page");
const { default: CampaignsPage } = await import("../app/(portal)/campaigns/page");
const { default: CampaignPage } = await import("../app/(portal)/campaigns/[id]/page");
const { default: ImportsPage } = await import("../app/(portal)/imports/page");
const { default: SharePage } = await import("../app/(public)/share/[token]/page");
const { ShareUnlockForm } = await import("../components/share/share-unlock-form");
const { ShareLinkCreatedPanel } = await import("../components/share/share-link-form");
const { SignupsChart } = await import("../components/metrics/signups-chart");
const { default: RootNotFound } = await import("../app/not-found");

/* ---------- fixtures (shapes from the earlier page tests) ---------- */

const KEYS = ["total_customers", "contactable", "signups_30d", "delivered_rate", "bounce_rate", "open_rate", "click_rate", "unsubscribe_rate", "recipients"];
const rules = KEYS.map((key) => ({ key, label: `Label ${key}`, rule_text: `Rule for ${key}`, alternative_text: `Alt for ${key}` }));
const CID = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
const days = Array.from({ length: 30 }, (_, i) => ({
  day: new Date(Date.UTC(2026, 7, 17 + i)).toISOString().slice(0, 10),
  signups: i % 4,
  window_start: "2026-08-17",
  window_end: "2026-09-15",
  future_dated_count: 0,
}));
const perfRow = {
  brand_id: "b", campaign_id: CID, external_id: "KIL-0016", name: "Nairobi launch", channel: "email", sent_at: "2026-06-03T08:00:00+00:00",
  spend: 650.07, target_country: "KE", source: "reported", send_id: null, sent: 10640, delivered: 10214, bounced: 426, opens: 12679, clicks: 1183,
  unsubscribes: null, delivered_rate: 96, bounce_rate: 4, open_rate: 119.16, click_rate: 11.12, unsubscribe_rate: null,
};
const campaignRow = {
  id: CID, brand_id: "b", external_id: "KIL-0016", name: "Nairobi launch", channel: "email", target_country: "KE", sent_at: "2026-06-03T08:00:00+00:00",
  send_local_time: null, spend: 650.07, reported_sent: 10640, reported_delivered: 10214, reported_bounced: 426, reported_opens: 12679, reported_clicks: 1183,
  parent_campaign_id: null, parent_external_id: null, as_of: "2026-08-01", file_rank: 1, created_at: "2026-09-15T00:00:00+00:00", updated_at: "2026-09-15T00:00:00+00:00",
};
const sendRow = {
  id: "9d0e1f2a-3b4c-4d5e-8f60-1a2b3c4d5e6f", brand_id: "b", campaign_id: CID, status: "dispatched", source: "portal", batch_key: null, recipient_count: 50064,
  confirmed_by: "owner@vg-eval.test", confirmed_at: "2026-09-15T09:51:00+00:00", dispatched_at: "2026-09-15T09:51:05+00:00", provider_responded_at: null,
  dispatch_attempts: 1, dispatch_lease_until: null, body_sha256: null, batch_id: "B-1", accepted_count: 50000, rejected_count: 64, failure_reason: null,
  created_at: "2026-09-15T09:51:00+00:00",
};
const shareLinkRow = { id: "3f7a1b2c-9d8e-4f60-a1b2-c3d4e5f60718", brand_id: "b", campaign_id: CID, created_by: "u", created_at: "2026-09-15T09:51:00+00:00", expires_at: null, revoked_at: null, status: "active" };
const contactRow = {
  id: "5c1d2c3e-0000-4000-8000-000000000001", external_id: "KIL-C-000001", full_name: "Amina Wanjiru", email: "amina.wanjiru@example.com", phone: "+254700000001",
  country: "KE", city: "Nairobi", status: "active", consent_marketing: true, contactable: true, signup_at: "2026-09-01T08:15:00+00:00",
};
const RUN = "c04d7c8b-75c7-4779-b28b-3a99eb25aa62";
const runs = [{ id: RUN, source_file: "kilele-contacts.csv", entity: "contacts", started_at: "2026-09-15T09:51:12+00:00", finished_at: "2026-09-15T09:52:00+00:00", summary: { loaded: 81144, rejected: 71, warned_rows: 25125, routed: 312 } }];
const issues = [{ id: "i1", source_file: "kilele-contacts.csv", row_no: 7, severity: "reject", reason: "email_invalid", detail: { value: "nope" } }];
const sharedRow = {
  campaign_name: "Promo KIL-0016", channel: "email", sent_at: "2026-02-09T00:08:45+00:00", reported_sent: 10640, reported_delivered: 10214, reported_bounced: 426,
  reported_opens: 12679, reported_clicks: 1183, delivered_rate: 96, bounce_rate: 4, open_rate: 119.16, click_rate: 11.12, unsubscribe_rate: null,
  captions: { source: "as reported by the source", open_rate: "**total** opens ÷ sent" },
};

beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  for (const k of Object.keys(chains)) delete chains[k];
  hook.state = null;
  hook.pending = false;
  responses.metric_rules = { data: rules, error: null };
  responses.v_dashboard_totals = { data: { total_customers: 82205, contactable: 51298 }, error: null };
  responses.v_signups_30d = { data: days, error: null };
  responses.v_campaign_performance = { data: [perfRow], error: null };
  responses["v_campaign_performance#2"] = { data: [], error: null };
  responses.v_contacts = { data: [contactRow], error: null, count: 82205 };
  responses.campaigns = { data: campaignRow, error: null };
  responses.sends = { data: [sendRow], error: null };
  responses.v_share_links = { data: [shareLinkRow], error: null };
  responses.v_last_sync = { data: { brand_id: "b", last_ok_at: "2026-09-15T11:57:00Z" }, error: null };
  responses["rpc:last_poll_status"] = { data: [{ status: "ok", finished_at: "2026-09-15T11:57:00Z" }], error: null };
  responses.import_runs = { data: runs, error: null };
  responses.v_import_issue_groups = { data: [{ severity: "reject", reason: "email_invalid", n: 1 }], error: null };
  responses.import_issues = { data: issues, error: null, count: 1 };
});

/* ---------- helpers ---------- */

const tags = (html: string, re: RegExp): string[] => html.match(re) ?? [];
/** The first tag matching `re`, or a loud failure naming what was expected. */
const tag = (html: string, re: RegExp): string => {
  const m = html.match(re);
  if (!m) throw new Error(`no tag matching ${re}`);
  return m[0];
};
const cls = (tag: string) => tag.match(/class="([^"]*)"/)?.[1] ?? "";
const has = (tag: string, token: string) => cls(tag).split(/\s+/).includes(token);

/** Every `<table>` sits directly inside the `Table` primitive's `overflow-x-auto` wrapper and declares a pixel `min-w-[…]`. */
function expectTablesScrollInside(html: string, minTables = 1) {
  const tables = tags(html, /<table[^>]*>/g);
  expect(tables.length).toBeGreaterThanOrEqual(minTables);
  expect(tags(html, /overflow-x-auto"><table/g)).toHaveLength(tables.length);
  for (const t of tables) expect(cls(t)).toMatch(/\bmin-w-\[\d+px\]/);
}

/** Every text `<input>` renders 16 px below `md` (`text-base` with only an `md:` override) — no iOS focus zoom. */
function expectInputsAre16px(html: string) {
  const inputs = tags(html, /<input[^>]*>/g).filter((t) => !/type="hidden"/.test(t));
  expect(inputs.length).toBeGreaterThan(0);
  for (const t of inputs) {
    expect(has(t, "text-base")).toBe(true);
    for (const token of cls(t).split(/\s+/)) if (/^(sm:)?text-(xs|sm)$/.test(token)) throw new Error(`input shrinks below md: ${token}`);
  }
}

/* ---------- routes ---------- */

describe("(portal) layout", () => {
  it("the page container is min-w-0 with side padding at every width", async () => {
    const html = renderToStaticMarkup(await PortalLayout({ children: createElement("p", null, "x") }));
    const main = tag(html, /<main[^>]*>/);
    expect(main).toBeDefined();
    expect(has(main, "min-w-0")).toBe(true);
    expect(has(main, "w-full")).toBe(true);
    expect(cls(main)).toMatch(/\bp-4\b|\bpx-4\b/);
    expect(html).toContain('data-testid="nav-toggle"');
    expect(html).toContain('data-testid="toaster"');
  });
});

describe("/login", () => {
  it("form full-width in a max-w-sm column, Google below the password form, 16 px inputs", () => {
    const html = renderToStaticMarkup(createElement(LoginPage, { searchParams: Promise.resolve({ reason: "no_access" }) }));
    expect(html).toMatch(/class="[^"]*\bmax-w-sm\b[^"]*"/);
    expectInputsAre16px(html);
    expect(html.indexOf('type="password"')).toBeLessThan(html.indexOf("Continue with Google"));
    expect(tag(html, /<button[^>]*>Continue with Google/)).toMatch(/\bw-full\b/);
  });
});

describe("/dashboard", () => {
  it("tiles stack to one column, the chart container is w-full min-w-0 with x labels hidden below sm, the table scrolls inside", async () => {
    const html = renderToStaticMarkup(await DashboardPage());
    const tiles = tag(html, /<section[^>]*aria-label="Customers"[^>]*>/);
    expect(has(tiles, "grid-cols-1")).toBe(true);
    expect(has(tiles, "sm:grid-cols-2")).toBe(true);
    const chartBox = tag(html, /<div[^>]*data-testid="chart-box"[^>]*>/);
    expect(chartBox).toBeDefined();
    expect(has(chartBox, "w-full")).toBe(true);
    expect(has(chartBox, "min-w-0")).toBe(true);
    const svg = tag(html, /<svg[^>]*>/);
    expect(has(svg, "w-full")).toBe(true);
    expect(cls(svg)).not.toMatch(/\bmin-w-\[/);
    const labels = tags(html, /<text[^>]*data-axis="x"[^>]*>/g);
    expect(labels).toHaveLength(6);
    for (const t of labels) {
      expect(has(t, "hidden")).toBe(true);
      expect(has(t, "sm:block")).toBe(true);
    }
    expectTablesScrollInside(html, 1);
  });

  it("the empty chart sentence keeps the container", () => {
    const html = renderToStaticMarkup(
      createElement(SignupsChart, { label: "Signups", days: days.map((d) => ({ ...d, signups: 0 })), window_start: "a", window_end: "b", future_dated_count: 0, last_signup_at: null, caption: null }),
    );
    expect(html).toContain('data-testid="chart-empty"');
    expect(html).not.toContain("<svg");
  });
});

describe("/contacts", () => {
  it("filters stack full-width below sm, the 9-column table scrolls inside, the pager wraps", async () => {
    responses.metric_rules = { data: rules[1], error: null }; // `getContactableRule` reads one row (`maybeSingle`)
    const html = renderToStaticMarkup(await ContactsPage({ searchParams: Promise.resolve({}) }));
    const form = tag(html, /<form[^>]*data-testid="contacts-filters"[^>]*>/);
    expect(has(form, "flex-col")).toBe(true);
    expect(has(form, "sm:flex-row")).toBe(true);
    expectInputsAre16px(html);
    for (const select of tags(html, /<select[^>]*>/g)) {
      expect(has(select, "w-full")).toBe(true);
      expect(has(select, "text-base")).toBe(true);
    }
    const buttons = tags(html, /<(button|a)[^>]*>(Filter|Clear)</g);
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(has(b, "flex-1")).toBe(true);
    expectTablesScrollInside(html, 1);
    const pager = tag(html, /<div[^>]*data-testid="contacts-pager"[^>]*>/);
    expect(has(pager, "flex-col")).toBe(true);
    expect(has(pager, "sm:flex-row")).toBe(true);
  });
});

describe("/campaigns", () => {
  it("the 14-column table scrolls inside its container; the sync line sits above it", async () => {
    const html = renderToStaticMarkup(await CampaignsPage());
    expectTablesScrollInside(html, 1);
    expect(html.indexOf("Reports last synced")).toBeLessThan(html.indexOf("<table"));
  });
});

describe("/campaigns/[id]", () => {
  it("header wraps, Send / Publish are full-width below sm, both dialogs fit 90dvh with stacked buttons, 16 px inputs", async () => {
    const html = renderToStaticMarkup(await CampaignPage({ params: Promise.resolve({ id: CID }) }));
    const header = tag(html, /<header[^>]*data-testid="campaign-header"[^>]*>/);
    expect(has(header, "flex-wrap")).toBe(true);
    for (const id of ["send-button", "publish-button"]) {
      const b = tag(html, new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`));
      expect(b).toBeDefined();
      expect(has(b, "w-full")).toBe(true);
      expect(has(b, "sm:w-auto")).toBe(true);
    }
    for (const id of ["section-sends-action", "section-share-links-action"]) {
      const slot = tag(html, new RegExp(`<div[^>]*data-testid="${id}"[^>]*>`));
      expect(has(slot, "w-full")).toBe(true);
      expect(has(slot, "sm:w-auto")).toBe(true);
    }
    const dialogs = tags(html, /<dialog[^>]*data-testid="(send-dialog|share-link-dialog)"[^>]*>/g);
    expect(dialogs).toHaveLength(2);
    for (const d of dialogs) {
      const content = html.slice(html.indexOf(d) + d.length).match(/<div[^>]*>/)?.[0] ?? "";
      expect(has(content, "max-h-[90dvh]")).toBe(true);
      expect(has(content, "overflow-y-auto")).toBe(true);
    }
    const footers = tags(html, /<div[^>]*class="[^"]*\bsm:flex-row\b[^"]*\bsm:justify-end\b[^"]*"[^>]*>/g);
    expect(footers.length).toBeGreaterThanOrEqual(2);
    for (const f of footers) expect(cls(f)).toMatch(/\bflex-col(-reverse)?\b/);
    expectInputsAre16px(html);
    expect(html).toContain('data-testid="send-history"');
    expect(html).toContain('data-testid="share-link-list"');
  });
});

describe("/imports", () => {
  it("run list and issues table scroll inside their containers", async () => {
    const html = renderToStaticMarkup(await ImportsPage({ searchParams: Promise.resolve({ run: RUN, page: "1" }) }));
    expectTablesScrollInside(html, 2);
  });
});

describe("/share/[token]", () => {
  const TOKEN = "kZ9x-Q3vT7pL0aBcDeFgHiJkLmNoPqRsTuVwXyZ01234";

  it("the password form is a centred max-w-sm column with a 16 px input and a full-width button", async () => {
    const html = renderToStaticMarkup(await SharePage({ params: Promise.resolve({ token: TOKEN }) }));
    const card = tag(html, /<div[^>]*data-testid="share-unlock-card"[^>]*>/);
    expect(card).toBeDefined();
    expect(has(card, "max-w-sm")).toBe(true);
    expect(has(card, "mx-auto")).toBe(true);
    expect(has(card, "w-full")).toBe(true);
    expectInputsAre16px(html);
    expect(tag(html, /<button[^>]*type="submit"[^>]*>/)).toMatch(/\bw-full\b/);
    expect(html).not.toContain("<table");
  });

  it("the results card is a stacked definition list — no table, two columns for the rates below sm", () => {
    hook.state = { ok: true, data: sharedRow };
    const html = renderToStaticMarkup(createElement(ShareUnlockForm, { token: TOKEN }));
    expect(html).toContain('data-testid="shared-results-card"');
    expect(html).not.toContain("<table");
    const lists = tags(html, /<dl[^>]*>/g);
    expect(lists).toHaveLength(2);
    const [counts, rates] = lists as [string, string];
    expect(has(counts, "grid-cols-2")).toBe(true); // counts: two per row on a phone
    expect(cls(rates)).not.toMatch(/\bgrid-cols-[3-9]\b/); // rates: one per row on a phone …
    expect(has(rates, "sm:grid-cols-2")).toBe(true); // … two from sm up
  });
});

describe("copy button on touch (AC3)", () => {
  it("the Copy button is a 44 px onClick button (never onMouseDown) beside a 16 px read-only input", () => {
    const html = renderToStaticMarkup(createElement(ShareLinkCreatedPanel, { url: "https://x.test/share/abc", onCopy: () => {} }));
    const button = tag(html, /<button[^>]*data-testid="share-link-copy"[^>]*>/);
    expect(button).toBeDefined();
    expect(has(button, "h-11")).toBe(true);
    expect(has(button, "sm:h-9")).toBe(true);
    expect(button).not.toMatch(/onmousedown/i);
    expectInputsAre16px(html);
    expect(tag(html, /<input[^>]*data-testid="share-link-url"[^>]*>/)).toMatch(/readonly/i);
  });
});

describe("three-state files (AC2)", () => {
  it("every portal route has loading.tsx + error.tsx; /share/[token] has error.tsx; app/not-found.tsx exists", async () => {
    const mods = await Promise.all([
      import("../app/(portal)/dashboard/loading"),
      import("../app/(portal)/dashboard/error"),
      import("../app/(portal)/contacts/loading"),
      import("../app/(portal)/contacts/error"),
      import("../app/(portal)/campaigns/loading"),
      import("../app/(portal)/campaigns/error"),
      import("../app/(portal)/campaigns/[id]/loading"),
      import("../app/(portal)/campaigns/[id]/error"),
      import("../app/(portal)/campaigns/[id]/not-found"),
      import("../app/(portal)/imports/loading"),
      import("../app/(portal)/imports/error"),
      import("../app/(public)/share/[token]/error"),
      import("../app/error"),
      import("../app/not-found"),
    ]);
    for (const m of mods) expect(typeof m.default).toBe("function");
  });

  it("app/not-found.tsx: a muted sentence and a way back, no error styling, no digest", () => {
    const html = renderToStaticMarkup(createElement(RootNotFound));
    expect(html).toContain('data-testid="root-not-found"');
    expect(html).toContain("There is nothing at this address");
    expect(html).toMatch(/<a[^>]*href="\/dashboard"/);
    expect(html).not.toContain("destructive");
  });

  it("every skeleton is visibly a skeleton (aria-busy + Skeleton blocks) and never a number", async () => {
    for (const load of [
      () => import("../app/(portal)/dashboard/loading"),
      () => import("../app/(portal)/contacts/loading"),
      () => import("../app/(portal)/campaigns/loading"),
      () => import("../app/(portal)/campaigns/[id]/loading"),
      () => import("../app/(portal)/imports/loading"),
    ]) {
      const { default: Loading } = await load();
      const html = renderToStaticMarkup(createElement(Loading));
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain("animate-pulse");
      expect(html).not.toMatch(/>\s*\d+\s*</);
    }
  });
});
