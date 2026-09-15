"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Route error boundary for `/share/[token]` (Story 5.3, AC6): an unexpected render failure
 * lands here as the fixed sentence plus Try again. It prints neither `error.message` nor the
 * URL — either could carry the token — and logs only the digest. Nothing was changed: the door
 * never writes (the attempt ledger is the RPC's own, inside the action path).
 *
 * Retry is Next 16's `retry` — `startTransition(() => { router.refresh(); reset() })` — so the
 * server render is re-run; `reset()` alone only clears the boundary and replays the same failure.
 */
export default function ShareError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("share_error", error.digest ?? "no-digest");
  }, [error]);

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <Alert variant="destructive" data-testid="share-error">
          <AlertTitle>Something broke on our side — nothing was changed.</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>Try again in a moment.</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}
