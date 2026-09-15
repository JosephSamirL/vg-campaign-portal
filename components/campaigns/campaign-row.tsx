import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import type { CampaignPerformanceRow, RateRules } from "@/lib/queries/campaigns";
import { formatCount, formatSpend } from "./format";
import { PerformanceCell } from "./performance-cell";

/** One `/campaigns` row: identity, the reported counts as loaded, then the five view rates. */
export function CampaignRow({ row, rules }: { row: CampaignPerformanceRow; rules: RateRules }) {
  return (
    <TableRow data-testid="campaign-row">
      <TableCell className="whitespace-nowrap">
        <Link href={`/campaigns/${row.campaign_id}`} className="font-medium hover:underline">
          {row.name ?? row.external_id}
        </Link>
        <div className="text-xs text-muted-foreground">{row.external_id}</div>
      </TableCell>
      <TableCell>{row.channel ? <Badge variant="secondary">{row.channel}</Badge> : "—"}</TableCell>
      <TableCell className="whitespace-nowrap">{formatDate(row.sent_at)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.sent)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.delivered)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.bounced)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.opens)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCount(row.clicks)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatSpend(row.spend)}</TableCell>
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
    </TableRow>
  );
}
