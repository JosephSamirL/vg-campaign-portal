import { Badge } from "@/components/ui/badge";
import { renderRuleText } from "@/components/metrics/metric-caption";
import type { Database } from "@/lib/database.types";
import { formatInt } from "@/lib/format";

export type RecipientPreview = Database["public"]["Functions"]["recipient_preview"]["Returns"][number];

/** The three exclusion reasons, in the RPC's priority order (4.1: not_contactable → no_address → country). */
const EXCLUSIONS: Array<{ key: "not_contactable" | "no_address" | "country_mismatch_or_unknown"; label: string }> = [
  { key: "not_contactable", label: "Not contactable" },
  { key: "no_address", label: "No address for this channel" },
  { key: "country_mismatch_or_unknown", label: "Outside the target country, or country unknown" },
];

/**
 * The confirm screen's numbers (PRD §5 "Recipients (confirm screen)", FR16/17): the exact count
 * that would be sent, the excluded counts by reason, the channel / target country the rule was
 * applied with, and `metric_rules.recipients` verbatim. Every value is `recipient_preview`'s —
 * nothing is recomputed, summed or clamped here (anti-pattern list).
 */
export function SendPreview({ preview }: { preview: RecipientPreview }) {
  const total = Number(preview.total_count);
  return (
    <div className="flex flex-col gap-4" data-testid="send-preview">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-semibold tabular-nums" data-testid="send-preview-total">
          {formatInt(total)}
        </span>
        <span className="text-sm text-muted-foreground">{total === 1 ? "recipient" : "recipients"}</span>
      </div>

      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <div className="flex items-center gap-1">
          <dt>Channel</dt>
          <dd>
            <Badge variant="secondary">{preview.channel}</Badge>
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>Target country</dt>
          <dd data-testid="send-preview-country">{preview.target_country ?? "Any"}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Excluded</h3>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-sm" data-testid="send-preview-excluded">
          {EXCLUSIONS.map(({ key, label }) => (
            <div key={key} className="contents">
              <dt className="text-right tabular-nums" data-reason={key}>
                {formatInt(Number(preview[key]))}
              </dt>
              <dd className="text-muted-foreground">{label}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground" data-testid="send-preview-rule">
        {renderRuleText(preview.rule_text)}
      </p>
    </div>
  );
}
