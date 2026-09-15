import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton for the detail page: header, one figures block, the two sections. */
export default function CampaignLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="campaign-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}
