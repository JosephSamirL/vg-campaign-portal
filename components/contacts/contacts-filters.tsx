import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CONTACT_STATUSES, type ContactsParams } from "@/lib/queries/contacts";

const STATUS_LABEL: Record<(typeof CONTACT_STATUSES)[number], string> = {
  active: "active",
  pending: "pending",
  bounced: "bounced",
  unsubscribed: "unsubscribed",
  unknown: "unknown (blank)",
};

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm sm:w-auto";

/**
 * Plain GET form (D-12: every filter lives only in the URL, so a filtered page is a link that
 * can be shared or reloaded, and the form works without JavaScript). There is deliberately no
 * `page` field: changing a filter always starts from page 1. Stacks at phone width (AC7).
 */
export function ContactsFilters({ params }: { params: ContactsParams }) {
  return (
    <form method="get" action="/contacts" className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end" data-testid="contacts-filters">
      <label className="flex flex-col gap-1 text-sm sm:min-w-64">
        <span className="text-muted-foreground">Search</span>
        <Input type="search" name="q" defaultValue={params.q} maxLength={64} placeholder="Name or email" autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Status</span>
        <select name="status" defaultValue={params.status ?? ""} className={selectClass}>
          <option value="">All</option>
          {CONTACT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Contactable</span>
        <select name="contactable" defaultValue={params.contactable ?? ""} className={selectClass}>
          <option value="">All</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="default" className="flex-1 sm:flex-none">
          Filter
        </Button>
        <Button asChild variant="ghost" className="flex-1 sm:flex-none">
          <Link href="/contacts">Clear</Link>
        </Button>
      </div>
    </form>
  );
}
