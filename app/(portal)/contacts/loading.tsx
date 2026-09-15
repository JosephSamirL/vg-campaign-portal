import { Skeleton } from "@/components/ui/skeleton";

/** Ten skeleton rows while the page is read — visibly "still loading", never an empty table (AC4). */
export default function ContactsLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="contacts-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Skeleton className="h-9 w-full sm:w-64" />
        <Skeleton className="h-9 w-full sm:w-36" />
        <Skeleton className="h-9 w-full sm:w-28" />
        <Skeleton className="h-9 w-20" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
