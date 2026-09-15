import { ContactsFilters } from "@/components/contacts/contacts-filters";
import { ContactsPagination } from "@/components/contacts/contacts-pagination";
import { ContactsTable } from "@/components/contacts/contacts-table";
import { EmptyState } from "@/components/layout/empty-state";
import { contactsParamsSchema, getContactableRule, getContactsPage } from "@/lib/queries/contacts";
import { createClient } from "@/lib/supabase/server";

// Never cached across users: under Next 16 Cache Components (`next.config.ts`) a page that awaits
// `searchParams` and the cookie session is request-time by construction, and the segment config
// `dynamic = 'force-dynamic'` the Dev Notes name is rejected in that mode ("not compatible with
// cacheComponents"), so it is deliberately absent — the (portal) layout already opts out of
// the static shell with `instant = false`.

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `/contacts?page=&q=&status=&contactable=` (FR-11, FR-15, NFR-3). A server component: the
 * URL is the only state (D-12), the boundary is total (`.catch()` per field, so a bad value is
 * a default, never a 500), and one server-side `range()` query on `v_contacts` returns the page
 * plus the exact count — 84k rows are never fetched and sliced here. RLS through the
 * security_invoker view is the brand isolation; no `brand_id` in app code.
 *
 * A failed list query is thrown to `./error.tsx` (destructive alert + Retry): an errored count
 * must never render as "0 contacts". A failed rule read only affects the header popover.
 */
export default async function ContactsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = contactsParamsSchema.parse(await searchParams);
  const supabase = await createClient();

  const [result, rule] = await Promise.all([getContactsPage(supabase, params), getContactableRule(supabase)]);
  if (!result.ok) throw new Error(result.message);

  const { rows, count, page, pages } = result.data;
  const filtered = Boolean(params.q || params.status || params.contactable);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <p className="text-sm text-muted-foreground">
          Every contact loaded for your brand, newest signup first. Search by name or email prefix; filter by status
          and whether the contact can be reached.
        </p>
      </div>

      <ContactsFilters params={params} />

      {rows.length === 0 ? (
        filtered || count > 0 ? (
          <EmptyState title="No contacts match" description="Nothing matches these filters. Change or clear them to see more." />
        ) : (
          <EmptyState title="No contacts loaded yet" description="Seed data has not been loaded for this brand." />
        )
      ) : (
        <ContactsTable rows={rows} contactableRule={rule.ok ? rule.data : null} />
      )}

      {(rows.length > 0 || filtered || count > 0) && (
        <ContactsPagination page={page} pages={pages} count={count} params={params} />
      )}
    </div>
  );
}
