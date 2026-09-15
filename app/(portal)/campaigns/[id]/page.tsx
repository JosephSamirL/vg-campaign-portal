import { notFound } from "next/navigation";
import { z } from "zod";
import { CampaignFigures } from "@/components/campaigns/campaign-figures";
import { CampaignHeader } from "@/components/campaigns/campaign-header";
import { CampaignSection } from "@/components/campaigns/campaign-section";
import { SendHistory } from "@/components/campaigns/send-history";
import { RetryAlert } from "@/components/layout/retry-alert";
import { SendConfirmDialog } from "@/components/send/send-confirm-dialog";
import { ShareLinkForm } from "@/components/share/share-link-form";
import { ShareLinkList } from "@/components/share/share-link-list";
import { Separator } from "@/components/ui/separator";
import { getCurrentAppUser } from "@/lib/current-user";
import { getCampaign, getCampaignPerformance, getCampaignSends, getCampaignShareLinks, getRateRules } from "@/lib/queries/campaigns";
import { createClient } from "@/lib/supabase/server";

// Brand data under a cookie session is never cached across users: the (portal) layout opts
// the whole segment out of the static shell (`instant = false`, Cache Components) and every
// read below goes through the cookie session. `export const dynamic = "force-dynamic"` is
// rejected by Next 16 when `cacheComponents` is on, so it is deliberately absent here.

const idSchema = z.uuid();

/**
 * `/campaigns/[id]` — one campaign with its reported figures, its sends (Story 4.4: the Send
 * button + confirm dialog for an owner, the history with its status poll for everyone; 4.5 adds
 * the seed send-log rows) and the share links (Story 5.2: "Publish results" + the once-shown URL
 * for an owner, the `v_share_links` rows with Revoke for everyone / owner). The id is validated before any query;
 * a row RLS does not return (another brand's, or nobody's) is `null` → `notFound()` → the route's
 * `not-found.tsx` (D-2: "no row", never an error). The owner-only controls are gated on the
 * server-side session role (Story 1.5's helper), never on anything from the client — and the
 * RPCs refuse an analyst regardless (FR22: UI hides, DB refuses).
 */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();

  const supabase = await createClient();
  const [campaign, perf, rules, sends, links, me] = await Promise.all([
    getCampaign(supabase, id),
    getCampaignPerformance(supabase, id),
    getRateRules(supabase),
    getCampaignSends(supabase, id),
    getCampaignShareLinks(supabase, id),
    getCurrentAppUser(),
  ]);

  if (!campaign.ok) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Campaign</h1>
        <RetryAlert title="This campaign could not be loaded" message={campaign.message} />
      </div>
    );
  }
  if (campaign.data === null) notFound();

  const isOwner = me?.role === "owner";

  return (
    <div className="flex flex-col gap-6">
      <CampaignHeader campaign={campaign.data} />
      <Separator />

      {!perf.ok ? (
        <RetryAlert title="Figures could not be loaded" message={perf.message} />
      ) : !rules.ok ? (
        <RetryAlert title="Metric definitions could not be loaded" message={rules.message} />
      ) : (
        <CampaignFigures rows={perf.data} rules={rules.data} />
      )}

      <CampaignSection
        id="sends"
        title="Sends"
        action={isOwner ? <SendConfirmDialog campaignId={campaign.data.id} campaignLabel={campaign.data.name ?? campaign.data.external_id} /> : null}
      >
        {!sends.ok ? (
          <RetryAlert title="Sends could not be loaded" message={sends.message} />
        ) : (
          <SendHistory sends={sends.data} isOwner={isOwner} />
        )}
      </CampaignSection>

      <CampaignSection
        id="share-links"
        title="Share links"
        action={isOwner ? <ShareLinkForm campaignId={campaign.data.id} campaignLabel={campaign.data.name ?? campaign.data.external_id} /> : null}
      >
        {!links.ok ? (
          <RetryAlert title="Share links could not be loaded" message={links.message} />
        ) : (
          <ShareLinkList links={links.data} isOwner={isOwner} />
        )}
      </CampaignSection>
    </div>
  );
}
