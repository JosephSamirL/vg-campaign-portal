import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import type { CampaignRow } from "@/lib/queries/campaigns";
import { formatSpend } from "./format";

export type CampaignHeaderProps = { campaign: CampaignRow; actions?: React.ReactNode };

/**
 * The campaign's identity at the top of `/campaigns/[id]`. `actions` is the slot Epics 4/5
 * fill with owner-only controls; it wraps under the title at phone width.
 */
export function CampaignHeader({ campaign, actions }: CampaignHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4" data-testid="campaign-header">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="break-words text-2xl font-semibold">{campaign.name ?? campaign.external_id}</h1>
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <div className="flex items-center gap-1">
            <dt className="sr-only">External id</dt>
            <dd>{campaign.external_id}</dd>
          </div>
          <div className="flex items-center gap-1">
            <dt className="sr-only">Channel</dt>
            <dd>{campaign.channel ? <Badge variant="secondary">{campaign.channel}</Badge> : "—"}</dd>
          </div>
          <div className="flex items-center gap-1">
            <dt>Country</dt>
            <dd>{campaign.target_country ?? "—"}</dd>
          </div>
          <div className="flex items-center gap-1">
            <dt>Sent</dt>
            <dd>{formatDate(campaign.sent_at)}</dd>
          </div>
          <div className="flex items-center gap-1">
            <dt>Spend</dt>
            <dd className="tabular-nums">{formatSpend(campaign.spend)}</dd>
          </div>
        </dl>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2" data-testid="campaign-header-actions">
          {actions}
        </div>
      )}
    </header>
  );
}
