"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Route error boundary for `/imports`: any query error thrown by the page lands here as a
 * destructive alert with a Retry. The page is read-only, so the copy can promise nothing
 * changed. Numbers are never rendered from a failed query (FR-15).
 *
 * Retry is Next 16's `retry` — `startTransition(() => { router.refresh(); reset() })` — so the
 * server render is re-run; `reset()` alone only clears the boundary and replays the same failure.
 */
export default function ImportsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("imports_error", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Imports</h1>
      <Alert variant="destructive" data-testid="imports-error">
        <AlertTitle>Something broke on our side — nothing was changed</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <p>The import report could not be read just now. Try again in a moment.</p>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
