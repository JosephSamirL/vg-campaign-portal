import { CampaignRow } from "@/components/campaigns/campaign-row";
import { LastSynced } from "@/components/campaigns/last-synced";
import { RuleCaption } from "@/components/campaigns/performance-cell";
import { EmptyState } from "@/components/layout/empty-state";
import { RetryAlert } from "@/components/layout/retry-alert";
import { Table, TableBody, TableCaption, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getCampaignList, getRateRules, RATE_KEYS, type RateRules } from "@/lib/queries/campaigns";
import { REPORTED_SOURCE_CAPTION } from "@/lib/rules/keys";
import { createClient } from "@/lib/supabase/server";

// Brand data under a cookie session is never cached across users: the (portal) layout opts
// the whole segment out of the static shell (`instant = false`, Cache Components) and every
// read below goes through the cookie session. `export const dynamic = "force-dynamic"` is
// rejected by Next 16 when `cacheComponents` is on, so it is deliberately absent here.

const COUNT_HEADERS = ["Sent", "Delivered", "Bounced", "Opens", "Clicks", "Spend"] as const;

function RateHead({ rules, k }: { rules: RateRules; k: (typeof RATE_KEYS)[number] }) {
  const rule = rules[k];
  return (
    <TableHead className="text-right">
      <Tooltip>
        <TooltipTrigger>{rule.label}</TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          <RuleCaption rule={rule} />
        </TooltipContent>
      </Tooltip>
    </TableHead>
  );
}

/**
 * `/campaigns` — every campaign in the caller's brand with the seed's reported counts and the
 * five rates `v_campaign_performance` computes from them (FR-12, D-5). Read-only; the send and
 * share actions live on `/campaigns/[id]`. Portal-send rows and the real "last synced" value
 * arrive with Epic 6 through the same components.
 */
export default async function CampaignsPage() {
  const supabase = await createClient();
  const [list, rules] = await Promise.all([getCampaignList(supabase), getRateRules(supabase)]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Campaigns</h1>
        <p className="text-sm text-muted-foreground">
          Every campaign for your brand with its channel, send date, spend and reported performance. Pick one to send
          or to share.
        </p>
        <LastSynced last_ok_at={null} />
      </div>

      {!list.ok ? (
        <RetryAlert title="Campaigns could not be loaded" message={list.message} />
      ) : !rules.ok ? (
        <RetryAlert title="Metric definitions could not be loaded" message={rules.message} />
      ) : list.data.length === 0 ? (
        <EmptyState title="No campaigns loaded yet" description="Seed data has not been loaded for this brand." />
      ) : (
        <Table data-testid="campaigns-table">
          <TableCaption>{REPORTED_SOURCE_CAPTION}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Sent on</TableHead>
              {COUNT_HEADERS.map((h) => (
                <TableHead key={h} className="text-right">
                  {h}
                </TableHead>
              ))}
              {RATE_KEYS.map((k) => (
                <RateHead key={k} rules={rules.data} k={k} />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.map((row) => (
              <CampaignRow key={row.campaign_id} row={row} rules={rules.data} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
