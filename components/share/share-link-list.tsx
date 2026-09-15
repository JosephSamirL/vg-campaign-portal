"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { revokeShareLinkAction } from "@/app/(portal)/campaigns/[id]/actions";
import { EmptyState } from "@/components/layout/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Database } from "@/lib/database.types";
import { formatDateTime } from "@/lib/format";

/*
 * The "Share links" section body (Story 5.2, AC3 / AC5 / AC6): the campaign's `v_share_links`
 * rows exactly as the page read them (RSC through RLS, newest first) — created date, expiry
 * ("never" when null) and the view's own `status` column (`active | revoked | expired`; one
 * definition, in SQL, never recomputed here from `revoked_at` / `expires_at`). An owner gets a
 * Revoke on each `active` row; an analyst sees the same rows and no control at all, and the RPC
 * would refuse them anyway. After a revoke the page is re-rendered (`router.refresh()`), so the
 * row flips to `revoked` from the server's read, never from client state.
 */

export type ShareLinkRow = Database["public"]["Views"]["v_share_links"]["Row"];

export type ShareLinkListProps = {
  links: ShareLinkRow[];
  isOwner: boolean;
};

export function ShareLinkList({ links, isOwner }: ShareLinkListProps) {
  if (links.length === 0) {
    return <EmptyState title="No share links yet" description="Password-protected result links will be listed here." />;
  }
  return (
    <ol className="flex flex-col gap-3" data-testid="share-link-list">
      {links.map((link, index) => (
        <li key={link.id ?? index} className="flex flex-col gap-2 rounded-lg border p-4" data-link-id={link.id ?? undefined}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Created</dt>
              <dd data-testid="share-link-created-at">{formatDateTime(link.created_at)}</dd>
              <dt className="text-muted-foreground">Expires</dt>
              <dd data-testid="share-link-expiry">{link.expires_at === null ? "never" : formatDateTime(link.expires_at)}</dd>
              {link.revoked_at !== null && (
                <>
                  <dt className="text-muted-foreground">Revoked</dt>
                  <dd data-testid="share-link-revoked-at">{formatDateTime(link.revoked_at)}</dd>
                </>
              )}
            </dl>
            <div className="flex items-center gap-2">
              <ShareLinkStatusBadge status={link.status} />
              {isOwner && link.status === "active" && link.id !== null && <RevokeShareLinkButton id={link.id} />}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

const BADGES: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  active: { label: "Active", variant: "default" },
  revoked: { label: "Revoked", variant: "destructive" },
  expired: { label: "Expired", variant: "secondary" },
};

/** The view's `status` as a badge; anything the view does not emit renders as an outline badge with the raw value. */
export function ShareLinkStatusBadge({ status }: { status: string | null }) {
  const known = status !== null ? BADGES[status] : undefined;
  return (
    <Badge variant={known?.variant ?? "outline"} data-testid="share-link-status" data-status={known ? status : "unknown"}>
      {known?.label ?? status ?? "Unknown"}
    </Badge>
  );
}

/**
 * The small client button wrapping `revokeShareLinkAction(id)` (AC3): disabled with a spinner
 * while the action runs, an inline destructive alert for an expected refusal (`not_owner`,
 * `not_in_brand`), a re-throw for anything else so the route's error.tsx renders.
 */
function RevokeShareLinkButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ code: string; message: string } | null>(null);
  const [crash, setCrash] = useState<Error | null>(null);
  if (crash) throw crash;

  const revoke = async () => {
    setPending(true);
    setNotice(null);
    try {
      const res = await revokeShareLinkAction(id);
      if (!res.ok) {
        setNotice({ code: res.code, message: res.message });
        setPending(false);
        return;
      }
      // the row re-renders as `revoked` from the server's read; this button unmounts with it
      router.refresh();
    } catch (error) {
      setCrash(error instanceof Error ? error : new Error(String(error)));
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <Button type="button" variant="outline" size="sm" disabled={pending} aria-busy={pending} onClick={revoke} data-testid="share-link-revoke">
        {pending ? (
          <>
            <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
            Revoking…
          </>
        ) : (
          "Revoke"
        )}
      </Button>
      {notice && (
        <Alert variant="destructive" data-testid="share-link-revoke-alert" data-code={notice.code}>
          <AlertTitle>This link can&apos;t be revoked</AlertTitle>
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
