import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorDigest } from "../lib/error-digest";

/**
 * `/campaigns` and `/campaigns/[id]` page contracts (Story 3.4). Both pages are async server
 * components; calling them with mocked params and a recording mock of the server client yields
 * a sync tree that `renderToStaticMarkup` turns into HTML. The mock records every builder call
 * so the query shapes (select / eq / order / in / maybeSingle) are pinned too.
 */

type Result = { data: unknown; error: unknown };

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
  for (const m of ["select", "eq", "order", "in", "maybeSingle"]) chain[m] = record(m);
  chain.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => {
    const r = responses[table];
    const result = Array.isArray(r) ? r.shift() : r;
    return Promise.resolve(result ?? { data: null, error: { message: `no mock for ${table}` } }).then(resolve, reject);
  };
  return chain;
}

const from = vi.fn((table: string) => builder(table));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from }) }));

// `RetryAlert` is a client component calling `useRouter()`; outside an app router that throws.
// `notFound()` stays real so the 404 digest is what the page really throws.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {} }),
}));

// Story 4.4: the dialog / retry button import the server actions, which pull `next/headers`; the page needs only their identities.
vi.mock("@/app/(portal)/campaigns/[id]/actions", () => ({
  previewSendAction: vi.fn(),
  confirmSendAction: vi.fn(),
  dispatchSendAction: vi.fn(),
  createShareLinkAction: vi.fn(),
  revokeShareLinkAction: vi.fn(),
}));

let role: "owner" | "analyst" | null = "analyst";
vi.mock("@/lib/current-user", () => ({
  getCurrentAppUser: async () =>
    role === null ? null : { email: "x@vg-eval.test", role, brand_id: "b", brand_name: "KILELE", brand_code: "KILELE" },
}));

const { default: CampaignsPage } = await import("../app/(portal)/campaigns/page");
const { default: CampaignPage } = await import("../app/(portal)/campaigns/[id]/page");

const KIL_0016 = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
const KIL_0033 = "0a9b8c7d-6e5f-4a4b-8c3d-2e1f0a9b8c7d";
const OTHER_BRAND = "41f5824b-cdda-4012-9585-49d29c79c180";

const rules = [
  { key: "delivered_rate", label: "Delivered rate", rule_text: "delivered ÷ sent", alternative_text: "delivered ÷ (sent − bounced)" },
  { key: "bounce_rate", label: "Bounce rate", rule_text: "bounced ÷ sent", alternative_text: "hard bounces only" },
  { key: "open_rate", label: "Open rate", rule_text: "**total** opens ÷ sent — can exceed 100%", alternative_text: "unique opens" },
  { key: "click_rate", label: "Click rate", rule_text: "clicks ÷ sent", alternative_text: "clicks ÷ opens" },
  { key: "unsubscribe_rate", label: "Unsubscribe rate", rule_text: "unsubscribes ÷ delivered", alternative_text: "÷ sent" },
];

const base = {
  brand_id: "b",
  source: "reported",
  send_id: null,
  target_country: "KE",
  unsubscribes: null,
  unsubscribe_rate: null,
};

const kil16 = {
  ...base,
  campaign_id: KIL_0016,
  external_id: "KIL-0016",
  name: "Nairobi launch",
  channel: "email",
  sent_at: "2026-06-03T08:00:00+00:00",
  spend: 650.07,
  sent: 10640,
  delivered: 10214,
  bounced: 426,
  opens: 12679,
  clicks: 1183,
  delivered_rate: 96.0,
  bounce_rate: 4.0,
  open_rate: 119.16,
  click_rate: 11.12,
};

const kil33 = {
  ...base,
  campaign_id: KIL_0033,
  external_id: "KIL-0033",
  name: null,
  channel: null,
  sent_at: null,
  spend: "221.09",
  sent: 0,
  delivered: 0,
  bounced: 0,
  opens: 0,
  clicks: 0,
  delivered_rate: null,
  bounce_rate: null,
  open_rate: null,
  click_rate: null,
};

const campaignRow = {
  id: KIL_0016,
  brand_id: "b",
  external_id: "KIL-0016",
  name: "Nairobi launch",
  channel: "email",
  target_country: "KE",
  sent_at: "2026-06-03T08:00:00+00:00",
  send_local_time: null,
  spend: 650.07,
  reported_sent: 10640,
  reported_delivered: 10214,
  reported_bounced: 426,
  reported_opens: 12679,
  reported_clicks: 1183,
  parent_campaign_id: null,
  parent_external_id: null,
  as_of: "2026-08-01",
  file_rank: 1,
  created_at: "2026-09-15T00:00:00+00:00",
  updated_at: "2026-09-15T00:00:00+00:00",
};

/** A portal send as `sends` returns it (Story 4.4); tests override status / counts per case. */
const sendRow = {
  id: "9d0e1f2a-3b4c-4d5e-8f60-1a2b3c4d5e6f",
  brand_id: "b",
  campaign_id: KIL_0016,
  status: "confirmed",
  source: "portal",
  batch_key: null,
  recipient_count: 50064,
  confirmed_by: "kilele.owner@vg-eval.test",
  confirmed_at: "2026-09-15T09:51:00+00:00",
  dispatched_at: null,
  provider_responded_at: null,
  dispatch_attempts: 0,
  dispatch_lease_until: null,
  body_sha256: null,
  batch_id: null,
  accepted_count: null,
  rejected_count: null,
  failure_reason: null,
  created_at: "2026-09-15T09:51:00+00:00",
};

async function renderList() {
  return renderToStaticMarkup(await CampaignsPage());
}

async function renderDetail(id: string) {
  return renderToStaticMarkup(await CampaignPage({ params: Promise.resolve({ id }) }));
}

beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  for (const k of Object.keys(calls)) delete calls[k];
  from.mockClear();
  role = "analyst";
  responses.metric_rules = { data: rules, error: null };
  responses.sends = { data: [], error: null };
  responses.v_share_links = { data: [], error: null };
});

/** A share link as `v_share_links` returns it (Story 5.2); tests override status / dates per case. */
const shareLinkRow = {
  id: "3f7a1b2c-9d8e-4f60-a1b2-c3d4e5f60718",
  brand_id: "b",
  campaign_id: KIL_0016,
  created_by: "u",
  created_at: "2026-09-15T09:51:00+00:00",
  expires_at: null,
  revoked_at: null,
  status: "active",
};

describe("/campaigns", () => {
  it("renders a destructive alert with Retry (not a table, not zeros) when the view query fails", async () => {
    responses.v_campaign_performance = { data: null, error: { message: "relation does not exist", code: "42P01" } };
    const html = await renderList();
    expect(html).toContain('data-testid="retry-alert"');
    // the raw PostgREST text stays server-side; the browser gets a generic sentence + digest
    expect(html).not.toContain("relation does not exist");
    expect(html).toContain(`data-digest="${errorDigest("relation does not exist")}"`);
    expect(html).toContain("Retry");
    expect(html).not.toContain("campaigns-table");
    expect(html).not.toContain("0.00%");
  });

  it("renders a destructive alert when metric_rules is missing a key (captions are never hard-coded)", async () => {
    responses.v_campaign_performance = { data: [kil16], error: null };
    responses.metric_rules = { data: rules.slice(1), error: null };
    const html = await renderList();
    expect(html).toContain('data-testid="retry-alert"');
    expect(html).toContain(`data-digest="${errorDigest("metric_rules is missing: delivered_rate")}"`);
    expect(html).not.toContain("metric_rules is missing");
    expect(html).not.toContain("campaigns-table");
  });

  it("renders the empty sentence when the brand has no campaigns", async () => {
    responses.v_campaign_performance = { data: [], error: null };
    const html = await renderList();
    expect(html).toContain("No campaigns loaded yet");
    expect(html).toContain('data-testid="empty-state"');
    expect(html).not.toContain("campaigns-table");
  });

  it("shows the last-synced placeholder for null (Epic 6 supplies the value)", async () => {
    responses.v_campaign_performance = { data: [], error: null };
    const html = await renderList();
    expect(html).toContain("Reports last synced: no portal sends yet");
  });

  it("lists reported rows newest sent_at first with the story's exact query shape", async () => {
    responses.v_campaign_performance = { data: [kil16, kil33], error: null };
    const html = await renderList();
    expect(from).toHaveBeenCalledWith("v_campaign_performance");
    expect(calls.v_campaign_performance).toEqual([
      ["select", ["*"]],
      ["eq", ["source", "reported"]],
      ["order", ["sent_at", { ascending: false, nullsFirst: false }]],
      ["order", ["external_id"]],
    ]);
    expect(calls.metric_rules).toEqual([
      ["select", ["*"]],
      ["in", ["key", ["delivered_rate", "bounce_rate", "open_rate", "click_rate", "unsubscribe_rate"]]],
    ]);
    // order preserved as the view returned it
    expect(html.indexOf("KIL-0016")).toBeLessThan(html.indexOf("KIL-0033"));
    // caption from the single constant
    expect(html).toContain("<caption");
    expect(html).toContain("as reported by the source");
  });

  it("renders name link, channel badge, sent date, counts, spend and the five view rates", async () => {
    responses.v_campaign_performance = { data: [kil16], error: null };
    const html = await renderList();
    expect(html).toContain(`href="/campaigns/${KIL_0016}"`);
    expect(html).toContain("Nairobi launch");
    expect(html).toContain("email");
    expect(html).toContain("03 Jun 2026");
    expect(html).toContain("10,640");
    expect(html).toContain("10,214");
    expect(html).toContain("426");
    expect(html).toContain("12,679");
    expect(html).toContain("1,183");
    expect(html).toContain("650.07");
    // rates as the view computed them — unclamped
    expect(html).toContain("96.00%");
    expect(html).toContain("4.00%");
    expect(html).toContain("119.16%");
    expect(html).toContain("11.12%");
    // captions from metric_rules, in the markup (tooltip content), with the alternative
    expect(html).toContain("opens ÷ sent — can exceed 100%");
    expect(html).toContain("Not: unique opens");
  });

  it("prints a dash for null rates and falls back to external_id when name is null; spend as a string is normalised", async () => {
    responses.v_campaign_performance = { data: [kil33], error: null };
    const html = await renderList();
    expect(html).toContain("KIL-0033");
    expect(html).toContain("221.09");
    // sent = 0 → every rate null → "—", never "NaN" or "0.00%"
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("0.00%");
    expect(html).not.toContain("Infinity");
    const dashes = html.match(/—/g) ?? [];
    // 5 rates + channel + sent date
    expect(dashes.length).toBeGreaterThanOrEqual(7);
  });

  it("returns an error result when the view hands back a row without campaign_id", async () => {
    responses.v_campaign_performance = { data: [{ ...kil16, campaign_id: null }], error: null };
    const html = await renderList();
    expect(html).toContain('data-testid="retry-alert"');
    expect(html).not.toContain("without campaign_id");
  });
});

describe("/campaigns/[id]", () => {
  it("calls notFound() for a malformed id before any query", async () => {
    await expect(renderDetail("abc")).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect(from).not.toHaveBeenCalled();
  });

  it("calls notFound() when RLS yields no campaigns row (another brand's id, or nobody's)", async () => {
    responses.campaigns = { data: null, error: null };
    responses.v_campaign_performance = { data: [], error: null };
    await expect(renderDetail(OTHER_BRAND)).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect(calls.campaigns).toEqual([["select", ["*"]], ["eq", ["id", OTHER_BRAND]], ["maybeSingle", []]]);
  });

  it("renders an alert with Retry (not not-found) when the campaigns query itself fails", async () => {
    responses.campaigns = { data: null, error: { message: "connection refused" } };
    responses.v_campaign_performance = { data: [], error: null };
    const html = await renderDetail(KIL_0016);
    expect(html).toContain('data-testid="retry-alert"');
    expect(html).not.toContain("connection refused");
    expect(html).toContain(`data-digest="${errorDigest("connection refused")}"`);
  });

  it("renders header, figures and the two empty sections for an analyst — with no action buttons", async () => {
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    const html = await renderDetail(KIL_0016);
    expect(calls.v_campaign_performance).toEqual([
      ["select", ["*"]],
      ["eq", ["campaign_id", KIL_0016]],
      ["order", ["source", { ascending: false }]],
      ["order", ["send_id", { nullsFirst: true }]],
    ]);
    // header
    expect(html).toContain('data-testid="campaign-header"');
    expect(html).toContain("Nairobi launch");
    expect(html).toContain("KIL-0016");
    expect(html).toContain("email");
    expect(html).toContain("KE");
    expect(html).toContain("03 Jun 2026");
    expect(html).toContain("650.07");
    // figures
    expect(html).toContain("Reported by the source");
    expect(html).toContain("119.16%");
    expect(html).toContain("12,679");
    // the two slots and their empty sentences; the sends query is the story's exact shape (RLS, newest send date first:
    // `confirmed_at desc nulls last, created_at desc` — a seed send-log row is dated by the log, not by the seed run)
    expect(calls.sends).toEqual([
      ["select", ["*"]],
      ["eq", ["campaign_id", KIL_0016]],
      ["order", ["confirmed_at", { ascending: false, nullsFirst: false }]],
      ["order", ["created_at", { ascending: false }]],
    ]);
    expect(html).toContain('id="sends"');
    expect(html).toContain("No sends yet");
    // the share-links query is the story's exact shape (RLS through the security_invoker view, newest first)
    expect(calls.v_share_links).toEqual([["select", ["*"]], ["eq", ["campaign_id", KIL_0016]], ["order", ["created_at", { ascending: false }]]]);
    expect(html).toContain('id="share-links"');
    expect(html).toContain("No share links yet");
    // analyst: no Send button, no dialog, no Publish button / dialog (Story 4.4 AC4, 5.2 AC5: UI hides, DB refuses)
    expect(html).not.toContain("send-button");
    expect(html).not.toContain("send-dialog");
    expect(html).not.toContain("publish-button");
    expect(html).not.toContain("share-link-dialog");
    expect(html).not.toContain("publish-placeholder");
    expect(html).not.toContain("Available soon");
  });

  it("shows the Send button (+ closed confirm dialog) and the Publish button (+ closed share dialog) to an owner (server-side role only)", async () => {
    role = "owner";
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    const html = await renderDetail(KIL_0016);
    expect(html).toMatch(/<button[^>]*data-testid="send-button"[^>]*>Send<\/button>/);
    expect(html).not.toMatch(/<button[^>]*data-testid="send-button"[^>]*disabled/);
    expect(html).toContain('data-testid="send-dialog"');
    expect(html).toContain("Send Nairobi launch");
    expect(html).toMatch(/<button[^>]*data-testid="publish-button"[^>]*>Publish results<\/button>/);
    expect(html).not.toMatch(/<button[^>]*data-testid="publish-button"[^>]*disabled/);
    expect(html).toContain('data-testid="share-link-dialog"');
    expect(html).toContain("Publish results for Nairobi launch");
    expect(html).not.toContain("publish-placeholder");
    expect(html.indexOf('id="sends"')).toBeLessThan(html.indexOf("send-button"));
    expect(html.indexOf('id="share-links"')).toBeLessThan(html.indexOf("publish-button"));
  });

  it("lists the campaign's share links from v_share_links with the view's status (Story 5.2 AC3) — Revoke only for an owner on active rows", async () => {
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    const links = [
      { ...shareLinkRow, id: "l2", created_at: "2026-09-15T12:00:00+00:00", expires_at: "2026-10-01T00:00:00+00:00", status: "active" },
      { ...shareLinkRow, id: "l1", revoked_at: "2026-09-15T10:00:00+00:00", status: "revoked" },
    ];
    responses.v_share_links = { data: links, error: null };
    const analyst = await renderDetail(KIL_0016);
    expect(analyst).toContain('data-testid="share-link-list"');
    expect(analyst.indexOf('data-link-id="l2"')).toBeLessThan(analyst.indexOf('data-link-id="l1"'));
    expect(analyst).toContain('data-status="active"');
    expect(analyst).toContain('data-status="revoked"');
    expect(analyst).toContain("01 Oct 2026, 00:00 UTC");
    expect(analyst).toContain('data-testid="share-link-expiry">never<');
    expect(analyst).not.toContain('data-testid="share-link-revoke"');
    expect(analyst).not.toContain("No share links yet");

    role = "owner";
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    responses.v_share_links = { data: links, error: null };
    const owner = await renderDetail(KIL_0016);
    expect(owner.match(/data-testid="share-link-revoke"/g)?.length).toBe(1);
    expect(owner).toMatch(/data-link-id="l2"[\s\S]*?data-testid="share-link-revoke"[\s\S]*?data-link-id="l1"/);
  });

  it("renders the share-links alert with Retry (never an empty list) when v_share_links fails — header, figures and sends intact", async () => {
    role = "owner";
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    responses.v_share_links = { data: null, error: { message: "v_share_links timed out" } };
    const html = await renderDetail(KIL_0016);
    expect(html).toContain(`data-digest="${errorDigest("v_share_links timed out")}"`);
    expect(html).not.toContain("v_share_links timed out");
    expect(html).toContain("Retry");
    expect(html).not.toContain("No share links yet");
    expect(html).not.toContain("share-link-list");
    expect(html).toContain("119.16%");
    expect(html).toContain("No sends yet");
    // the Publish button still renders: the write path does not depend on the read
    expect(html).toContain('data-testid="publish-button"');
  });

  it("lists the campaign's sends with their status (Story 4.4 AC1/AC3) and polls while one is in flight", async () => {
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    responses.sends = {
      data: [
        { ...sendRow, id: "s2", status: "dispatched", dispatched_at: "2026-09-15T10:00:03Z" },
        { ...sendRow, id: "s1", status: "partial", batch_id: "mock-3", accepted_count: 49000, rejected_count: 1064, provider_responded_at: "2026-09-15T09:51:04Z" },
      ],
      error: null,
    };
    const html = await renderDetail(KIL_0016);
    expect(html).toContain('data-testid="send-history" data-polling="true"');
    expect(html).toContain('data-status="dispatched"');
    expect(html).toContain("Partially sent — 49,000 of 50,064 accepted");
    expect(html).toContain("kilele.owner@vg-eval.test");
    expect(html).toContain("mock-3");
    expect(html).toContain("15 Sep 2026, 09:51 UTC");
    expect(html.indexOf('data-send-id="s2"')).toBeLessThan(html.indexOf('data-send-id="s1"'));
    expect(html).not.toContain("No sends yet");
  });

  it("badges a seed send-log row 'from send log' and keeps the server's order — the seed row dated by its log, the portal row after it (Story 4.5 AC4)", async () => {
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    // KIL-0016's real seed row: BATCH-0007, 9,800 recipients, sent 2026-03-17 (the seed run itself is 2026-09-15)
    const seedRow = {
      ...sendRow,
      id: "seed-batch-0007",
      status: "complete",
      source: "seed_send_log",
      batch_key: "BATCH-0007",
      recipient_count: 9800,
      confirmed_by: null,
      confirmed_at: "2026-03-17T07:15:00+00:00",
      dispatched_at: "2026-03-17T07:15:00+00:00",
      created_at: "2026-09-15T08:00:00+00:00",
    };
    const portalRow = { ...sendRow, id: "portal-1", status: "reporting", batch_id: "mock-9", accepted_count: 50064, rejected_count: 0, confirmed_at: "2026-09-15T09:51:00+00:00" };
    // the server (PostgREST) orders — the page renders as given
    responses.sends = { data: [portalRow, seedRow], error: null };
    const html = await renderDetail(KIL_0016);
    expect(html).toContain('data-testid="send-source">from send log');
    expect(html.match(/data-testid="send-source"/g)?.length).toBe(1); // the portal row carries no badge
    expect(html).toContain('data-send-id="seed-batch-0007" data-status="complete"');
    expect(html).toContain("9,800");
    expect(html).toContain("17 Mar 2026, 07:15 UTC");
    expect(html.indexOf('data-send-id="portal-1"')).toBeLessThan(html.indexOf('data-send-id="seed-batch-0007"'));
    // the reported figures are untouched by the seed send: sent stays 10,640, the send log's 9,800 is nowhere in the rates
    expect(html).toContain("10,640");
    expect(html).toContain("96.00%");
    expect(html).toContain('data-polling="true"'); // the portal row is still reporting
  });

  it("gives the owner a Retry under 'Waiting for the provider — lease expired' for a send the server flagged stranded in dispatched", async () => {
    role = "owner";
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    responses.sends = {
      data: [
        { ...sendRow, id: "stranded", status: "dispatched", dispatched_at: "2026-09-15T09:51:03Z", dispatch_attempts: 1, dispatch_lease_until: "2026-09-01T10:01:03Z" },
        { ...sendRow, id: "leased", status: "dispatched", dispatched_at: "2026-09-15T09:51:03Z", dispatch_attempts: 1, dispatch_lease_until: "2999-01-01T00:00:00Z" },
      ],
      error: null,
    };
    const html = await renderDetail(KIL_0016);
    expect(html.match(/data-testid="dispatch-retry"/g)?.length).toBe(1);
    expect(html).toMatch(/data-send-id="stranded"[\s\S]*?Waiting for the provider — lease expired[\s\S]*?data-send-id="leased"/);
    expect(html).not.toContain("Dispatch didn&#x27;t start");

    // an analyst sees the same rows and no Retry at all (UI hides, the function refuses anyway)
    role = "analyst";
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    responses.sends = { data: [{ ...sendRow, id: "stranded", status: "dispatched", dispatch_lease_until: "2026-09-01T10:01:03Z" }], error: null };
    expect(await renderDetail(KIL_0016)).not.toContain("dispatch-retry");
  });

  it("hands the owner's dialog the campaign's sends: prior sends listed, Send disabled while one is non-terminal", async () => {
    role = "owner";
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    responses.sends = { data: [{ ...sendRow, id: "live", status: "reporting", batch_id: "mock-1" }], error: null };
    const html = await renderDetail(KIL_0016);
    expect(html).toContain('data-testid="send-dialog-prior"');
    expect(html).toContain('data-testid="send-dialog-prior-row" data-send-id="live" data-status="reporting"');
    expect(html).toContain('data-code="send_in_progress"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="send-confirm"/);
  });

  it("renders the sends alert (header, figures and share links intact) when the sends query fails", async () => {
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: [kil16], error: null };
    responses.sends = { data: null, error: { message: "sends timed out" } };
    const html = await renderDetail(KIL_0016);
    expect(html).toContain(`data-digest="${errorDigest("sends timed out")}"`);
    expect(html).not.toContain("sends timed out");
    expect(html).toContain("119.16%");
    expect(html).toContain("No share links yet");
    expect(html).not.toContain("send-history");
  });

  it("titles a portal row by its send id and keeps the reported block first", async () => {
    role = "owner";
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = {
      data: [
        { ...kil16, source: "portal", send_id: "9d0e1f2a-3b4c-4d5e-8f60-1a2b3c4d5e6f", unsubscribes: 3, unsubscribe_rate: 0.03 },
        kil16,
      ],
      error: null,
    };
    const html = await renderDetail(KIL_0016);
    expect(html).toContain("Portal send 9d0e1f2a");
    expect(html).toContain("0.03%");
    // positional: the view rows arrive portal-first here, the reported block still renders first
    expect(html.indexOf("Reported by the source")).toBeGreaterThan(-1);
    expect(html.indexOf("Reported by the source")).toBeLessThan(html.indexOf("Portal send 9d0e1f2a"));
  });

  it("renders the figures alert (and still the sections) when the performance query fails", async () => {
    responses.campaigns = { data: campaignRow, error: null };
    responses.v_campaign_performance = { data: null, error: { message: "view timed out" } };
    const html = await renderDetail(KIL_0016);
    expect(html).toContain('data-testid="retry-alert"');
    expect(html).not.toContain("view timed out");
    expect(html).toContain("No sends yet");
    expect(html).not.toContain("119.16%");
  });
});
