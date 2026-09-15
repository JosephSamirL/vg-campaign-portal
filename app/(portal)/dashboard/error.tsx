"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Route error boundary for `/dashboard`: query failures are handled per section inside the
 * page, so only an unexpected throw (a render bug, an auth failure) lands here. Read-only
 * route, so the copy can promise nothing changed. No number is rendered from this state.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("dashboard_error", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <Alert variant="destructive" data-testid="dashboard-error">
        <AlertTitle>Something broke on our side — nothing was changed</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <p>The dashboard could not be rendered just now. Try again in a moment.</p>
          <Button variant="outline" size="sm" onClick={reset}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
