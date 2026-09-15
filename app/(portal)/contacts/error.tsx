"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Route error boundary for `/contacts`: a failed list query is thrown by the page and lands
 * here as a destructive alert with a Retry (AC4). The page is read-only, so the copy can
 * promise nothing changed; a count is never rendered from a failed query (FR-15).
 */
export default function ContactsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("contacts_error", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Contacts</h1>
      <Alert variant="destructive" data-testid="contacts-error">
        <AlertTitle>Something broke on our side — nothing was changed</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <p>The contact list could not be read just now. Try again in a moment.</p>
          <Button variant="outline" size="sm" onClick={reset}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
