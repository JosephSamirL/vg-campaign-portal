import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `/dashboard` page contract (Story 3.2): the async server component rendered with a
 * recording Supabase mock. One canned result per relation. Assertions pin the AC: captions
 * come from `metric_rules` rows (never literals), per-section error states carry no number,
 * the chart has 30 bars, rates print unclamped, nulls dash, empty states are sentences.
 */

type Result = { data: unknown; error: unknown; count?: number | null };
const responses: Record<string, Result | Result[]> = {};
const calls: Record<string, Array<[string, unknown[]]>> = {};

function builder(table: string) {
  calls[table] ??= [];
  const chain: Record<string, unknown> = {};
  const record = (method: string) =>
    (...args: unknown[]) => {
      calls[table].push([method, args]);
      return chain;
    };
  for (const m of ["select", "eq", "lt", "order", "limit", "maybeSingle"]) chain[m] = record(m);
  chain.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => {
    const r = responses[table];
    const result = Array.isArray(r) ? r.shift() : r;
    return Promise.resolve(result ?? { data: null, error: { message: `no mock for ${table}` } }).then(resolve, reject);
  };
  return chain;
}

const from = vi.fn((table: string) => builder(table));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { default: DashboardPage, instant } = await import("../app/(portal)/dashboard/page");

const KEYS = [
  "total_customers",
  "contactable",
  "signups_30d",
  "delivered_rate",
  "bounce_rate",
  "open_rate",
  "click_rate",
  "unsubscribe_rate",
  "recipients",
];
// Deliberately NOT the PRD text: proves the page prints the row, not a literal.
const rules = KEYS.map((key) => ({
  key,
  label: `Label ${key}`,
  rule_text: `Rule text for ${key} from the table`,
  alternative_text: `Alt for ${key}`,
}));

const days = Array.from({ length: 30 }, (_, i) => ({
  day: new Date(Date.UTC(2026, 7, 17 + i)).toISOString().slice(0, 10),
  signups: 0,
  window_start: "2026-08-17",
  window_end: "2026-09-15",
  future_dated_count: 0,
}));

const kileleDays = days.map((d, i) => ({ ...d, signups: i === 3 ? 66 : i === 10 ? 12 : 0, future_dated_count: 88 }));

const campaign = (over: Record<string, unknown>) => ({
  brand_id: "b",
  campaign_id: "11111111-1111-4111-8111-111111111111",
  external_id: "KIL-0016",
  name: "Promo KIL-0016",
  channel: "email",
  sent_at: "2026-02-09T00:08:45+00:00",
  spend: 120,
  target_country: null,
  source: "reported",
  send_id: null,
  sent: 10640,
  delivered: 10108,
  bounced: 532,
  opens: 12679,
  clicks: 2291,
  unsubscribes: null,
  delivered_rate: 95,
  bounce_rate: 5,
  open_rate: 119.16,
  click_rate: 21.53,
  unsubscribe_rate: null,
  ...over,
});

const performance = [
  campaign({}),
  campaign({ campaign_id: "22222222-2222-4222-8222-222222222222", external_id: "KIL-0033", name: "Zero send", channel: "sms", sent_at: "2026-01-01T00:00:00+00:00", sent: 0, delivered: 0, bounced: 0, opens: 0, clicks: 0, delivered_rate: null, bounce_rate: null, open_rate: null, click_rate: null }),
];

function ok() {
  responses.metric_rules = { data: rules, error: null };
  responses.v_dashboard_totals = { data: { total_customers: 82205, contactable: 51298 }, error: null };
  responses.v_signups_30d = { data: kileleDays, error: null };
  responses.v_campaign_performance = { data: performance, error: null };
}

async function render() {
  return renderToStaticMarkup(await DashboardPage());
}

beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  for (const k of Object.keys(calls)) delete calls[k];
  from.mockClear();
});

describe("/dashboard (Kilele-shaped data)", () => {
  it("opts out of the static shell (Next 16 Cache Components' force-dynamic)", () => {
    expect(instant).toBe(false);
  });

  it("renders the two tiles with metric_rules labels and rule_text captions (never literals)", async () => {
    ok();
    const html = await render();
    expect(html).toContain("82,205");
    expect(html).toContain("51,298");
    expect(html).toContain("Label total_customers");
    expect(html).toContain("Label contactable");
    expect(html).toContain("Rule text for total_customers from the table");
    expect(html).toContain("Rule text for contactable from the table");
    expect(html).not.toContain("Loaded contacts of the brand");
    expect((html.match(/data-testid="metric-tile"/g) ?? []).length).toBe(2);
  });

  it("renders the chart: 30 bars in day order, window label, future-dated caption, signups_30d caption", async () => {
    ok();
    const html = await render();
    const bars = html.match(/<rect[^>]*data-day="[^"]+"/g) ?? [];
    expect(bars).toHaveLength(30);
    expect(bars.map((b) => b.match(/data-day="([^"]+)"/)![1])).toEqual(days.map((d) => d.day));
    expect(html).toContain("2026-08-17 – 2026-09-15 (UTC)");
    expect(html).toContain("88 future-dated signups excluded");
    expect(html).toContain("Rule text for signups_30d from the table");
    expect(html).toContain("<title>2026-08-20: 66</title>");
    expect(html).toContain("Label signups_30d");
  });

  it("renders the performance table newest first, rates unclamped, null rates as —, each rate column captioned from its rule", async () => {
    ok();
    const html = await render();
    expect(calls.v_campaign_performance).toEqual([
      ["select", ["*"]],
      ["eq", ["source", "reported"]],
      ["order", ["sent_at", { ascending: false, nullsFirst: false }]],
    ]);
    expect(html).toContain("as reported by the source");
    expect(html).toContain("119.16%");
    expect(html).not.toContain("100.00%");
    expect(html).toContain("95.00%");
    expect(html).toContain("21.53%");
    expect(html).toContain('href="/campaigns/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain("Promo KIL-0016");
    expect(html).toContain("09 Feb 2026");
    expect(html).toContain("10,640");
    // channel badge
    expect(html).toMatch(/<div[^>]*>email<\/div>/);
    // order: KIL-0016 (Feb) before KIL-0033 (Jan)
    expect(html.indexOf("Promo KIL-0016")).toBeLessThan(html.indexOf("Zero send"));
    // zero-sent campaign: every rate is a dash, sent shows 0
    const zeroRow = html.slice(html.indexOf("Zero send"));
    expect(zeroRow.match(/>—</g)!.length).toBeGreaterThanOrEqual(5);
    // unsubscribe_rate is null on every reported row
    expect(html.match(/>—</g)!.length).toBeGreaterThanOrEqual(6);
    // column captions from metric_rules
    for (const key of ["delivered_rate", "bounce_rate", "open_rate", "click_rate", "unsubscribe_rate"]) {
      expect(html).toContain(`Rule text for ${key} from the table`);
      expect(html).toContain(`Label ${key}`);
    }
    expect(html).not.toContain("Rule text for recipients");
  });
});

describe("/dashboard empty-but-real states", () => {
  it("no totals row → tiles show 0 with 'No contacts loaded yet'", async () => {
    ok();
    responses.v_dashboard_totals = { data: null, error: null };
    const html = await render();
    expect((html.match(/data-state="empty"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html.match(/data-testid="metric-value"[^>]*>0</g)).toHaveLength(2);
    expect((html.match(/No contacts loaded yet/g) ?? []).length).toBe(2);
    expect(html).not.toContain('role="alert"');
  });

  it("Marrakech-shaped window → '0 signups in the last 30 days — last signup 17 Apr 2026', muted, not an alert", async () => {
    ok();
    responses.v_dashboard_totals = { data: { total_customers: 918, contactable: 449 }, error: null };
    responses.v_signups_30d = { data: days, error: null };
    responses.v_contacts = { data: { signup_at: "2026-04-17T21:32:47+00:00" }, error: null };
    const html = await render();
    expect(html).toMatch(/role="status"[^>]*>0 signups in the last 30 days — last signup 17 Apr 2026</);
    expect(html).toContain("2026-08-17 – 2026-09-15 (UTC)");
    expect(html).not.toContain("future-dated");
    expect(html).not.toContain('role="alert"');
    expect(calls.v_contacts[1]).toEqual(["lt", ["signup_at", "2026-09-16T00:00:00.000Z"]]);
  });

  it("no campaigns → 'No campaigns loaded yet'", async () => {
    ok();
    responses.v_campaign_performance = { data: [], error: null };
    const html = await render();
    expect(html).toContain("No campaigns loaded yet");
    expect(html).not.toContain("as reported by the source");
  });
});

describe("/dashboard error states (per section, never a 0)", () => {
  it("failed totals → both tiles show a Retry alert and no number; chart and table still render", async () => {
    ok();
    responses.v_dashboard_totals = { data: null, error: { message: 'relation "public.v_dashboard_totals" does not exist', code: "42P01" } };
    const html = await render();
    expect((html.match(/data-state="error"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('data-testid="metric-value"');
    expect(html).toContain("does not exist");
    expect((html.match(/>Retry</g) ?? []).length).toBe(2);
    // the rest of the page is intact
    expect((html.match(/<rect[^>]*data-day=/g) ?? []).length).toBe(30);
    expect(html).toContain("119.16%");
  });

  it("failed signups → the chart area is an alert with Retry, no bars, no window", async () => {
    ok();
    responses.v_signups_30d = { data: null, error: { message: "signups view broken" } };
    const html = await render();
    expect(html).toContain("signups view broken");
    expect(html).not.toContain("data-day=");
    expect(html).not.toContain("(UTC)");
    expect(html).toContain("82,205");
  });

  it("failed performance → the table section is an alert with Retry, no rates", async () => {
    ok();
    responses.v_campaign_performance = { data: null, error: { message: "performance view broken" } };
    const html = await render();
    expect(html).toContain("performance view broken");
    expect(html).not.toContain("119.16%");
    expect(html).not.toContain("as reported by the source");
    expect(html).toContain("82,205");
  });

  it("failed metric_rules → every captioned section is an error (captions are never made up)", async () => {
    ok();
    responses.metric_rules = { data: null, error: { message: "rules unreadable" } };
    const html = await render();
    expect(html).toContain("rules unreadable");
    expect(html).not.toContain("82,205");
    expect(html).not.toContain("data-day=");
    expect(html).not.toContain("119.16%");
    expect(html).not.toContain("Loaded contacts of the brand");
  });
});
