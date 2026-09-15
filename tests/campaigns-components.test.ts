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
  it("is null for ok / requested / running and for no run at all; a failure names the last success, or 'the portal went live'", () => {
    for (const status of ["ok", "requested", "running", null]) expect(syncWarning(status, "2026-09-15T11:57:00Z")).toBeNull();
    expect(syncWarning("failed", "2026-09-15T11:57:00Z")).toBe("Report sync has not succeeded since 15 Sep 2026, 11:57 UTC");
    expect(syncWarning("auth_error", null)).toBe("Report sync has not succeeded since the portal went live");
    for (const status of ["provider_error", "rate_limited", "deferred"]) expect(syncWarning(status, null)).toContain("has not succeeded");
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
