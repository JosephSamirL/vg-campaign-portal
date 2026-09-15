import type { Database } from "@/lib/database.types";
import type { MetricKey } from "@/lib/rules/keys";
import type { MetricRule, Result } from "@/lib/rules/metric-rules";
import type { createClient } from "@/lib/supabase/server";

/*
 * Query helpers for `/campaigns` and `/campaigns/[id]` (Story 3.4). Every read goes through
 * the cookie-session server client, so RLS scopes rows to the caller's brand — there is no
 * `brand_id` filter in app code by design (D-2): another brand's id simply yields no row.
 *
 * supabase-js never throws; each helper maps `error` to `{ ok: false, message }` so the page
 * can render a destructive alert with Retry instead of a number (FR-15). Feature components
 * receive the narrowed rows as props and never call Supabase themselves.
 */

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Shared with the dashboard (Story 3.2): per-section outcome and the `metric_rules` row type. */
export type { MetricRule, Result };

export type PerformanceRow = Database["public"]["Views"]["v_campaign_performance"]["Row"];
export type CampaignRow = Database["public"]["Tables"]["campaigns"]["Row"];
export type SendRow = Database["public"]["Tables"]["sends"]["Row"];
/**
 * A `sends` row for the history plus one server-computed flag: `lease_expired` is true when the send is stranded
 * in `dispatched` with no `batch_id` and its `dispatch_lease_until` is in the past (a provider 5xx / timeout / lost
 * response; the sweep is disabled, so the owner gets a Retry). Computed on the server clock so a client's skew can
 * neither show nor hide it (4.4 review [M]).
 */
export type SendHistoryRow = SendRow & { lease_expired: boolean };
export type ShareLinkRow = Database["public"]["Views"]["v_share_links"]["Row"];

/**
 * The generated view type is all-nullable (Postgres cannot prove view columns non-null).
 * `campaign_id`, `external_id` and `source` come straight from `campaigns`' not-null
 * columns / a literal, so they are narrowed here — once — and the components rely on it.
 */
export type CampaignPerformanceRow = PerformanceRow & { campaign_id: string; external_id: string; source: string };

/** The five rate keys the campaign pages caption from `metric_rules` (D-5). */
export const RATE_KEYS = ["delivered_rate", "bounce_rate", "open_rate", "click_rate", "unsubscribe_rate"] as const satisfies readonly MetricKey[];
export type RateKey = (typeof RATE_KEYS)[number];
/** A `Record<MetricKey, MetricRule>` from `getMetricRules` satisfies this too. */
export type RateRules = Record<RateKey, MetricRule>;

function narrow(rows: PerformanceRow[]): Result<CampaignPerformanceRow[]> {
  const out: CampaignPerformanceRow[] = [];
  for (const row of rows) {
    if (row.campaign_id == null || row.external_id == null || row.source == null) {
      return { ok: false, message: "v_campaign_performance returned a row without campaign_id, external_id or source" };
    }
    out.push({ ...row, campaign_id: row.campaign_id, external_id: row.external_id, source: row.source });
  }
  return { ok: true, data: out };
}

/** Reported figures for every campaign in the brand, newest `sent_at` first (nulls last). */
export async function getCampaignList(supabase: Supabase): Promise<Result<CampaignPerformanceRow[]>> {
  const { data, error } = await supabase
    .from("v_campaign_performance")
    .select("*")
    .eq("source", "reported")
    .order("sent_at", { ascending: false, nullsFirst: false })
    .order("external_id");
  if (error) return { ok: false, message: error.message };
  return narrow(data ?? []);
}

/**
 * One campaign by id. `.maybeSingle()` — never `.single()` — so an id RLS does not return
 * (another brand's, or nobody's) is `data: null`, which the page turns into `notFound()`,
 * not into an error alert.
 */
export async function getCampaign(supabase: Supabase, id: string): Promise<Result<CampaignRow | null>> {
  const { data, error } = await supabase.from("campaigns").select("*").eq("id", id).maybeSingle();
  if (error) return { ok: false, message: error.message };
  return { ok: true, data };
}

/**
 * Every performance row for one campaign: the `reported` row first, then (from Story 6.2 on)
 * one `portal` row per send. Same query shape then as now — 6.2 only adds rows to the view.
 * `source` is ordered **descending** because `'reported' > 'portal'` alphabetically; a stable
 * in-memory pass then pins the contract even if the view's ordering ever changes.
 */
export async function getCampaignPerformance(supabase: Supabase, campaignId: string): Promise<Result<CampaignPerformanceRow[]>> {
  const { data, error } = await supabase
    .from("v_campaign_performance")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("source", { ascending: false })
    .order("send_id", { nullsFirst: true });
  if (error) return { ok: false, message: error.message };
  const rows = narrow(data ?? []);
  if (!rows.ok) return rows;
  const rank = (r: CampaignPerformanceRow) => (r.source === "reported" ? 0 : 1);
  return { ok: true, data: [...rows.data].sort((a, b) => rank(a) - rank(b)) };
}

/**
 * The five rate captions. A missing key is a failure, not a fallback: the UI never hard-codes
 * a rule's text (D-5), so a rate without its rule cannot be captioned and must not render.
 */
export async function getRateRules(supabase: Supabase): Promise<Result<RateRules>> {
  const { data, error } = await supabase.from("metric_rules").select("*").in("key", [...RATE_KEYS]);
  if (error) return { ok: false, message: error.message };
  const byKey: Partial<RateRules> = {};
  for (const rule of data ?? []) {
    if ((RATE_KEYS as readonly string[]).includes(rule.key)) byKey[rule.key as RateKey] = rule;
  }
  const missing = RATE_KEYS.filter((k) => !byKey[k]);
  if (missing.length > 0) return { ok: false, message: `metric_rules is missing: ${missing.join(", ")}` };
  return { ok: true, data: byKey as RateRules };
}

/**
 * The campaign's sends, newest first by the send date (Story 4.4; 4.5's `seed_send_log` rows come through the
 * same query): `confirmed_at desc nulls last, created_at desc` — a seed row is dated by its `confirmed_at` from
 * the send log, not by the seed run that inserted it. Plain `sends` rows through RLS plus the server-computed
 * `lease_expired` flag — the page re-runs this on every poll tick, so the list is always the server's read and
 * never a client-side guess at a status.
 */
export async function getCampaignSends(supabase: Supabase, campaignId: string, now: Date = new Date()): Promise<Result<SendHistoryRow[]>> {
  const { data, error } = await supabase
    .from("sends")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("confirmed_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: (data ?? []).map((send) => ({ ...send, lease_expired: isLeaseExpired(send, now) })) };
}

/** Stranded in `dispatched`: no `batch_id` and the lease ran out — nothing else will move it while the sweep is off. */
export function isLeaseExpired(send: Pick<SendRow, "status" | "batch_id" | "dispatch_lease_until">, now: Date): boolean {
  if (send.status !== "dispatched" || send.batch_id !== null || send.dispatch_lease_until === null) return false;
  const until = Date.parse(send.dispatch_lease_until);
  return Number.isFinite(until) && until < now.getTime();
}

/**
 * The campaign's share links, newest first (Story 5.2). `v_share_links` is the only read path
 * for brand users (5.1: `security_invoker`, no hash columns, `status` computed in SQL) — the page
 * renders the rows as read, and re-reads them after every publish / revoke through `revalidatePath`.
 */
export async function getCampaignShareLinks(supabase: Supabase, campaignId: string): Promise<Result<ShareLinkRow[]>> {
  const { data, error } = await supabase.from("v_share_links").select("*").eq("campaign_id", campaignId).order("created_at", { ascending: false });
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: data ?? [] };
}
