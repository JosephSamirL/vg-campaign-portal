"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { createShareLinkAction } from "@/app/(portal)/campaigns/[id]/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { rpcMessage } from "@/lib/rpc-codes";

/*
 * "Publish results" + the share-link dialog on `/campaigns/[id]` (Story 5.2, AC1 / AC2 / AC6).
 * Rendered only for an owner (the page gates on the server-side role); the RPC refuses everyone
 * else anyway (`not_owner` relayed into the alert below).
 *
 * Two phases (D-12 — only ephemeral state lives here): `form` (password + optional expiry →
 * `createShareLinkAction`) → `created` (the full URL, once, with Copy and the warning). Closing
 * the dialog in either phase discards everything: the token exists in this component's state and
 * nowhere else — not in a cookie, a URL of the portal, a log line or the toast text.
 *
 * The password is read from the form exactly as typed (no `.trim()`, no `onBlur` clean-up,
 * `autoCapitalize="off"`): the RPC stores what was typed and the stranger must type the same
 * thing later, spaces included (D-10). The expiry is a `datetime-local` value, which carries no
 * zone — it is turned into an ISO-8601 UTC instant here, in the browser, before it goes over
 * the wire; an empty field is `null`, never `""`.
 */

/** Sentinel for a `datetime-local` value the browser could not parse; the action's zod refuses it as `invalid_input`. */
const INVALID_EXPIRY = "invalid";

/** `datetime-local` → ISO-8601 UTC (`null` for an empty field, `"invalid"` for garbage). */
export function toExpiresAt(value: string): string | null {
  if (value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? INVALID_EXPIRY : date.toISOString();
}

/** The action returns a root-relative path when the request carried no host header; the browser's own origin completes it. */
export function absoluteShareUrl(url: string, origin: string): string {
  return url.startsWith("/") ? `${origin}${url}` : url;
}

type Phase = { kind: "form" } | { kind: "created"; url: string };
type Notice = { code: string; message: string };

export function ShareLinkForm({ campaignId, campaignLabel }: { campaignId: string; campaignLabel: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, startTransition] = useTransition();
  const [crash, setCrash] = useState<Error | null>(null);
  // an unexpected failure (the action threw) is re-thrown during render so the route's error.tsx catches it
  if (crash) throw crash;

  const onOpenChange = (next: boolean) => {
    if (!next && pending) return; // never lose a create in flight
    setOpen(next);
    // opening and closing both start clean: the once-shown URL never survives the dialog
    setPhase({ kind: "form" });
    setNotice(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const password = form.get("password");
    const expiresRaw = form.get("expires_at");
    const typed = typeof password === "string" ? password : "";
    // the same rule as the action's zod and the RPC: length, untrimmed
    if (typed.length < 8) {
      setNotice({ code: "invalid_input", message: rpcMessage("invalid_input", null, "share") });
      return;
    }
    const expires_at = toExpiresAt(typeof expiresRaw === "string" ? expiresRaw : "");
    setNotice(null);
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof createShareLinkAction>>;
      try {
        res = await createShareLinkAction({ campaign_id: campaignId, password: typed, expires_at });
      } catch (error) {
        setCrash(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!res.ok) {
        setNotice({ code: res.code, message: res.message });
        return;
      }
      formRef.current?.reset();
      setPhase({ kind: "created", url: absoluteShareUrl(res.data.url, window.location.origin) });
      // the list below the dialog re-reads v_share_links (revalidatePath already ran server-side)
      router.refresh();
    });
  };

  /**
   * Story 7.1 (AC3): a plain `onClick` — never `onMouseDown`, which a touch tap does not reliably fire
   * — `navigator.clipboard.writeText` (secure context only: https or localhost) in try/catch; on
   * failure the URL text is selected in the read-only input so a long-press "Copy" finishes the job,
   * with the toast "Copy manually" and the inline note saying the same.
   */
  const copy = async (url: string, input: HTMLInputElement | null) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      input?.focus();
      input?.select();
      toast("Copy manually");
      setNotice({ code: "copy_failed", message: "Copying failed — the link is selected; copy it manually." });
    }
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" className="h-11 w-full sm:h-8 sm:w-auto" onClick={() => onOpenChange(true)} data-testid="publish-button">
        Publish results
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange} dismissible={!pending} aria-labelledby={titleId} data-testid="share-link-dialog">
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle id={titleId}>Publish results for {campaignLabel}</DialogTitle>
            <DialogDescription>
              {phase.kind === "form"
                ? "Anyone with the link and the password sees this campaign's reported figures — nothing else."
                : "The link is live. Share it together with the password you chose."}
            </DialogDescription>
          </DialogHeader>

          {notice && (
            <Alert variant={notice.code === "copy_failed" ? "default" : "destructive"} data-testid="share-link-alert" data-code={notice.code}>
              <AlertTitle>{notice.code === "copy_failed" ? "Not copied" : "This link can't be created"}</AlertTitle>
              <AlertDescription>{notice.message}</AlertDescription>
            </Alert>
          )}

          {phase.kind === "form" ? (
            <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-4" data-testid="share-link-form">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${titleId}-password`}>Password</Label>
                <Input
                  id={`${titleId}-password`}
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={pending}
                  aria-describedby={`${titleId}-password-help`}
                />
                <p id={`${titleId}-password-help`} className="text-xs text-muted-foreground">
                  At least 8 characters. Spaces count.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${titleId}-expires`}>Expires (optional)</Label>
                <Input id={`${titleId}-expires`} name="expires_at" type="datetime-local" disabled={pending} aria-describedby={`${titleId}-expires-help`} />
                <p id={`${titleId}-expires-help`} className="text-xs text-muted-foreground">
                  Leave empty for a link that works until you revoke it.
                </p>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending} aria-busy={pending} data-testid="share-link-submit">
                  {pending ? (
                    <>
                      <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
                      Creating…
                    </>
                  ) : (
                    "Create link"
                  )}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <>
              <ShareLinkCreatedPanel url={phase.url} onCopy={(input) => void copy(phase.url, input)} />
              <DialogFooter>
                <Button type="button" onClick={() => onOpenChange(false)} data-testid="share-link-done">
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The once-only panel (AC2): the full URL in a read-only input (selectable by hand when the
 * clipboard is unavailable), a Copy button, and the warning. Rendered exactly once per created
 * link; the parent discards the URL when the dialog closes.
 */
export function ShareLinkCreatedPanel({ url, onCopy }: { url: string; onCopy: (input: HTMLInputElement | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-3" data-testid="share-link-created">
      <div className="flex flex-col gap-2 sm:flex-row">
        {/* `text-base` below md (no iOS focus zoom); the URL scrolls inside the input */}
        <Input
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className="font-mono md:text-xs"
          aria-label="Share link"
          data-testid="share-link-url"
        />
        <Button type="button" variant="secondary" className="h-11 sm:h-9" onClick={() => onCopy(inputRef.current)} data-testid="share-link-copy">
          Copy
        </Button>
      </div>
      <Alert data-testid="share-link-once">
        <AlertTitle>Copy it now — this link cannot be shown again.</AlertTitle>
        <AlertDescription>Only a hash of it is stored. If it is lost, revoke it and create a new one.</AlertDescription>
      </Alert>
    </div>
  );
}
