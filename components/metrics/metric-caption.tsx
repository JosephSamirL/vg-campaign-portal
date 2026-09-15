import { Fragment } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MetricRule } from "@/lib/rules/metric-rules";

export type MetricCaptionProps = { rule: MetricRule; showAlternative?: boolean };

/**
 * `metric_rules.rule_text` is PRD §5 verbatim, with `**bold**` and `` `code` `` spans. Render
 * those as markup and everything else character-for-character — the caption IS the rule (D-5),
 * so nothing is added, dropped or paraphrased here.
 */
export function renderRuleText(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-muted px-1 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/**
 * The rule beside a number, small and muted. `showAlternative` adds "Not: {alternative_text}"
 * — the counting choice that was NOT made — in a hover/focus tooltip on wider screens and
 * inline on phones, where there is no hover.
 */
export function MetricCaption({ rule, showAlternative = false }: MetricCaptionProps) {
  const alternative = `Not: ${rule.alternative_text}`;
  return (
    <span className="text-xs leading-relaxed text-muted-foreground" data-metric-key={rule.key}>
      <span>{renderRuleText(rule.rule_text)}</span>
      {showAlternative && (
        <>
          <Tooltip className="ml-1 hidden md:inline-flex">
            <TooltipTrigger aria-label="What this number is not">not…</TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              {alternative}
            </TooltipContent>
          </Tooltip>
          <span className="mt-1 block md:hidden" data-testid="caption-alternative">
            {alternative}
          </span>
        </>
      )}
    </span>
  );
}
