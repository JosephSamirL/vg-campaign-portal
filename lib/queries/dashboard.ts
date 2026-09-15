import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { MetricKey } from "@/lib/rules/keys";
import { getMetricRules, type MetricRule, type Result } from "@/lib/rules/metric-rules";

export type { MetricRule, Result };

export type PerformanceRow = Database["public"]["Views"]["v_campaign_performance"]["Row"];

export type DashboardTotals = { total_customers: number; contactable: number };

export type SignupsData = {
  days: { day: string; signups: number }[];
  window_start: string;
  window_end: string;
  future_dated_count: number;
  last_signup_at: string | null;
};

export type DashboardData = {
  rules: Result<Record<MetricKey, MetricRule>>;
  /** `null` = the brand has no `v_dashboard_totals` row (zero contacts): empty, not an error. */
  totals: Result<DashboardTotals | null>;
  signups: Result<SignupsData>;
  performance: Result<PerformanceRow[]>;
};

type Supabase = SupabaseClient<Database>;

/*
 * Every helper maps a Supabase `error` (supabase-js never throws) to `{ ok:false }` for its own
 * section, so one failing view takes down one section of the page and nothing else. Counts are
 * narrowed with `?? 0` ONLY after a successful query — an errored section never carries a number.
 * Reads go through the cookie-session client, so RLS scopes everything to the caller's brand.
 */

async function getTotals(supabase: Supabase): Promise<Result<DashboardTotals | null>> {
  const { data, error } = await supabase.from("v_dashboard_totals").select("total_customers, contactable").maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: true, data: null };
  return { ok: true, data: { total_customers: data.total_customers ?? 0, contactable: data.contactable ?? 0 } };
}

/** ISO instant of the first moment after the window: `window_end` + 1 day at 00:00 UTC. */
function windowEndExclusive(windowEnd: string): string {
  const d = new Date(`${windowEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

async function getSignups(supabase: Supabase): Promise<Result<SignupsData>> {
  const { data, error } = await supabase
    .from("v_signups_30d")
    .select("day, signups, window_start, window_end, future_dated_count")
    .order("day");
  if (error) return { ok: false, message: error.message };

  const rows = (data ?? []).filter((r): r is typeof r & { day: string } => r.day !== null);
  // The view cross-joins the caller's brand with 30 generated days; nothing back means the
  // query did not run as the brand's user, which is a failure, not "no signups".
  const first = rows[0];
  if (!first?.window_start || !first.window_end) return { ok: false, message: "v_signups_30d returned no window rows" };

  const days = rows.map((r) => ({ day: r.day, signups: r.signups ?? 0 }));
  const window_end = first.window_end;
  const total = days.reduce((sum, d) => sum + d.signups, 0);

  // Only an empty window needs the "last signup" date for its sentence. `lt` on the window's
  // exclusive end keeps future-dated rows (and nulls) out of it.
  let last_signup_at: string | null = null;
  if (total === 0) {
    const last = await supabase
      .from("v_contacts")
      .select("signup_at")
      .lt("signup_at", windowEndExclusive(window_end))
      .order("signup_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (last.error) return { ok: false, message: last.error.message };
    last_signup_at = last.data?.signup_at ?? null;
  }

  return {
    ok: true,
    data: { days, window_start: first.window_start, window_end, future_dated_count: first.future_dated_count ?? 0, last_signup_at },
  };
}

async function getPerformance(supabase: Supabase): Promise<Result<PerformanceRow[]>> {
  const { data, error } = await supabase
    .from("v_campaign_performance")
    .select("*")
    .eq("source", "reported")
    .order("sent_at", { ascending: false, nullsFirst: false });
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: data ?? [] };
}

/** The four dashboard reads in parallel, each with its own outcome (D-12 per-section states). */
export async function getDashboardData(supabase: Supabase): Promise<DashboardData> {
  const [rules, totals, signups, performance] = await Promise.all([
    getMetricRules(supabase),
    getTotals(supabase),
    getSignups(supabase),
    getPerformance(supabase),
  ]);
  return { rules, totals, signups, performance };
}
