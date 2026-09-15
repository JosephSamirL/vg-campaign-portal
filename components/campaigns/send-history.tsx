"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/layout/empty-state";
import { DispatchRetryButton } from "@/components/send/dispatch-retry-button";
import { SendStatus, isTerminal, type SendRow } from "@/components/send/send-status";

/** A send still `confirmed` this long after `confirmed_at` has not been leased: show "Dispatch didn't start" + Retry (AC5). */
export const STUCK_AFTER_MS = 30_000;
/** How often the page re-reads `sends.status` while a send is in flight (AC2). */
export const POLL_INTERVAL_MS = 3_000;

export type SendHistoryProps = {
  sends: SendRow[];
  isOwner: boolean;
  /** Per-`source` badge text; Story 4.5 passes `{ seed_send_log: "from send log" }`. Unlisted sources carry no badge. */
  sourceLabels?: Partial<Record<SendRow["source"], string>>;
};

/**
 * The "Sends" section body (AC1–AC3): the campaign's `sends` rows (RLS, newest first as the page
 * ordered them), one `SendStatus` each. Polling: while any row is non-terminal this component
 * calls `router.refresh()` every 3 s — a client component re-running the server render, so the
 * rows stay the server's reads (D-12: the app has no UPDATE on `sends`; status changes arrive
 * only this way). The interval clears when every row is terminal or on unmount. A row `confirmed`
 * for more than 30 s (client clock, sampled on each tick — never during the server render, so
 * hydration matches) gets the owner-only Retry.
 */
export function SendHistory({ sends, isOwner, sourceLabels }: SendHistoryProps) {
  const router = useRouter();
  const active = sends.some((s) => !isTerminal(s.status));
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => {
      setNow(Date.now());
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [active, router]);

  if (sends.length === 0) {
    return <EmptyState title="No sends yet" description="Sends for this campaign will be listed here with their status." />;
  }

  return (
    <ol className="flex flex-col gap-3" data-testid="send-history" data-polling={active ? "true" : "false"}>
      {sends.map((send) => {
        const stuck =
          isOwner &&
          now !== null &&
          send.status === "confirmed" &&
          send.confirmed_at !== null &&
          now - Date.parse(send.confirmed_at) > STUCK_AFTER_MS;
        return (
          <li key={send.id}>
            <SendStatus send={send} sourceLabel={sourceLabels?.[send.source] ?? null} retry={stuck ? <DispatchRetryButton sendId={send.id} /> : null} />
          </li>
        );
      })}
    </ol>
  );
}
