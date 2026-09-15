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
const { SendStatus, SendStatusBadge, isTerminal, failureReasonPrefix } = await import("../components/send/send-status");
const { SendHistory, LEASE_EXPIRED_LABEL, POLL_BACKOFF_AFTER_MS, POLL_INTERVAL_MS, POLL_SLOW_INTERVAL_MS, POLL_STOP_AFTER_MS, STUCK_AFTER_MS } = await import("../components/campaigns/send-history");
const { SendConfirmDialog, isExistingSend, FRESH_SEND_MAX_AGE_MS } = await import("../components/send/send-confirm-dialog");

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

  it("partial with a null accepted_count reads 'provider outcome unknown' — never '0 of N' (FR-19)", () => {
    const html = renderToStaticMarkup(createElement(SendStatus, { send: { ...base, status: "partial", accepted_count: null, rejected_count: null, failure_reason: "dispatch_outcome_unknown_after_3_attempts" } }));
    expect(html).toContain('data-testid="send-partial" data-outcome="unknown"');
    expect(html).toContain("Partially sent — provider outcome unknown");
    expect(html).toContain("(dispatch_outcome_unknown_after_3_attempts)");
    expect(html).not.toContain("0 of 50,064");
    expect(html).not.toContain(" of 50,064 accepted");
    expect(html).toMatch(/data-testid="send-counts">— \/ —</);
    // and without a reason: the sentence alone
    const bare = renderToStaticMarkup(createElement(SendStatus, { send: { ...base, status: "partial", accepted_count: null } }));
    expect(bare).toContain("Partially sent — provider outcome unknown");
    expect(bare).not.toContain("send-failure-reason");
  });

  it("failed shows only the failure_reason code as text, the detail in title; null counts and timestamps are dashes, never 0 or Invalid Date", () => {
    const html = renderToStaticMarkup(createElement(SendStatus, { send: { ...base, status: "failed", failure_reason: "provider_422: empty recipients for bob@example.com" } }));
    expect(html).toMatch(/data-testid="send-failure-reason"[^>]*title="provider_422: empty recipients for bob@example.com"[^>]*>provider_422</);
    expect(html).not.toContain(">provider_422: empty");
    expect(html).toContain("Failed");
    expect(html).toMatch(/data-testid="send-counts">— \/ —</);
    expect(html).not.toContain("Invalid Date");
    expect(failureReasonPrefix("provider_422: x: y")).toBe("provider_422");
    expect(failureReasonPrefix("body_hash_mismatch")).toBe("body_hash_mismatch");
    const noReason = renderToStaticMarkup(createElement(SendStatus, { send: { ...base, status: "failed" } }));
    expect(noReason).toContain("Failed — no reason was recorded");
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
    // backoff: 3 s for the first minute, 10 s after, stop after 10 min (4.4 review [L])
    expect(POLL_BACKOFF_AFTER_MS).toBe(60_000);
    expect(POLL_SLOW_INTERVAL_MS).toBe(10_000);
    expect(POLL_STOP_AFTER_MS).toBe(600_000);
    expect(html).not.toContain("send-history-stale");
  });

  it("renders the owner's Retry under the lease-expired label for a row the server flagged `lease_expired` — and never for an analyst", () => {
    const stranded = { ...base, id: "a4", status: "dispatched" as const, dispatched_at: "2026-09-15T09:51:03Z", dispatch_lease_until: "2026-09-15T10:01:03Z", lease_expired: true };
    const live = { ...base, id: "a5", status: "dispatched" as const, dispatch_lease_until: "2999-01-01T00:00:00Z", lease_expired: false };
    const owner = renderToStaticMarkup(createElement(SendHistory, { sends: [stranded, live], isOwner: true }));
    expect(owner.match(/data-testid="dispatch-retry"/g)?.length).toBe(1);
    expect(owner).toContain(`data-testid="dispatch-retry-label">${LEASE_EXPIRED_LABEL}<`);
    expect(LEASE_EXPIRED_LABEL).toBe("Waiting for the provider — lease expired");
    expect(owner).toMatch(/data-send-id="a4"[\s\S]*?dispatch-retry[\s\S]*?data-send-id="a5"/);
    expect(owner).toContain('data-polling="true"');
    const analyst = renderToStaticMarkup(createElement(SendHistory, { sends: [stranded, live], isOwner: false }));
    expect(analyst).not.toContain("dispatch-retry");
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
    expect(html).not.toContain("send-dialog-prior");
    expect(html).not.toContain("send_in_progress");
  });

  it("lists prior sends (status, date, count) and flags an in-progress one; terminal-only history shows no in-progress alert", () => {
    const sends: SendRow[] = [
      { ...base, id: "p2", status: "dispatched", confirmed_at: "2026-09-15T12:00:00Z" },
      { ...base, id: "p1", status: "complete", recipient_count: 9800, confirmed_at: "2026-03-17T07:15:00Z", source: "seed_send_log" },
    ];
    const html = renderToStaticMarkup(createElement(SendConfirmDialog, { campaignId: "c", campaignLabel: "Nairobi launch", sends }));
    expect(html).toContain('data-testid="send-dialog-prior"');
    expect(html).toContain("Prior sends");
    expect(html).toContain('data-testid="send-dialog-prior-row" data-send-id="p2" data-status="dispatched"');
    expect(html).toContain('data-testid="send-dialog-prior-row" data-send-id="p1" data-status="complete"');
    expect(html).toContain("15 Sep 2026, 12:00 UTC");
    expect(html).toContain("17 Mar 2026, 07:15 UTC");
    expect(html).toContain("9,800</span> recipients");
    expect(html).toContain('data-code="send_in_progress"');
    expect(html).toContain("A send is already in progress");

    const settled = renderToStaticMarkup(createElement(SendConfirmDialog, { campaignId: "c", campaignLabel: "Nairobi launch", sends: [sends[1]] }));
    expect(settled).toContain('data-testid="send-dialog-prior-row" data-send-id="p1"');
    expect(settled).not.toContain("send_in_progress");
  });

  it("tells a returned EXISTING send from a fresh insert (4.2 AC2's loser path)", () => {
    const now = Date.parse("2026-09-15T12:00:30Z");
    const fresh: SendRow = { ...base, id: "new", confirmed_by: "me@vg-eval.test", recipient_count: 100, created_at: "2026-09-15T12:00:29Z" };
    const args = { knownIds: new Set(["old"]), userEmail: "me@vg-eval.test", expectedCount: 100, now };
    expect(isExistingSend(fresh, args)).toBe(false);
    expect(isExistingSend({ ...fresh, id: "old" }, args)).toBe(true); // already listed on the page
    expect(isExistingSend({ ...fresh, confirmed_by: "other.owner@vg-eval.test" }, args)).toBe(true); // another owner's
    expect(isExistingSend({ ...fresh, recipient_count: 99 }, args)).toBe(true); // a different count than confirmed
    expect(isExistingSend({ ...fresh, created_at: "2026-09-15T11:58:00Z" }, args)).toBe(true); // older than a fresh insert
    expect(FRESH_SEND_MAX_AGE_MS).toBe(60_000);
    // no user email known: the other three signals still decide
    expect(isExistingSend(fresh, { ...args, userEmail: null })).toBe(false);
  });
});
