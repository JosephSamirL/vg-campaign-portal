import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { errorDigest } from "../lib/error-digest";

/*
 * `components/metrics/*` (Story 3.2) — shared by the dashboard and the campaigns/contacts
 * views. They are server components rendered to static markup here; the client `RetryAlert`
 * needs the app router, which is mocked.
 */
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { MetricCaption } = await import("../components/metrics/metric-caption");
const { MetricTile } = await import("../components/metrics/metric-tile");
const { SignupsChart } = await import("../components/metrics/signups-chart");

const rule = {
  key: "contactable",
  label: "Contactable",
  rule_text: "Total customers **and** consent = true (blank/unknown = not consented) **and** status ∉ {bounced, unsubscribed} (`pending` counts as contactable)",
  alternative_text: "Consent-only, or ignoring seed events (11.9k Kilele contacts differ)",
};

const days = Array.from({ length: 30 }, (_, i) => ({
  day: new Date(Date.UTC(2026, 7, 17 + i)).toISOString().slice(0, 10),
  signups: 0,
}));

describe("MetricCaption", () => {
  it("renders rule_text verbatim (marking **bold** and `code` spans) without the alternative by default", () => {
    const html = renderToStaticMarkup(createElement(MetricCaption, { rule }));
    expect(html).toContain('data-metric-key="contactable"');
    expect(html).toContain("Total customers <strong>and</strong> consent = true (blank/unknown = not consented)");
    expect(html).toMatch(/<code[^>]*>pending<\/code> counts as contactable/);
    expect(html).not.toContain("Consent-only");
    expect(html).not.toContain("*");
  });

  it("with showAlternative adds 'Not: …' in a tooltip (desktop) and inline (mobile)", () => {
    const html = renderToStaticMarkup(createElement(MetricCaption, { rule, showAlternative: true }));
    expect(html).toMatch(/role="tooltip"[^>]*>Not: Consent-only, or ignoring seed events \(11\.9k Kilele contacts differ\)</);
    expect(html).toMatch(/md:hidden[^>]*>Not: Consent-only/);
  });
});

describe("MetricTile", () => {
  const caption = createElement(MetricCaption, { rule });

  it("ok: label, formatted value, caption", () => {
    const html = renderToStaticMarkup(createElement(MetricTile, { label: "Contactable", caption, state: "ok", value: 51298 }));
    expect(html).toContain('data-state="ok"');
    expect(html).toContain("Contactable");
    expect(html).toContain("51,298");
    expect(html).toContain('data-metric-key="contactable"');
  });

  it("empty: the value and a muted sentence proving the query ran", () => {
    const html = renderToStaticMarkup(
      createElement(MetricTile, { label: "Total customers", caption, state: "empty", value: 0, sentence: "No contacts loaded yet" }),
    );
    expect(html).toContain('data-state="empty"');
    expect(html).toMatch(/<[^>]*data-testid="metric-value"[^>]*>0</);
    expect(html).toMatch(/role="status"[^>]*>No contacts loaded yet</);
    expect(html).not.toContain('role="alert"');
  });

  it("error: a destructive alert with Retry, no number and no caption text", () => {
    const html = renderToStaticMarkup(
      createElement(MetricTile, { label: "Contactable", caption, state: "error", message: 'relation "v_dashboard_totals" does not exist' }),
    );
    expect(html).toContain('data-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Retry");
    // generic copy + digest only: the raw message never reaches the browser
    expect(html).not.toContain("does not exist");
    expect(html).toContain(`data-digest="${errorDigest('relation "v_dashboard_totals" does not exist')}"`);
    expect(html).toContain("quote reference");
    expect(html).not.toContain('data-testid="metric-value"');
    expect(html).not.toMatch(/>0</);
  });
});

describe("SignupsChart", () => {
  const base = {
    label: "Signups per day (30d)",
    window_start: "2026-08-17",
    window_end: "2026-09-15",
    caption: createElement("span", { "data-testid": "chart-caption" }, "rule"),
  };

  it("renders exactly 30 bars in day order, heights ∝ signups / max, titles, x labels every 5th day, the UTC window label", () => {
    const data = days.map((d, i) => ({ ...d, signups: i === 3 ? 66 : i === 29 ? 33 : 0 }));
    const html = renderToStaticMarkup(
      createElement(SignupsChart, { ...base, days: data, future_dated_count: 88, last_signup_at: null }),
    );
    const bars = html.match(/<rect[^>]*data-day="[^"]+"/g) ?? [];
    expect(bars).toHaveLength(30);
    expect(bars[0]).toContain('data-day="2026-08-17"');
    expect(bars[29]).toContain('data-day="2026-09-15"');
    // the tallest bar fills the plot height, a half value is half as tall, zero is zero-height
    const height = (day: string) => Number(html.match(new RegExp(`<rect[^>]*data-day="${day}"[^>]*height="([\\d.]+)"`))![1]);
    expect(height("2026-08-20")).toBeGreaterThan(0);
    expect(height("2026-09-15")).toBeCloseTo(height("2026-08-20") / 2, 5);
    expect(height("2026-08-17")).toBe(0);
    expect(html).toContain("<title>2026-08-20: 66</title>");
    expect(html).toContain("<title>2026-08-17: 0</title>");
    // x labels: days 0, 5, …, 25 as dd MMM (UTC)
    for (const label of ["17 Aug", "22 Aug", "27 Aug", "01 Sep", "06 Sep", "11 Sep"]) expect(html).toContain(`>${label}<`);
    expect(html).not.toContain(">18 Aug<");
    expect(html).toContain("2026-08-17 – 2026-09-15 (UTC)");
    expect(html).toContain("88 future-dated signups excluded");
    expect(html).toContain('data-testid="chart-caption"');
    expect(html).not.toContain("0 signups in the last 30 days");
  });

  it("omits the future-dated caption when the count is 0", () => {
    const html = renderToStaticMarkup(
      createElement(SignupsChart, { ...base, days: days.map((d, i) => ({ ...d, signups: i })), future_dated_count: 0, last_signup_at: null }),
    );
    expect(html).not.toContain("future-dated");
  });

  it("empty window: muted sentence with the last signup date (not an alert), window label kept", () => {
    const html = renderToStaticMarkup(
      createElement(SignupsChart, { ...base, days, future_dated_count: 0, last_signup_at: "2026-04-17T21:32:47+00:00" }),
    );
    expect(html).toMatch(/role="status"[^>]*>0 signups in the last 30 days — last signup 17 Apr 2026</);
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("2026-08-17 – 2026-09-15 (UTC)");
    expect(html).not.toMatch(/<rect[^>]*data-day=/);
  });

  it("empty window with no signup ever: '— no signups on record'", () => {
    const html = renderToStaticMarkup(createElement(SignupsChart, { ...base, days, future_dated_count: 0, last_signup_at: null }));
    expect(html).toContain("0 signups in the last 30 days — no signups on record");
  });
});
