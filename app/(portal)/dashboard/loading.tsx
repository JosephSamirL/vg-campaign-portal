import { Skeleton } from "@/components/ui/skeleton";

/** Skeletons in the dashboard's own layout: two tiles, the chart card, the table — visibly loading, never a 0. */
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="dashboard-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-xl border p-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-xl border p-4">
        <div className="flex justify-between">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-48" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
