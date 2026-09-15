"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/layout/empty-state";
import { DispatchRetryButton } from "@/components/send/dispatch-retry-button";
import { SendStatus, isTerminal, type SendRow } from "@/components/send/send-status";
import { Button } from "@/components/ui/button";

/** A send still `confirmed` this long after `confirmed_at` has not been leased: show "Dispatch didn't start" + Retry (AC5). */
export const STUCK_AFTER_MS = 30_000;
/** How often the page re-reads `sends.status` while a send is in flight (AC2) — for the first minute. */
export const POLL_INTERVAL_MS = 3_000;
/** After `POLL_BACKOFF_AFTER_MS` of polling the interval widens to this (4.4 review [L]: `reporting` moves only in Epic 6). */
export const POLL_SLOW_INTERVAL_MS = 10_000;
export const POLL_BACKOFF_AFTER_MS = 60_000;
/** Polling stops here; a "Refresh" hint takes over (the owner's Retry and a reload still work). */
export const POLL_STOP_AFTER_MS = 600_000;

/** The label beside the owner's Retry for a send stranded in `dispatched` once its lease ran out. */
export const LEASE_EXPIRED_LABEL = "Waiting for the provider — lease expired";

export type SendHistoryRow = SendRow & {
  /** Server-computed by `getCampaignSends` (never the client clock): `dispatched`, no `batch_id`, `dispatch_lease_until < now()`. */
  lease_expired?: boolean;
};

export type SendHistoryProps = {
  sends: SendHistoryRow[];
  isOwner: boolean;
  /** Per-`source` badge text; the page passes `{ seed_send_log: "from send log" }` (Story 4.5). Unlisted sources carry no badge. */
  sourceLabels?: Partial<Record<SendRow["source"], string>>;
};

/**
 * The "Sends" section body (AC1–AC3): the campaign's `sends` rows (RLS, newest first as the page
 * ordered them), one `SendStatus` each. Polling: while any row is non-terminal this component
 * calls `router.refresh()` — a client component re-running the server render, so the rows stay
 * the server's reads (D-12: the app has no UPDATE on `sends`; status changes arrive only this way).
 * Every 3 s for the first minute, then every 10 s, and it stops after 10 min with a "Refresh" hint
 * (a send in `reporting` moves only when Epic 6 polls the provider). The interval clears when
 * every row is terminal or on unmount. A row `confirmed` for more than 30 s (client clock, sampled
 * on each tick — never during the server render, so hydration matches) gets the owner-only Retry;
 * a row the server flagged `lease_expired` (stranded in `dispatched`) gets the same Retry under
 * "Waiting for the provider — lease expired" — `dispatchSendAction` honours the lease / attempt cap
 * and replays the same Idempotency-Key, so it can never double-send.
 */
export function SendHistory({ sends, isOwner, sourceLabels }: SendHistoryProps) {
  const router = useRouter();
  const active = sends.some((s) => !isTerminal(s.status));
  const [now, setNow] = useState<number | null>(null);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    setNow(started);
    setStopped(false);
    let timer: number | undefined;
    const tick = () => {
      const elapsed = Date.now() - started;
      if (elapsed >= POLL_STOP_AFTER_MS) {
        setStopped(true);
        return;
      }
      setNow(Date.now());
      router.refresh();
      timer = window.setTimeout(tick, elapsed >= POLL_BACKOFF_AFTER_MS ? POLL_SLOW_INTERVAL_MS : POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [active, router]);

  if (sends.length === 0) {
    return <EmptyState title="No sends yet" description="Sends for this campaign will be listed here with their status." />;
  }

  return (
    <div className="flex flex-col gap-3">
      {stopped && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="send-history-stale">
          Live updates paused after 10 minutes.
          <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()} data-testid="send-history-refresh">
            Refresh
          </Button>
        </p>
      )}
      <ol className="flex flex-col gap-3" data-testid="send-history" data-polling={active && !stopped ? "true" : "false"}>
        {sends.map((send) => {
          const stuck =
            isOwner &&
            now !== null &&
            send.status === "confirmed" &&
            send.confirmed_at !== null &&
            now - Date.parse(send.confirmed_at) > STUCK_AFTER_MS;
          const stranded = isOwner && send.lease_expired === true;
          const retry = stranded ? <DispatchRetryButton sendId={send.id} label={LEASE_EXPIRED_LABEL} /> : stuck ? <DispatchRetryButton sendId={send.id} /> : null;
          return (
            <li key={send.id}>
              <SendStatus send={send} sourceLabel={sourceLabels?.[send.source] ?? null} retry={retry} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
