import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDate, formatInt, formatPercent, formatUtcDate } from "../lib/format";
import { METRIC_KEYS, REPORTED_SOURCE_CAPTION } from "../lib/rules/keys";
import { getMetricRules } from "../lib/rules/metric-rules";
import { getDashboardData } from "../lib/queries/dashboard";

/*
 * Story 3.2 helpers: display formatting, the metric_rules lookup, and the dashboard query
 * bundle. The Supabase mock records every builder call so the query shapes in the story's
 * Dev Notes are pinned, and answers per table (or per call, when given a queue).
 */

describe("format helpers (3.2)", () => {
  it("formatInt groups thousands", () => {
    expect(formatInt(82205)).toBe("82,205");
    expect(formatInt(0)).toBe("0");
    expect(formatInt(918)).toBe("918");
  });

  it("formatPercent renders two decimals, never clamps, and dashes null", () => {
    expect(formatPercent(119.16)).toBe("119.16%");
    expect(formatPercent(124.54)).toBe("124.54%");
    expect(formatPercent(95)).toBe("95.00%");
    expect(formatPercent(0)).toBe("0.00%");
    expect(formatPercent(null)).toBe("—");
  });

  it("formatDate renders the UTC calendar date with year", () => {
    expect(formatDate("2026-04-17T21:32:47+00:00")).toBe("17 Apr 2026");
    // 23:45 UTC stays on the 17th whatever the process time zone
    expect(formatDate("2026-04-17T23:45:41+00:00")).toBe("17 Apr 2026");
    expect(formatDate("2026-08-17")).toBe("17 Aug 2026");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("nope")).toBe("—");
  });

  it("formatUtcDate renders a short UTC day label for chart axes", () => {
    expect(formatUtcDate("2026-08-17")).toBe("17 Aug");
    expect(formatUtcDate("2026-09-01")).toBe("01 Sep");
    expect(formatUtcDate("2026-12-31T23:59:59Z")).toBe("31 Dec");
    expect(formatUtcDate(null)).toBe("—");
  });
});

describe("rules/keys", () => {
  it("lists the nine PRD §5 keys and the reported-source caption", () => {
    expect([...METRIC_KEYS].sort()).toEqual(
      [
        "bounce_rate",
        "click_rate",
        "contactable",
        "delivered_rate",
        "open_rate",
        "recipients",
        "signups_30d",
        "total_customers",
        "unsubscribe_rate",
      ].sort(),
    );
    expect(REPORTED_SOURCE_CAPTION).toBe("as reported by the source");
  });
});

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = { from } as any;

const RULE_KEYS = [...METRIC_KEYS];
const rules = RULE_KEYS.map((key) => ({ key, label: `L ${key}`, rule_text: `R ${key}`, alternative_text: `A ${key}` }));
const days = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 7, 17 + i));
  return {
    day: d.toISOString().slice(0, 10),
    signups: 0,
    window_start: "2026-08-17",
    window_end: "2026-09-15",
    future_dated_count: 0,
  };
});

beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  for (const k of Object.keys(calls)) delete calls[k];
  from.mockClear();
});

describe("getMetricRules", () => {
  it("selects every row and indexes it by key", async () => {
    responses.metric_rules = { data: rules, error: null };
    const r = await getMetricRules(supabase);
    expect(calls.metric_rules).toEqual([["select", ["*"]]]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.open_rate.rule_text).toBe("R open_rate");
      expect(r.data.recipients.alternative_text).toBe("A recipients");
    }
  });

  it("maps a Supabase error to { ok:false }", async () => {
    responses.metric_rules = { data: null, error: { message: "permission denied", code: "42501" } };
    const r = await getMetricRules(supabase);
    expect(r).toEqual({ ok: false, message: "permission denied" });
  });

  it("is an error, not a fallback, when a key is missing", async () => {
    responses.metric_rules = { data: rules.filter((x) => x.key !== "contactable"), error: null };
    const r = await getMetricRules(supabase);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("contactable");
  });
});

describe("getDashboardData", () => {
  it("runs the four selects with the story's shapes and narrows nullable view columns", async () => {
    responses.metric_rules = { data: rules, error: null };
    responses.v_dashboard_totals = { data: { total_customers: 82205, contactable: 51298 }, error: null };
    responses.v_signups_30d = {
      data: days.map((d, i) => ({ ...d, signups: i === 3 ? 66 : 0, future_dated_count: 88 })),
      error: null,
    };
    responses.v_campaign_performance = {
      data: [{ campaign_id: "c1", external_id: "KIL-0016", name: "Promo", open_rate: 119.16, sent_at: "2026-02-09T00:08:45+00:00" }],
      error: null,
    };
    const d = await getDashboardData(supabase);

    expect(calls.v_dashboard_totals).toEqual([["select", ["total_customers, contactable"]], ["maybeSingle", []]]);
    expect(calls.v_signups_30d).toEqual([
      ["select", ["day, signups, window_start, window_end, future_dated_count"]],
      ["order", ["day"]],
    ]);
    expect(calls.v_campaign_performance).toEqual([
      ["select", ["*"]],
      ["eq", ["source", "reported"]],
      ["order", ["sent_at", { ascending: false, nullsFirst: false }]],
    ]);
    // no last-signup lookup when the window has signups
    expect(from).not.toHaveBeenCalledWith("v_contacts");

    expect(d.totals).toEqual({ ok: true, data: { total_customers: 82205, contactable: 51298 } });
    expect(d.signups.ok).toBe(true);
    if (d.signups.ok) {
      expect(d.signups.data.days).toHaveLength(30);
      expect(d.signups.data.days[3]).toEqual({ day: "2026-08-20", signups: 66 });
      expect(d.signups.data.window_start).toBe("2026-08-17");
      expect(d.signups.data.window_end).toBe("2026-09-15");
      expect(d.signups.data.future_dated_count).toBe(88);
      expect(d.signups.data.last_signup_at).toBeNull();
    }
    expect(d.performance.ok).toBe(true);
    if (d.performance.ok) expect(d.performance.data[0].open_rate).toBe(119.16);
    expect(d.rules.ok).toBe(true);
  });

  it("returns null totals (empty, not error) when the brand has no totals row", async () => {
    responses.metric_rules = { data: rules, error: null };
    responses.v_dashboard_totals = { data: null, error: null };
    responses.v_signups_30d = { data: days, error: null };
    responses.v_campaign_performance = { data: [], error: null };
    responses.v_contacts = { data: null, error: null };
    const d = await getDashboardData(supabase);
    expect(d.totals).toEqual({ ok: true, data: null });
    expect(d.performance).toEqual({ ok: true, data: [] });
    if (d.signups.ok) expect(d.signups.data.last_signup_at).toBeNull();
  });

  it("looks up the last signup (before the window end + 1 day) only when the window sums to 0", async () => {
    responses.metric_rules = { data: rules, error: null };
    responses.v_dashboard_totals = { data: { total_customers: 918, contactable: 449 }, error: null };
    responses.v_signups_30d = { data: days, error: null };
    responses.v_campaign_performance = { data: [], error: null };
    responses.v_contacts = { data: { signup_at: "2026-04-17T21:32:47+00:00" }, error: null };
    const d = await getDashboardData(supabase);
    expect(calls.v_contacts).toEqual([
      ["select", ["signup_at"]],
      ["lt", ["signup_at", "2026-09-16T00:00:00.000Z"]],
      ["order", ["signup_at", { ascending: false, nullsFirst: false }]],
      ["limit", [1]],
      ["maybeSingle", []],
    ]);
    expect(d.signups.ok).toBe(true);
    if (d.signups.ok) {
      expect(d.signups.data.last_signup_at).toBe("2026-04-17T21:32:47+00:00");
      expect(d.signups.data.days.every((x) => x.signups === 0)).toBe(true);
    }
  });

  it("keeps a failed section isolated: its Result is { ok:false } and the others still succeed", async () => {
    responses.metric_rules = { data: rules, error: null };
    responses.v_dashboard_totals = { data: null, error: { message: "relation \"v_dashboard_totals\" does not exist", code: "42P01" } };
    responses.v_signups_30d = { data: days, error: null };
    responses.v_campaign_performance = { data: null, error: { message: "boom" } };
    responses.v_contacts = { data: null, error: { message: "contacts down" } };
    const d = await getDashboardData(supabase);
    expect(d.totals).toEqual({ ok: false, message: 'relation "v_dashboard_totals" does not exist' });
    expect(d.performance).toEqual({ ok: false, message: "boom" });
    // the last-signup lookup failing poisons only the signups section
    expect(d.signups).toEqual({ ok: false, message: "contacts down" });
    expect(d.rules.ok).toBe(true);
  });

  it("treats an empty signups result as a failed section (the view always yields 30 rows)", async () => {
    responses.metric_rules = { data: rules, error: null };
    responses.v_dashboard_totals = { data: null, error: null };
    responses.v_signups_30d = { data: [], error: null };
    responses.v_campaign_performance = { data: [], error: null };
    const d = await getDashboardData(supabase);
    expect(d.signups.ok).toBe(false);
  });
});
