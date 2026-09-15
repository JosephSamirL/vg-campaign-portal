import Link from "next/link";
import { EmptyState } from "@/components/layout/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Rendered by `notFound()` for a malformed id and for any id RLS returns no row for — which
 * is what another brand's campaign looks like from here (D-2). Same page for both on purpose:
 * it never confirms that the id exists somewhere else.
 */
export default function CampaignNotFound() {
  return (
    <div className="flex flex-col gap-4" data-testid="campaign-not-found">
      <h1 className="text-2xl font-semibold">Campaign</h1>
      <EmptyState title="No campaign with that id in your brand" description="Check the link, or pick a campaign from the list.">
        <Button asChild variant="outline" size="sm">
          <Link href="/campaigns">Back to campaigns</Link>
        </Button>
      </EmptyState>
    </div>
  );
}
