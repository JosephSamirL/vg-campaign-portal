"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { confirmSendAction, previewSendAction } from "@/app/(portal)/campaigns/[id]/actions";
import { SendPreview, type RecipientPreview } from "@/components/send/send-preview";
import { SendStatusBadge, isTerminal, type SendRow } from "@/components/send/send-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { formatDateTime, formatInt } from "@/lib/format";

/*
 * The Send button + confirm dialog on `/campaigns/[id]` (AC1, AC2, AC5). Rendered only for an
 * owner (the page gates on the server-side role); the database refuses everyone else anyway.
 *
 * States (Dev Notes): closed → `idle` (opens, calls previewSendAction; skeleton, buttons disabled)
 * → `preview` (SendPreview + "Send to {total_count} recipients") → `submitting` (buttons disabled,
 * not dismissible) → on `count_mismatch`: back to `preview` with expected_count = Number(hint) and
 * the alert "The list changed since you looked — {hint} now. Confirm again." → on success: toast
 * "Send confirmed", close, router.refresh() (the page then polls sends.status — the provider is
 * never awaited here). `total_count = 0` → Send disabled + "No recipients match — nothing to send".
 * Every number on screen is the RPC's; nothing is recomputed client-side.
 *
 * Prior sends (epic AC1 / FR-21; 4.4 review [M]): the page's `sends` rows are listed inside the dialog
 * (status + date + count) so the owner sees what already went out before confirming again. While one
 * of them is non-terminal the Send button is disabled ("A send is already in progress"). And because
 * `confirm_send` returns the EXISTING active send to a loser (4.2 AC2 — possibly another owner's, with
 * another count), a result whose id is already in the list, whose `confirmed_by` is not this user, whose
 * `recipient_count` differs from the count confirmed, or whose `created_at` is older than a fresh insert
 * could be, is reported as "A send is already in progress for this campaign" — never "Send confirmed".
 */

type Phase = "idle" | "preview" | "submitting";
type Notice = { code: string; message: string };

/** A `confirm_send` row created earlier than this is somebody's existing send, not the row this click inserted. */
export const FRESH_SEND_MAX_AGE_MS = 60_000;
export const ALREADY_IN_PROGRESS = "A send is already in progress for this campaign";

export type SendConfirmDialogProps = {
  campaignId: string;
  campaignLabel: string;
  /** The campaign's sends as the page read them (RLS) — listed as "Prior sends"; a non-terminal one blocks Send. */
  sends?: SendRow[];
  /** The signed-in owner's email (`confirmed_by` is the confirmer's email): a returned send by someone else is not ours. */
  userEmail?: string | null;
};

/** Is the row `confirm_send` returned the one this click inserted, or an existing active send (4.2 AC2's loser path)? */
export function isExistingSend(row: SendRow, args: { knownIds: ReadonlySet<string>; userEmail: string | null | undefined; expectedCount: number; now: number }): boolean {
  if (args.knownIds.has(row.id)) return true;
  if (args.userEmail && row.confirmed_by !== null && row.confirmed_by !== args.userEmail) return true;
  if (row.recipient_count !== args.expectedCount) return true;
  const created = Date.parse(row.created_at);
  return Number.isFinite(created) && args.now - created > FRESH_SEND_MAX_AGE_MS;
}

export function SendConfirmDialog({ campaignId, campaignLabel, sends = [], userEmail = null }: SendConfirmDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<RecipientPreview | null>(null);
  const [expectedCount, setExpectedCount] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [crash, setCrash] = useState<Error | null>(null);
  // an unexpected failure (the action threw) is re-thrown during render so the route's error.tsx catches it
  if (crash) throw crash;

  const load = useCallback(async () => {
    setPhase("idle");
    setPreview(null);
    setExpectedCount(null);
    setNotice(null);
    try {
      const res = await previewSendAction({ campaign_id: campaignId });
      if (res.ok) {
        setPreview(res.data);
        setExpectedCount(Number(res.data.total_count));
      } else {
        setNotice({ code: res.code, message: res.message });
      }
    } catch (error) {
      setCrash(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    setPhase("preview");
  }, [campaignId]);

  const inProgress = sends.some((s) => !isTerminal(s.status));

  const onOpenChange = (next: boolean) => {
    if (!next && phase === "submitting") return; // never lose a confirm in flight
    setOpen(next);
    if (next) void load();
  };

  const confirm = async () => {
    // the phase guard makes a double-click / key repeat before the re-render a no-op (one invoke, one toast)
    if (phase !== "preview" || expectedCount == null || expectedCount <= 0 || inProgress) return;
    const count = expectedCount;
    setPhase("submitting");
    setNotice(null);
    let res: Awaited<ReturnType<typeof confirmSendAction>>;
    try {
      res = await confirmSendAction({ campaign_id: campaignId, expected_count: count });
    } catch (error) {
      setCrash(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (res.ok) {
      const existing = isExistingSend(res.data, { knownIds: new Set(sends.map((s) => s.id)), userEmail, expectedCount: count, now: Date.now() });
      if (existing) toast.info(ALREADY_IN_PROGRESS);
      else toast.success("Send confirmed");
      setOpen(false);
      setPhase("idle");
      router.refresh();
      return;
    }
    if (res.code === "count_mismatch") {
      // D-6: the recount becomes the number on screen and the number sent next — and the excluded counts are
      // re-read with it so the four numbers still reconcile (§5); a missing / non-numeric hint reloads as well
      // rather than leaving the stale count sendable
      const recount = res.hint != null && /^\d+$/.test(res.hint) ? Number(res.hint) : null;
      setNotice({ code: res.code, message: res.message });
      await reloadPreview(recount);
      return;
    }
    setNotice({ code: res.code, message: res.message });
    setPhase("preview");
  };

  /** Re-run `previewSendAction` after a `count_mismatch` (keeps the alert); `recount` wins for the number sent next. */
  const reloadPreview = async (recount: number | null) => {
    try {
      const res = await previewSendAction({ campaign_id: campaignId });
      if (res.ok) {
        const total = recount ?? Number(res.data.total_count);
        setPreview({ ...res.data, total_count: total });
        setExpectedCount(total);
      } else if (recount !== null) {
        setExpectedCount(recount);
        setPreview((p) => (p ? { ...p, total_count: recount } : p));
      } else {
        setExpectedCount(null);
        setNotice({ code: res.code, message: res.message });
      }
    } catch (error) {
      setCrash(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    setPhase("preview");
  };

  const busy = phase !== "preview";
  const nothingToSend = phase === "preview" && preview !== null && Number(preview.total_count) === 0;
  const blocked = notice !== null && notice.code !== "count_mismatch";
  const canSend = phase === "preview" && preview !== null && expectedCount != null && expectedCount > 0 && !blocked && !inProgress;

  return (
    <>
      <Button type="button" size="sm" onClick={() => onOpenChange(true)} data-testid="send-button">
        Send
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange} dismissible={phase !== "submitting"} aria-labelledby="send-dialog-title" data-testid="send-dialog">
        <DialogContent>
          <DialogHeader>
            <DialogTitle id="send-dialog-title">Send {campaignLabel}</DialogTitle>
            <DialogDescription>Review who this goes to, then confirm. The count you confirm is the count that is sent.</DialogDescription>
          </DialogHeader>

          {phase === "idle" && (
            <div className="flex flex-col gap-3" aria-busy="true" data-testid="send-dialog-loading">
              <Skeleton className="h-9 w-40" />
              <Skeleton className="h-4 w-64 max-w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {notice && (
            <Alert variant={notice.code === "count_mismatch" ? "default" : "destructive"} data-testid="send-dialog-alert" data-code={notice.code}>
              <AlertTitle>{notice.code === "count_mismatch" ? "The list changed" : "This can't be sent"}</AlertTitle>
              <AlertDescription>{notice.message}</AlertDescription>
            </Alert>
          )}

          {phase !== "idle" && preview !== null && <SendPreview preview={preview} />}

          {sends.length > 0 && (
            <section className="flex flex-col gap-2" aria-labelledby="send-dialog-prior" data-testid="send-dialog-prior">
              <h3 id="send-dialog-prior" className="text-sm font-medium">
                Prior sends
              </h3>
              <ol className="flex flex-col gap-1 text-sm">
                {sends.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2" data-testid="send-dialog-prior-row" data-send-id={s.id} data-status={s.status}>
                    <SendStatusBadge status={s.status} />
                    <span className="tabular-nums">{formatDateTime(s.confirmed_at ?? s.created_at)}</span>
                    <span className="text-muted-foreground">
                      <span className="tabular-nums">{formatInt(s.recipient_count)}</span> {s.recipient_count === 1 ? "recipient" : "recipients"}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {inProgress && (
            <Alert data-testid="send-dialog-alert" data-code="send_in_progress">
              <AlertTitle>A send is already in progress</AlertTitle>
              <AlertDescription>Wait for it to finish (the list above updates on its own) before sending this campaign again.</AlertDescription>
            </Alert>
          )}

          {nothingToSend && (
            <Alert data-testid="send-dialog-alert" data-code="no_recipients">
              <AlertTitle>No recipients match — nothing to send</AlertTitle>
              <AlertDescription>Nobody in this brand is contactable for this channel and country right now.</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={phase === "submitting"} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!canSend || busy} onClick={confirm} data-testid="send-confirm" aria-busy={phase === "submitting"}>
              {phase === "submitting" ? (
                <>
                  <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
                  Confirming…
                </>
              ) : expectedCount != null && expectedCount > 0 ? (
                `Send to ${formatInt(expectedCount)} ${expectedCount === 1 ? "recipient" : "recipients"}`
              ) : (
                "Send"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
