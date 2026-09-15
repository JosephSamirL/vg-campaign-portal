import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { Tables } from "@/lib/database.types";
import { formatDateTime, formatInt } from "@/lib/format";

export type SendRow = Tables<"sends">;
export type SendStatus = SendRow["status"];

/** `complete | partial | failed` — nothing moves after these (the partial unique index frees the campaign). */
export const TERMINAL_STATUSES: ReadonlySet<SendStatus> = new Set<SendStatus>(["complete", "partial", "failed"]);

export function isTerminal(status: SendStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** The lifecycle badge: one label + variant per `send_status` value, the enum verbatim in `data-status`. */
const LIFECYCLE: Record<SendStatus, { label: string; variant: NonNullable<BadgeProps["variant"]> }> = {
  pending: { label: "Pending", variant: "outline" },
  confirmed: { label: "Confirmed", variant: "outline" },
  dispatched: { label: "Dispatching", variant: "secondary" },
  reporting: { label: "Sent — reporting", variant: "default" },
  complete: { label: "Complete", variant: "default" },
  partial: { label: "Partially sent", variant: "destructive" },
  failed: { label: "Failed", variant: "destructive" },
};

export function SendStatusBadge({ status }: { status: SendStatus }) {
  const { label, variant } = LIFECYCLE[status];
  return (
    <Badge variant={variant} data-testid="send-status-badge" data-status={status}>
      {label}
    </Badge>
  );
}

export type SendStatusProps = {
  send: SendRow;
  /** 4.5 passes "from send log" for `source === 'seed_send_log'`; portal sends carry no label. */
  sourceLabel?: string | null;
  /** The owner-only Retry for a send stuck in `confirmed` (AC5); rendered where the history decides. */
  retry?: React.ReactNode;
};

/**
 * One send in the campaign's history (AC3): lifecycle badge, the three timestamps, the approver,
 * the recipient count, `batch_id`, accepted / rejected. `partial` reads "Partially sent — {accepted}
 * of {count} accepted"; `failed` shows `failure_reason`. Pure display of the `sends` row (RLS) — the
 * app never updates a send; status changes arrive through polling (SendHistory).
 */
export function SendStatus({ send, sourceLabel, retry }: SendStatusProps) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border p-4" data-testid="send-status" data-send-id={send.id} data-status={send.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SendStatusBadge status={send.status} />
          {sourceLabel && (
            <Badge variant="outline" data-testid="send-source">
              {sourceLabel}
            </Badge>
          )}
          <span className="text-sm text-muted-foreground">
            <span className="tabular-nums">{formatInt(send.recipient_count)}</span> {send.recipient_count === 1 ? "recipient" : "recipients"}
          </span>
        </div>
        {retry}
      </div>

      {send.status === "partial" && (
        <p className="text-sm font-medium" data-testid="send-partial">
          Partially sent — {formatInt(send.accepted_count ?? 0)} of {formatInt(send.recipient_count)} accepted
        </p>
      )}
      {send.status === "failed" && (
        <p className="break-words text-sm text-destructive" data-testid="send-failure-reason">
          {send.failure_reason ?? "Failed — no reason was recorded"}
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Confirmed</dt>
        <dd>
          <span className="tabular-nums">{formatDateTime(send.confirmed_at)}</span>
          {send.confirmed_by && (
            <span className="text-muted-foreground">
              {" "}
              by <span data-testid="send-confirmed-by">{send.confirmed_by}</span>
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Dispatched</dt>
        <dd className="tabular-nums">{formatDateTime(send.dispatched_at)}</dd>
        <dt className="text-muted-foreground">Provider responded</dt>
        <dd className="tabular-nums">{formatDateTime(send.provider_responded_at)}</dd>
        <dt className="text-muted-foreground">Batch</dt>
        <dd className="break-all font-mono text-xs" data-testid="send-batch-id">
          {send.batch_id ?? "—"}
        </dd>
        <dt className="text-muted-foreground">Accepted / rejected</dt>
        <dd className="tabular-nums" data-testid="send-counts">
          {send.accepted_count == null ? "—" : formatInt(send.accepted_count)} / {send.rejected_count == null ? "—" : formatInt(send.rejected_count)}
        </dd>
      </dl>
    </article>
  );
}
