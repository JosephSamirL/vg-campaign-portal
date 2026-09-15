import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { METRIC_KEYS, type MetricKey } from "@/lib/rules/keys";

/** Per-section query outcome. A section that is not `ok` renders an error state, never a number. */
export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export type MetricRule = Database["public"]["Tables"]["metric_rules"]["Row"];

/**
 * Reads `metric_rules` (shared, readable by any signed-in user) and indexes it by key. A missing
 * key is an error, not a fallback: the caption is the rule, and a hard-coded stand-in would be
 * exactly the "which way you counted" drift D-5 forbids.
 */
export async function getMetricRules(supabase: SupabaseClient<Database>): Promise<Result<Record<MetricKey, MetricRule>>> {
  const { data, error } = await supabase.from("metric_rules").select("*");
  if (error) return { ok: false, message: error.message };

  const byKey = new Map((data ?? []).map((row) => [row.key, row] as const));
  const missing = METRIC_KEYS.filter((key) => !byKey.has(key));
  if (missing.length > 0) return { ok: false, message: `metric_rules is missing: ${missing.join(", ")}` };

  const rules = Object.fromEntries(METRIC_KEYS.map((key) => [key, byKey.get(key)!])) as Record<MetricKey, MetricRule>;
  return { ok: true, data: rules };
}
