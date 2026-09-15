import { EmptyState } from "@/components/layout/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CampaignPerformanceRow, RateRules } from "@/lib/queries/campaigns";
import { formatCount } from "./format";
import { PerformanceCell } from "./performance-cell";

export type CampaignFiguresProps = { rows: CampaignPerformanceRow[]; rules: RateRules };

const COUNTS = [
  ["sent", "Sent"],
  ["delivered", "Delivered"],
  ["bounced", "Bounced"],
  ["opens", "Opens"],
  ["clicks", "Clicks"],
  ["unsubscribes", "Unsubscribes"],
] as const;

function blockTitle(row: CampaignPerformanceRow): string {
  if (row.source === "reported") return "Reported by the source";
  return `Portal send ${row.send_id ? row.send_id.slice(0, 8) : "—"}`;
}

/**
 * One block per `v_campaign_performance` row for this campaign: today only the `reported`
 * row; Story 6.2 adds a `portal` block per send through the same query, nothing here changes.
 * Counts as loaded, rates as the view computed them (D-5).
 */
export function CampaignFigures({ rows, rules }: CampaignFiguresProps) {
  if (rows.length === 0) {
    return <EmptyState title="No figures for this campaign" description="The performance view returned no row for it." />;
  }
  return (
    <div className="flex flex-col gap-4" data-testid="campaign-figures">
      {rows.map((row) => (
        <Card key={row.send_id ?? row.source}>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">{blockTitle(row)}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 p-4 pt-0">
            <dl className="grid grid-cols-3 gap-3 text-sm sm:grid-cols-6">
              {COUNTS.map(([key, label]) => (
                <div key={key} className="flex flex-col">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{formatCount(row[key])}</dd>
                </div>
              ))}
            </dl>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              <div className="flex flex-col items-start">
                <dt className="text-xs text-muted-foreground">{rules.delivered_rate.label}</dt>
                <dd><PerformanceCell rate={row.delivered_rate} count={row.delivered} rule={rules.delivered_rate} /></dd>
              </div>
              <div className="flex flex-col items-start">
                <dt className="text-xs text-muted-foreground">{rules.bounce_rate.label}</dt>
                <dd><PerformanceCell rate={row.bounce_rate} count={row.bounced} rule={rules.bounce_rate} /></dd>
              </div>
              <div className="flex flex-col items-start">
                <dt className="text-xs text-muted-foreground">{rules.open_rate.label}</dt>
                <dd><PerformanceCell rate={row.open_rate} count={row.opens} rule={rules.open_rate} /></dd>
              </div>
              <div className="flex flex-col items-start">
                <dt className="text-xs text-muted-foreground">{rules.click_rate.label}</dt>
                <dd><PerformanceCell rate={row.click_rate} count={row.clicks} rule={rules.click_rate} /></dd>
              </div>
              <div className="flex flex-col items-start">
                <dt className="text-xs text-muted-foreground">{rules.unsubscribe_rate.label}</dt>
                <dd><PerformanceCell rate={row.unsubscribe_rate} count={row.unsubscribes} rule={rules.unsubscribe_rate} /></dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
