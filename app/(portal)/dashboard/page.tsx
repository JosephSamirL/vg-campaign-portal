import Link from "next/link";
import { RetryAlert } from "@/components/layout/retry-alert";
import { EmptyState } from "@/components/layout/empty-state";
import { MetricCaption } from "@/components/metrics/metric-caption";
import { MetricTile } from "@/components/metrics/metric-tile";
import { SignupsChart } from "@/components/metrics/signups-chart";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDate, formatInt, formatPercent } from "@/lib/format";
import { getDashboardData, type MetricRule, type PerformanceRow, type Result } from "@/lib/queries/dashboard";
import type { MetricKey } from "@/lib/rules/keys";
import { REPORTED_SOURCE_CAPTION } from "@/lib/rules/keys";
import { createClient } from "@/lib/supabase/server";

// Every number here is the caller's brand under RLS; nothing may be cached across users.
// Next 16 with Cache Components rejects `dynamic = "force-dynamic"`; the equivalent is to opt
// the segment out of the instant (static) shell — the page then renders per request.
export const instant = false;

type Rules = Record<MetricKey, MetricRule>;

const RATE_COLUMNS = [
  ["delivered_rate", "delivered_rate"],
  ["bounce_rate", "bounce_rate"],
  ["open_rate", "open_rate"],
  ["click_rate", "click_rate"],
  ["unsubscribe_rate", "unsubscribe_rate"],
] as const satisfies ReadonlyArray<readonly [MetricKey, keyof PerformanceRow]>;

/** A rate column header: the label from `metric_rules`, its rule in a tooltip. */
function RateHead({ rule }: { rule: MetricRule }) {
  return (
    <TableHead className="text-right">
      <Tooltip>
        <TooltipTrigger>{rule.label}</TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          <MetricCaption rule={rule} />
        </TooltipContent>
      </Tooltip>
    </TableHead>
  );
}

function PerformanceTable({ rows, rules }: { rows: PerformanceRow[]; rules: Rules }) {
  if (rows.length === 0) return <EmptyState title="No campaigns loaded yet" description="Campaign performance appears once a campaign file has been imported." />;
  return (
    <div className="overflow-x-auto">
      <Table data-testid="performance-table" className="min-w-[720px]">
        <TableCaption className="text-left">{REPORTED_SOURCE_CAPTION}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Campaign</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Sent on</TableHead>
            <TableHead className="text-right">Sent</TableHead>
            {RATE_COLUMNS.map(([key]) => (
              <RateHead key={key} rule={rules[key]} />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.campaign_id ?? row.external_id ?? row.name ?? undefined}>
              <TableCell className="whitespace-nowrap">
                {row.campaign_id ? (
                  <Link href={`/campaigns/${row.campaign_id}`} className="underline-offset-4 hover:underline">
                    {row.name ?? row.external_id}
                  </Link>
                ) : (
                  (row.name ?? row.external_id ?? "—")
                )}
                {row.external_id && row.name && !row.name.includes(row.external_id) && (
                  <span className="ml-2 text-xs text-muted-foreground">{row.external_id}</span>
                )}
              </TableCell>
              <TableCell>{row.channel ? <Badge variant="secondary">{row.channel}</Badge> : "—"}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(row.sent_at)}</TableCell>
              <TableCell className="text-right tabular-nums">{row.sent === null ? "—" : formatInt(row.sent)}</TableCell>
              {RATE_COLUMNS.map(([key, column]) => (
                <TableCell key={key} className="text-right tabular-nums" data-rate={key}>
                  {formatPercent(row[column] as number | null)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** A section whose own query failed: destructive alert with Retry, inside the section only. */
function SectionError({ label, message }: { label: string; message: string }) {
  return <RetryAlert title={`${label} could not be read`} message={message} />;
}

/**
 * `/dashboard` — the brand's growth picture: two headline tiles, the 30-day signups chart and
 * how each campaign performed, each number captioned from `metric_rules` (D-5). Reads through
 * the cookie-session server client (RLS), one `Result` per section: a failed view takes down
 * its own section with a Retry and never renders a `0` (D-12). The layout already enforces the
 * session and brand.
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const { rules, totals, signups, performance } = await getDashboardData(supabase);

  // Without the rules there are no captions, and a number without its rule is not shown:
  // a failed `metric_rules` read puts every section into its error state.
  const withRules = <T,>(section: Result<T>): Result<T> => (rules.ok ? section : rules);
  const totalsR = withRules(totals);
  const signupsR = withRules(signups);
  const performanceR = withRules(performance);
  const label = (key: MetricKey, fallback: string) => (rules.ok ? rules.data[key].label : fallback);

  const tile = (key: "total_customers" | "contactable", fallback: string) => {
    if (!totalsR.ok || !rules.ok) {
      return <MetricTile label={label(key, fallback)} caption={null} state="error" message={totalsR.ok ? "" : totalsR.message} />;
    }
    const caption = <MetricCaption rule={rules.data[key]} showAlternative />;
    if (totalsR.data === null) {
      return <MetricTile label={rules.data[key].label} caption={caption} state="empty" value={0} sentence="No contacts loaded yet" />;
    }
    return <MetricTile label={rules.data[key].label} caption={caption} state="ok" value={totalsR.data[key]} />;
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Every number with the rule it was counted by.</p>
        </div>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-label="Customers">
          {tile("total_customers", "Total customers")}
          {tile("contactable", "Contactable")}
        </section>

        <section aria-label="Signups">
          {signupsR.ok && rules.ok ? (
            <SignupsChart
              label={rules.data.signups_30d.label}
              days={signupsR.data.days}
              window_start={signupsR.data.window_start}
              window_end={signupsR.data.window_end}
              future_dated_count={signupsR.data.future_dated_count}
              last_signup_at={signupsR.data.last_signup_at}
              caption={<MetricCaption rule={rules.data.signups_30d} showAlternative />}
            />
          ) : (
            <SectionError label={label("signups_30d", "Signups")} message={signupsR.ok ? "" : signupsR.message} />
          )}
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="performance-heading">
          <h2 id="performance-heading" className="text-lg font-semibold">
            Campaign performance
          </h2>
          {performanceR.ok && rules.ok ? (
            <PerformanceTable rows={performanceR.data} rules={rules.data} />
          ) : (
            <SectionError label="Campaign performance" message={performanceR.ok ? "" : performanceR.message} />
          )}
        </section>
      </div>
    </TooltipProvider>
  );
}
