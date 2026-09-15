"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Route error boundary for `/campaigns`: anything the page throws (query errors are handled
 * in-page as `RetryAlert`s; this catches the unexpected) lands here as a destructive alert
 * with a Retry. Read-only page, so nothing was changed.
 */
export default function CampaignsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("campaigns_error", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Campaigns</h1>
      <Alert variant="destructive" data-testid="campaigns-error">
        <AlertTitle>Something broke on our side — nothing was changed</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <p>The campaign list could not be read just now. Try again in a moment.</p>
          <Button variant="outline" size="sm" onClick={reset}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
