import Link from "next/link";
import { EmptyState } from "@/components/layout/empty-state";
import { Button } from "@/components/ui/button";

/**
 * The root 404 (Story 7.1, AC2): any path no route owns, and any `notFound()` thrown outside a
 * segment with its own `not-found.tsx` (`/campaigns/[id]` keeps its own). A muted "nothing here"
 * sentence, deliberately not the destructive error alert — an unknown address is not a failure —
 * and one way back. `/dashboard` is behind the proxy, so a signed-out visitor lands on `/login`.
 */
export default function RootNotFound() {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-4 sm:p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-4" data-testid="root-not-found">
        <EmptyState title="Page not found" description="There is nothing at this address. Check the link, or go back to your dashboard.">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard">Go to the dashboard</Link>
          </Button>
        </EmptyState>
      </div>
    </div>
  );
}
