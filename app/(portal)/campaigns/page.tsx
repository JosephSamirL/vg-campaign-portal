import { Fragment } from "react";
import { CampaignRow } from "@/components/campaigns/campaign-row";
import { LastSynced } from "@/components/campaigns/last-synced";
import { RuleCaption } from "@/components/campaigns/performance-cell";
import { PortalSendRow } from "@/components/campaigns/portal-send-row";
import { SyncStatusAlert } from "@/components/campaigns/sync-status-alert";
import { EmptyState } from "@/components/layout/empty-state";
import { RetryAlert } from "@/components/layout/retry-alert";
import { Table, TableBody, TableCaption, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getCampaignList,
  getLastPollStatus,
  getLastSync,
  getPortalSendRows,
  getRateRules,
  RATE_KEYS,
  syncWarning,
  type CampaignPerformanceRow,
  type RateRules,
} from "@/lib/queries/campaigns";
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

/** The portal-send rows grouped under their campaign, in the order the view returned them (newest dispatch first). */
function groupBySend(rows: CampaignPerformanceRow[]): Map<string, CampaignPerformanceRow[]> {
  const byCampaign = new Map<string, CampaignPerformanceRow[]>();
  for (const row of rows) {
    const list = byCampaign.get(row.campaign_id) ?? [];
    list.push(row);
    byCampaign.set(row.campaign_id, list);
  }
  return byCampaign;
}

/**
 * `/campaigns` — every campaign in the caller's brand with the seed's reported counts and the
 * five rates `v_campaign_performance` computes from them (FR-12, D-5), and beneath each campaign
 * its portal sends with the live delivered / bounced / opened / clicked / unsubscribed figures the
 * poller ingested (Story 6.3). "Reports last synced …" comes from `v_last_sync`; the muted warning
 * from `last_poll_status()` when the newest poll run did not succeed; a failed read of either
 * renders "Sync status unavailable" — never a fake "synced". Read-only; the send and share
 * actions live on `/campaigns/[id]`.
 */
export default async function CampaignsPage() {
  const supabase = await createClient();
  const [list, rules, portal, sync, pollStatus] = await Promise.all([
    getCampaignList(supabase),
    getRateRules(supabase),
    getPortalSendRows(supabase),
    getLastSync(supabase),
    getLastPollStatus(supabase),
  ]);
  const sendsByCampaign = portal.ok ? groupBySend(portal.data) : new Map<string, CampaignPerformanceRow[]>();
  const anyPortal = portal.ok && portal.data.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Campaigns</h1>
        <p className="text-sm text-muted-foreground">
          Every campaign for your brand with its channel, send date, spend and reported performance. Pick one to send
          or to share.
        </p>
        {!sync.ok || !pollStatus.ok ? (
          <SyncStatusAlert message={!sync.ok ? sync.message : !pollStatus.ok ? pollStatus.message : ""} />
        ) : (
          <LastSynced last_ok_at={sync.data?.last_ok_at ?? null} warning={syncWarning(pollStatus.data?.status, sync.data?.last_ok_at)} />
        )}
      </div>

      {!portal.ok && <RetryAlert title="Portal sends could not be loaded" message={portal.message} />}

      {!list.ok ? (
        <RetryAlert title="Campaigns could not be loaded" message={list.message} />
      ) : !rules.ok ? (
        <RetryAlert title="Metric definitions could not be loaded" message={rules.message} />
      ) : list.data.length === 0 ? (
        <EmptyState title="No campaigns loaded yet" description="Seed data has not been loaded for this brand." />
      ) : (
        <Table data-testid="campaigns-table" className="min-w-[1120px]">
          <TableCaption>
            Campaign rows: {REPORTED_SOURCE_CAPTION}.{anyPortal && " Portal send rows: live figures from the provider's delivery reports."}
          </TableCaption>
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
              <Fragment key={row.campaign_id}>
                <CampaignRow row={row} rules={rules.data} />
                {(sendsByCampaign.get(row.campaign_id) ?? []).map((send) => (
                  <PortalSendRow key={send.send_id ?? `${row.campaign_id}-portal`} row={send} rules={rules.data} />
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
