"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { dispatchSendAction } from "@/app/(portal)/campaigns/[id]/actions";
import { Button } from "@/components/ui/button";

/**
 * "Dispatch didn't start" + Retry for a send stuck in `confirmed` (AC5), and — with `label` — "Waiting for
 * the provider — lease expired" for one stranded in `dispatched` after a 5xx / timeout / lost response
 * (4.4 review [M]). Calls `dispatchSendAction`, which is safe to repeat (lease + Idempotency-Key: a replay
 * is the same request), then refreshes so the poll picks up the new status. A refusal or a skipped invoke
 * is shown inline in one sentence; nothing is thrown.
 */
export function DispatchRetryButton({ sendId, label = "Dispatch didn't start" }: { sendId: string; label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [crash, setCrash] = useState<Error | null>(null);
  if (crash) throw crash;

  const retry = async () => {
    setPending(true);
    setNote(null);
    try {
      const res = await dispatchSendAction({ send_id: sendId });
      if (!res.ok) setNote(res.message);
      else if (!res.data.dispatched) setNote(`Dispatch still didn't start (${res.data.reason ?? "skipped"}). Try again in a moment.`);
      router.refresh();
    } catch (error) {
      setCrash(error instanceof Error ? error : new Error(String(error)));
      return;
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1 text-right" data-testid="dispatch-retry">
      <div className="flex items-center gap-2">
        <span className="text-sm text-destructive" data-testid="dispatch-retry-label">
          {label}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={retry} data-testid="dispatch-retry-button">
          {pending ? "Retrying…" : "Retry"}
        </Button>
      </div>
      {note && (
        <p className="text-xs text-muted-foreground" data-testid="dispatch-retry-note">
          {note}
        </p>
      )}
    </div>
  );
}
