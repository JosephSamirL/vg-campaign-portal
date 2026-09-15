import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LastSynced } from "../components/campaigns/last-synced";
import { syncWarning } from "../lib/queries/campaigns";
import { formatCount, formatRelative, formatSpend } from "../components/campaigns/format";
import { CampaignSection, type CampaignSectionProps } from "../components/campaigns/campaign-section";

/** `createElement` wants children as an argument (eslint) while the props type requires them (tsc). */
const section = (props: Omit<CampaignSectionProps, "children">, body: string) =>
  renderToStaticMarkup(createElement(CampaignSection, props as CampaignSectionProps, body));

describe("campaign formatters", () => {
  it("formats counts and spend, dash for null", () => {
    expect(formatCount(10640)).toBe("10,640");
    expect(formatCount("10640")).toBe("10,640");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe("—");
    expect(formatSpend(650.07)).toBe("650.07");
    expect(formatSpend("221.09")).toBe("221.09");
    expect(formatSpend(null)).toBe("—");
  });

  it("formats relative sync times", () => {
    const now = Date.parse("2026-09-15T12:00:00Z");
    expect(formatRelative("2026-09-15T11:59:50Z", now)).toBe("just now");
    expect(formatRelative("2026-09-15T11:57:00Z", now)).toBe("3 minutes ago");
    expect(formatRelative("2026-09-15T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatRelative("2026-09-14T11:00:00Z", now)).toBe("yesterday");
    expect(formatRelative("2026-07-01T11:00:00Z", now)).toBe("01 Jul 2026, 11:00 UTC");
    expect(formatRelative("garbage", now)).toBe("—");
  });
});

describe("LastSynced", () => {
  it("renders the placeholder sentence for null and no warning line", () => {
    const html = renderToStaticMarkup(createElement(LastSynced, { last_ok_at: null }));
    expect(html).toContain("Reports last synced: no portal sends yet");
    expect(html).not.toContain("last-synced-warning");
  });

  it("renders a relative time with the absolute UTC instant as title, and the warning (Story 6.3's contract)", () => {
    const html = renderToStaticMarkup(
      createElement(LastSynced, { last_ok_at: "2026-09-15T11:57:00Z", warning: "Provider unreachable since 11:57 UTC" }),
    );
    expect(html).toContain("Reports last synced");
    expect(html).toContain('<time dateTime="2026-09-15T11:57:00Z" title="15 Sep 2026, 11:57 UTC">');
    expect(html).toContain("Provider unreachable since 11:57 UTC");
    expect(html).not.toContain("no portal sends yet");
  });

  it("6.3 review [M]: a row with a null last_ok_at (has_batches) reads 'Reports not synced yet' — distinct from the no-row placeholder", () => {
    const pending = renderToStaticMarkup(createElement(LastSynced, { last_ok_at: null, has_batches: true }));
    expect(pending).toContain('data-testid="last-synced-pending">Reports not synced yet');
    expect(pending).not.toContain("no portal sends yet");
    const noRow = renderToStaticMarkup(createElement(LastSynced, { last_ok_at: null, has_batches: false }));
    expect(noRow).toContain("Reports last synced: no portal sends yet");
    expect(noRow).not.toContain("not synced yet");
    const synced = renderToStaticMarkup(createElement(LastSynced, { last_ok_at: "2026-09-15T11:57:00Z", has_batches: true }));
    expect(synced).toContain("Reports last synced <time");
    expect(synced).not.toContain("not synced yet");
  });

  it("the warning is the muted line (text-muted-foreground), never the destructive alert, and absent when null (Story 6.3 AC5)", () => {
    const warned = renderToStaticMarkup(createElement(LastSynced, { last_ok_at: null, warning: "Report sync has not succeeded since the portal went live" }));
    expect(warned).toContain('<p class="text-muted-foreground" data-testid="last-synced-warning">');
    expect(warned).not.toContain('role="alert"');
    expect(warned).toContain("Reports last synced: no portal sends yet"); // the placeholder stays while the view has no row
    const quiet = renderToStaticMarkup(createElement(LastSynced, { last_ok_at: "2026-09-15T11:57:00Z", warning: null }));
    expect(quiet).not.toContain("last-synced-warning");
  });
});

describe("syncWarning (Story 6.3 AC5)", () => {
  const now = new Date("2026-09-15T12:10:00Z");
  const fresh = "2026-09-15T12:05:00Z"; // 5 min before `now`
  const stale = "2026-09-15T11:40:00Z"; // 30 min before `now`

  it("is null for a fresh ok / requested / running / deferred run and for no run at all; a failure names the last success, or 'the portal went live'", () => {
    for (const status of ["ok", "requested", "running", "deferred"]) expect(syncWarning({ status, finished_at: fresh }, "2026-09-15T11:57:00Z", now)).toBeNull();
    expect(syncWarning(null, "2026-09-15T11:57:00Z", now)).toBeNull();
    expect(syncWarning({ status: "failed", finished_at: fresh }, "2026-09-15T11:57:00Z", now)).toBe("Report sync has not succeeded since 15 Sep 2026, 11:57 UTC");
    expect(syncWarning({ status: "auth_error", finished_at: fresh }, null, now)).toBe("Report sync has not succeeded since the portal went live");
    for (const status of ["provider_error", "rate_limited"]) expect(syncWarning({ status, finished_at: fresh }, null, now)).toContain("has not succeeded");
  });

  it("6.3 review [M]: a poller that STOPPED is visible — the newest row older than 20 min warns 'has not run since', whatever its status; requested_at ages a run with no finished_at", () => {
    expect(syncWarning({ status: "ok", finished_at: stale }, "2026-09-15T11:57:00Z", now)).toBe("Report sync has not run since 15 Sep 2026, 11:40 UTC");
    expect(syncWarning({ status: "deferred", finished_at: stale }, null, now)).toBe("Report sync has not run since 15 Sep 2026, 11:40 UTC");
    expect(syncWarning({ status: "requested", finished_at: null, requested_at: stale }, null, now)).toBe("Report sync has not run since 15 Sep 2026, 11:40 UTC");
    expect(syncWarning({ status: "requested", finished_at: null, requested_at: fresh }, null, now)).toBeNull();
    // exactly 20 minutes is not yet stale; a second later it is
    expect(syncWarning({ status: "ok", finished_at: "2026-09-15T11:50:00Z" }, null, now)).toBeNull();
    expect(syncWarning({ status: "ok", finished_at: "2026-09-15T11:49:59Z" }, null, now)).toContain("has not run since");
    // a failure outranks staleness (the more specific message); a row with no timestamp at all is judged on status alone
    expect(syncWarning({ status: "failed", finished_at: stale }, null, now)).toContain("has not succeeded");
    expect(syncWarning({ status: "ok", finished_at: null, requested_at: null }, null, now)).toBeNull();
    expect(syncWarning({ status: "ok", finished_at: "garbage" }, null, now)).toBeNull();
  });
});

describe("CampaignSection", () => {
  it("is a labelled section with the id as the slot anchor, an action area only when given", () => {
    const withAction = section({ id: "sends", title: "Sends", action: createElement("button", null, "Send") }, "body");
    expect(withAction).toContain('<section id="sends" aria-labelledby="sends-heading"');
    expect(withAction).toContain('id="sends-heading"');
    expect(withAction).toContain('data-testid="section-sends-action"');
    expect(withAction).toContain("body");
    const without = section({ id: "share-links", title: "Share links" }, "body");
    expect(without).toContain('<section id="share-links"');
    expect(without).not.toContain("section-share-links-action");
  });
});
