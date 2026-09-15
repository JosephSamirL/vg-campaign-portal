import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton while the list is read — visibly "still loading", never an empty table (D-12). */
export default function CampaignsLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="campaigns-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
