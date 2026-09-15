import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type CampaignSectionProps = {
  id: "sends" | "share-links";
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * The extension slot on `/campaigns/[id]`: a titled card with an action area (right) and a
 * body. Story 3.4 fills both sections with an empty state and disabled owner placeholders;
 * 4.4 / 4.5 swap the Sends slot for the confirm dialog and the send list, 5.2 swaps the
 * Share-links slot for the form and the list — `[id]/page.tsx` keeps its shape.
 */
export function CampaignSection({ id, title, action, children }: CampaignSectionProps) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} data-testid={`section-${id}`}>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-4">
          <CardTitle id={headingId} className="text-lg">
            {title}
          </CardTitle>
          {action && <div className="flex flex-wrap items-center gap-2" data-testid={`section-${id}-action`}>{action}</div>}
        </CardHeader>
        <CardContent className="p-4 pt-0">{children}</CardContent>
      </Card>
    </section>
  );
}
