import { MetricCaption } from "@/components/metrics/metric-caption";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatPercent } from "@/lib/format";
import type { MetricRule } from "@/lib/queries/campaigns";
import { formatCount } from "./format";

export type PerformanceCellProps = { rate: number | null; count?: number | null; rule: MetricRule };

/**
 * One rate as the view reports it (D-5: printed, never recomputed, never clamped — Kilele's
 * open rate really is 119.16 %), with the count it came from muted beneath when given, and
 * the `metric_rules` caption in a hover/focus tooltip. A null rate (`sent = 0`, or unsubscribes
 * on a reported row) is an em dash, not 0 %.
 */
export function PerformanceCell({ rate, count, rule }: PerformanceCellProps) {
  const value = formatPercent(rate);
  return (
    <span className="inline-flex flex-col items-end" data-testid={`rate-${rule.key}`}>
      <Tooltip className="tabular-nums">
        <TooltipTrigger aria-label={`${rule.label}: ${value}`}>{value}</TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          <RuleCaption rule={rule} />
        </TooltipContent>
      </Tooltip>
      {count !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{formatCount(count)}</span>}
    </span>
  );
}

/**
 * Tooltip body: the rule (via the shared `MetricCaption`) and the counting choice that was NOT
 * made. The alternative is printed here rather than through `showAlternative`, whose own
 * hover trigger cannot open from inside a tooltip bubble.
 */
export function RuleCaption({ rule }: { rule: MetricRule }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="font-medium text-foreground">{rule.label}</span>
      <MetricCaption rule={rule} />
      <span className="text-muted-foreground" data-testid="caption-alternative">
        Not: {rule.alternative_text}
      </span>
    </span>
  );
}
