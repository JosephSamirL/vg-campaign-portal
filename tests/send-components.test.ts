import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Tables } from "../lib/database.types";

/**
 * Story 4.4 — the send components' markup contracts (AC1, AC3, AC5). Pure server renders: the
 * client components (`SendHistory`, the dialog) hydrate their timers in the browser, so here the
 * markup is what the first server paint shows — no Retry before the client clock has ticked, the
 * polling flag from the rows alone.
 */

// `SendHistory` / the dialog call `useRouter()`; outside an app router that throws.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {} }),
}));
// The server actions import `next/headers`; the components only need their identities here.
vi.mock("@/app/(portal)/campaigns/[id]/actions", () => ({
  previewSendAction: vi.fn(),
  confirmSendAction: vi.fn(),
  dispatchSendAction: vi.fn(),
}));

const { SendPreview } = await import("../components/send/send-preview");
const { SendStatus, SendStatusBadge, isTerminal } = await import("../components/send/send-status");
const { SendHistory, POLL_INTERVAL_MS, STUCK_AFTER_MS } = await import("../components/campaigns/send-history");
const { SendConfirmDialog } = await import("../components/send/send-confirm-dialog");

type SendRow = Tables<"sends">;

const preview = {
  total_count: 50064,
  not_contactable: 30907,
  no_address: 1234,
  country_mismatch_or_unknown: 0,
  rule_text: "Contactable contacts with an address for the channel, in the **target country** when one is set.",
  channel: "email",
  target_country: null as unknown as string,
};

const base: SendRow = {
  id: "9d0e1f2a-3b4c-4d5e-8f60-1a2b3c4d5e6f",
  brand_id: "b",
  campaign_id: "c",
  status: "confirmed",
  source: "portal",
  batch_key: null,
  recipient_count: 50064,
  confirmed_by: "kilele.owner@vg-eval.test",
  confirmed_at: "2026-09-15T09:51:00Z",
  dispatched_at: null,
  provider_responded_at: null,
  dispatch_attempts: 0,
  dispatch_lease_until: null,
  body_sha256: null,
  batch_id: null,
  accepted_count: null,
  rejected_count: null,
  failure_reason: null,
  created_at: "2026-09-15T09:51:00Z",
};

describe("SendPreview", () => {
  it("shows the exact total, the three excluded counts by reason, channel / country and the rule text — all from the RPC", () => {
    const html = renderToStaticMarkup(createElement(SendPreview, { preview }));
    expect(html).toContain('data-testid="send-preview-total"');
    expect(html).toContain("50,064");
    expect(html).toContain('data-reason="not_contactable"');
    expect(html).toContain("30,907");
    expect(html).toContain('data-reason="no_address"');
    expect(html).toContain("1,234");
    expect(html).toContain('data-reason="country_mismatch_or_unknown"');
    expect(html).toContain("Not contactable");
    expect(html).toContain("No address for this channel");
    expect(html).toContain("Outside the target country, or country unknown");
    expect(html).toContain("email");
    expect(html).toContain("Any"); // null target_country
    expect(html).toContain("<strong>target country</strong>");
    // nothing computed: no 82,205 (the sum) anywhere
    expect(html).not.toContain("82,205");
  });

  it("prints the target country when set and singular copy for one recipient", () => {
    const html = renderToStaticMarkup(createElement(SendPreview, { preview: { ...preview, total_count: 1, target_country: "KE" } }));
    expect(html).toContain("KE");
    expect(html).toMatch(/>1<\/span><span[^>]*>recipient</);
  });
});

describe("SendStatus", () => {
  it("renders the lifecycle badge, timestamps, approver, count, batch and accepted / rejected", () => {
    const html = renderToStaticMarkup(
      createElement(SendStatus, {
        send: {
          ...base,
          status: "reporting",
          dispatched_at: "2026-09-15T09:51:03Z",
          provider_responded_at: "2026-09-15T09:51:04Z",
          batch_id: "mock-17",
          accepted_count: 50064,
          rejected_count: 0,
        },
      }),
    );
    expect(html).toContain('data-testid="send-status-badge" data-status="reporting"');
    expect(html).toContain("Sent — reporting");
    expect(html).toContain("15 Sep 2026, 09:51 UTC");
    expect(html).toContain('data-testid="send-confirmed-by">kilele.owner@vg-eval.test');
    expect(html).toContain("50,064");
    expect(html).toContain('data-testid="send-batch-id">mock-17');
    expect(html).toContain("50,064</span> recipients");
    expect(html).toMatch(/data-testid="send-counts">50,064 \/ 0</);
    expect(html).not.toContain("send-partial");
    expect(html).not.toContain("send-failure-reason");
    expect(html).not.toContain("send-source");
  });

  it("partial reads 'Partially sent — {accepted} of {count} accepted'", () => {
    const html = renderToStaticMarkup(createElement(SendStatus, { send: { ...base, status: "partial", accepted_count: 49000, rejected_count: 1064, batch_id: "mock-18" } }));
    expect(html).toContain('data-status="partial"');
    expect(html).toContain("Partially sent — 49,000 of 50,064 accepted");
  });

  it("failed shows failure_reason; null counts and timestamps are dashes, never 0 or Invalid Date", () => {
    const html = renderToStaticMarkup(createElement(SendStatus, { send: { ...base, status: "failed", failure_reason: "provider_422: empty recipients" } }));
    expect(html).toContain('data-testid="send-failure-reason">provider_422: empty recipients');
    expect(html).toContain("Failed");
    expect(html).toMatch(/data-testid="send-counts">— \/ —</);
    expect(html).not.toContain("Invalid Date");
  });

  it("renders the source badge only when a label is given (Story 4.5's slot) and the retry slot when given", () => {
    const withLabel = renderToStaticMarkup(createElement(SendStatus, { send: { ...base, source: "seed_send_log" }, sourceLabel: "from send log" }));
    expect(withLabel).toContain('data-testid="send-source">from send log');
    const withRetry = renderToStaticMarkup(createElement(SendStatus, { send: base, retry: createElement("button", null, "Retry") }));
    expect(withRetry).toContain("Retry");
  });

  it("has one badge per status value and knows the terminal set", () => {
    for (const status of ["pending", "confirmed", "dispatched", "reporting", "complete", "partial", "failed"] as const) {
      expect(renderToStaticMarkup(createElement(SendStatusBadge, { status }))).toContain(`data-status="${status}"`);
    }
    expect(isTerminal("complete")).toBe(true);
    expect(isTerminal("partial")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("confirmed")).toBe(false);
    expect(isTerminal("reporting")).toBe(false);
  });
});

describe("SendHistory", () => {
  it("renders the empty sentence for no sends and no list", () => {
    const html = renderToStaticMarkup(createElement(SendHistory, { sends: [], isOwner: true }));
    expect(html).toContain("No sends yet");
    expect(html).toContain('data-testid="empty-state"');
    expect(html).not.toContain("send-history");
  });

  it("lists the rows in the order given, flags polling while any row is non-terminal, and never a Retry on the server paint", () => {
    const sends: SendRow[] = [
      { ...base, id: "a1", status: "confirmed", confirmed_at: "2000-01-01T00:00:00Z" },
      { ...base, id: "a2", status: "complete", batch_id: "mock-1", accepted_count: 50064, rejected_count: 0 },
    ];
    const html = renderToStaticMarkup(createElement(SendHistory, { sends, isOwner: true }));
    expect(html).toContain('data-testid="send-history" data-polling="true"');
    expect(html.indexOf('data-send-id="a1"')).toBeLessThan(html.indexOf('data-send-id="a2"'));
    // stuck detection needs the client clock (an effect), so the server paint carries no Retry
    expect(html).not.toContain("dispatch-retry");
    expect(POLL_INTERVAL_MS).toBe(3000);
    expect(STUCK_AFTER_MS).toBe(30000);
  });

  it("does not poll when every row is terminal, and passes the source label through", () => {
    const sends: SendRow[] = [{ ...base, id: "a3", status: "failed", failure_reason: "provider_422: x", source: "seed_send_log" }];
    const html = renderToStaticMarkup(createElement(SendHistory, { sends, isOwner: false, sourceLabels: { seed_send_log: "from send log" } }));
    expect(html).toContain('data-polling="false"');
    expect(html).toContain('data-testid="send-source">from send log');
  });
});

describe("SendConfirmDialog", () => {
  it("renders the Send button and a closed dialog with the campaign label; no numbers before the preview arrives", () => {
    const html = renderToStaticMarkup(createElement(SendConfirmDialog, { campaignId: "c", campaignLabel: "Nairobi launch" }));
    expect(html).toMatch(/<button[^>]*data-testid="send-button"[^>]*>Send<\/button>/);
    expect(html).toContain("<dialog");
    expect(html).not.toContain(" open");
    expect(html).toContain("Send Nairobi launch");
    expect(html).toContain('data-testid="send-dialog-loading"');
    // the confirm button is disabled until the preview is in
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="send-confirm"/);
    expect(html).not.toContain("send-preview-total");
  });
});
