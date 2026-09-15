import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton rows while the run list is read — visibly "still loading", never an empty table. */
export default function ImportsLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="imports-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
