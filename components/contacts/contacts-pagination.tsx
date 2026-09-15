import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import type { ContactsParams } from "@/lib/queries/contacts";

/** `/contacts?q=…&status=…&contactable=…&page=N` — the current filters, then the page. */
export function contactsHref(params: ContactsParams, page: number): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.contactable) search.set("contactable", params.contactable);
  search.set("page", String(Math.max(1, page)));
  return `/contacts?${search.toString()}`;
}

type Props = { page: number; pages: number; count: number; params: ContactsParams };

/**
 * Previous / Next as links that keep every filter (AC5), disabled at the bounds. `page` can
 * exceed `pages` (a stale link): the summary stays truthful and Previous lands on the last
 * real page. Counts come from `count: 'exact'` — this is never rendered for a failed query.
 */
export function ContactsPagination({ page, pages, count, params }: Props) {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const prevPage = Math.min(page - 1, pages);
  return (
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between" data-testid="contacts-pager">
      <p className="text-sm text-muted-foreground">
        Page {fmt(page)} of {fmt(pages)} · {fmt(count)} {count === 1 ? "contact" : "contacts"}
      </p>
      <Pagination className="mx-0 w-auto justify-start sm:justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href={contactsHref(params, prevPage)} disabled={page <= 1} />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext href={contactsHref(params, page + 1)} disabled={page >= pages} />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
