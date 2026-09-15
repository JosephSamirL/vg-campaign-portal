"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { confirmSendAction, previewSendAction } from "@/app/(portal)/campaigns/[id]/actions";
import { SendPreview, type RecipientPreview } from "@/components/send/send-preview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { formatInt } from "@/lib/format";

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
 */

type Phase = "idle" | "preview" | "submitting";
type Notice = { code: string; message: string };

export function SendConfirmDialog({ campaignId, campaignLabel }: { campaignId: string; campaignLabel: string }) {
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

  const onOpenChange = (next: boolean) => {
    if (!next && phase === "submitting") return; // never lose a confirm in flight
    setOpen(next);
    if (next) void load();
  };

  const confirm = async () => {
    if (expectedCount == null || expectedCount <= 0) return;
    setPhase("submitting");
    setNotice(null);
    let res: Awaited<ReturnType<typeof confirmSendAction>>;
    try {
      res = await confirmSendAction({ campaign_id: campaignId, expected_count: expectedCount });
    } catch (error) {
      setCrash(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (res.ok) {
      toast.success("Send confirmed");
      setOpen(false);
      setPhase("idle");
      router.refresh();
      return;
    }
    if (res.code === "count_mismatch" && res.hint != null && /^\d+$/.test(res.hint)) {
      // D-6: the RPC's recount becomes the number on screen and the number sent next
      const recount = Number(res.hint);
      setExpectedCount(recount);
      setPreview((p) => (p ? { ...p, total_count: recount } : p));
    }
    setNotice({ code: res.code, message: res.message });
    setPhase("preview");
  };

  const busy = phase !== "preview";
  const nothingToSend = phase === "preview" && preview !== null && Number(preview.total_count) === 0;
  const blocked = notice !== null && notice.code !== "count_mismatch";
  const canSend = phase === "preview" && preview !== null && expectedCount != null && expectedCount > 0 && !blocked;

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
