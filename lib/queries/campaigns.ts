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
