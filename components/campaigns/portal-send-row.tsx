import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { hasLiveFigures, type CampaignPerformanceRow, type RateRules } from "@/lib/queries/campaigns";
import { formatCount } from "./format";
import { PerformanceCell } from "./performance-cell";

export const NO_REPORTS_YET = "No reports yet";

/**
 * One portal send beneath its campaign on `/campaigns` (Story 6.3 AC5): the `source = 'portal'` row of
 * `v_campaign_performance` — `sent = accepted_count`, delivered / bounced / opens / clicks from the provider's
 * delivery reports as the poller ingested them, the five rates as the view computed them (D-5, captioned from
 * `metric_rules` through `PerformanceCell`). A send with no report yet reads "No reports yet" across the figure
 * columns — an empty state, never a row of zeros and 0.00 %. Spend belongs to the campaign, not the send.
 */
export function PortalSendRow({ row, rules }: { row: CampaignPerformanceRow; rules: RateRules }) {
  const live = hasLiveFigures(row);
  return (
    <TableRow data-testid="portal-send-row" data-send-id={row.send_id ?? undefined} data-live={live ? "true" : "false"} className="bg-muted/30">
      <TableCell className="whitespace-nowrap pl-8">
        <Link href={`/campaigns/${row.campaign_id}#sends`} className="text-sm hover:underline">
          <Badge variant="outline" className="mr-2">
            Portal send
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">{row.send_id ? row.send_id.slice(0, 8) : "—"}</span>
        </Link>
      </TableCell>
      <TableCell>{row.channel ? <Badge variant="secondary">{row.channel}</Badge> : "—"}</TableCell>
      <TableCell className="whitespace-nowrap">{formatDate(row.dispatched_at)}</TableCell>
      {live ? (
        <>
          <TableCell className="text-right tabular-nums">{formatCount(row.sent)}</TableCell>
          <TableCell className="text-right tabular-nums">{formatCount(row.delivered)}</TableCell>
          <TableCell className="text-right tabular-nums">{formatCount(row.bounced)}</TableCell>
          <TableCell className="text-right tabular-nums">{formatCount(row.opens)}</TableCell>
          <TableCell className="text-right tabular-nums">{formatCount(row.clicks)}</TableCell>
          <TableCell className="text-right text-muted-foreground">—</TableCell>
          <TableCell className="text-right">
            <PerformanceCell rate={row.delivered_rate} rule={rules.delivered_rate} />
          </TableCell>
          <TableCell className="text-right">
            <PerformanceCell rate={row.bounce_rate} rule={rules.bounce_rate} />
          </TableCell>
          <TableCell className="text-right">
            <PerformanceCell rate={row.open_rate} rule={rules.open_rate} />
          </TableCell>
          <TableCell className="text-right">
            <PerformanceCell rate={row.click_rate} rule={rules.click_rate} />
          </TableCell>
          <TableCell className="text-right">
            <PerformanceCell rate={row.unsubscribe_rate} rule={rules.unsubscribe_rate} />
          </TableCell>
        </>
      ) : (
        <>
          <TableCell className="text-right tabular-nums">{formatCount(row.sent)}</TableCell>
          <TableCell colSpan={10} className="text-sm text-muted-foreground" data-testid="portal-send-empty">
            {NO_REPORTS_YET}
          </TableCell>
        </>
      )}
    </TableRow>
  );
}
