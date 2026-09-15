"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Root error boundary. Catches anything thrown below the root layout — including the
 * (portal) layout's `getCurrentAppUser()` when Auth or PostgREST fails (a segment's own
 * error.tsx cannot catch its layout, so this one has to live here). The session is left
 * untouched: a DB hiccup must never read as "no brand access" (1.5 review, Medium #2).
 *
 * Retry is Next 16's `retry` — `startTransition(() => { router.refresh(); reset() })` — so the
 * server render is re-run; `reset()` alone only clears the boundary and replays the same failure.
 */
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("portal_error", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-4 text-center">
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          The portal could not load your account just now. Your session is unchanged — try again in a moment.
        </p>
        <Button onClick={retry}>Try again</Button>
      </div>
    </div>
  );
}
