/**
 * The nine `metric_rules.key` values seeded by `0005_metrics.sql` (PRD §5). Every number the
 * portal shows is captioned from its row — the UI never re-types a rule (D-5).
 */
export const METRIC_KEYS = [
  "total_customers",
  "contactable",
  "signups_30d",
  "delivered_rate",
  "bounce_rate",
  "open_rate",
  "click_rate",
  "unsubscribe_rate",
  "recipients",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/** Caption of the campaign performance table: seed campaigns carry the source's own `reported_*` counts. */
export const REPORTED_SOURCE_CAPTION = "as reported by the source";
