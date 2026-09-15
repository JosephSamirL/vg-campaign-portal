"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** Route error boundary for `/campaigns/[id]`: unexpected throws → destructive alert + Retry. */
export default function CampaignError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("campaign_error", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Campaign</h1>
      <Alert variant="destructive" data-testid="campaign-error">
        <AlertTitle>Something broke on our side — nothing was changed</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <p>This campaign could not be read just now. Try again in a moment.</p>
          <Button variant="outline" size="sm" onClick={reset}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
