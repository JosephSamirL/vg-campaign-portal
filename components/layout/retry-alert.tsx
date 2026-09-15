"use client";

import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Per-section error state (architecture "Process patterns"): a destructive alert with a Retry
 * that re-runs the server render. Sits INSIDE the tile / chart / table that failed, so the rest
 * of the page keeps its numbers and the failed section never shows one.
 */
export function RetryAlert({ message, title = "Could not be read" }: { message: string; title?: string }) {
  const router = useRouter();
  return (
    <Alert variant="destructive" data-testid="retry-alert">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <p className="break-words font-mono text-xs">{message}</p>
        <Button variant="outline" size="sm" onClick={() => router.refresh()}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
