import { formatCount } from "@/components/campaigns/format";
import { PerformanceCell } from "@/components/campaigns/performance-cell";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { Tables } from "@/lib/database.types";
import { formatDateTime, formatInt, relativeTime } from "@/lib/format";
import { hasLiveFigures, type CampaignPerformanceRow, type RateRules } from "@/lib/queries/campaigns";

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

/** Story 6.3: the send's `source = 'portal'` row of `v_campaign_performance` + the five rate rules to caption it. */
export type LiveFigures = { row: CampaignPerformanceRow; rules: RateRules };

/** Sends the provider reports on: dispatched and answered (`reporting`), finished (`complete`), or partly accepted (`partial`). */
export const REPORTING_STATUSES: ReadonlySet<SendStatus> = new Set<SendStatus>(["reporting", "complete", "partial"]);

export type SendStatusProps = {
  send: SendRow;
  /** 4.5 passes "from send log" for `source === 'seed_send_log'`; portal sends carry no label. */
  sourceLabel?: string | null;
  /** The owner-only Retry for a send stuck in `confirmed` (AC5); rendered where the history decides. */
  retry?: React.ReactNode;
  /**
   * Story 6.3: the live figures for a `reporting | complete | partial` send with a `batch_id`. `null` (the page read the
   * view and found no row / no event) → "No reports yet"; `undefined` (the page could not read the view) → "Figures
   * unavailable" — never a fake empty state for figures nobody read (6.3 review [L]).
   */
  live?: LiveFigures | null;
};

const LIVE_COUNTS = [
  ["delivered", "Delivered"],
  ["bounced", "Bounced"],
  ["opens", "Opens"],
  ["clicks", "Clicks"],
  ["unsubscribes", "Unsubscribes"],
] as const;

/**
 * The live-figures block (Story 6.3 AC5): what the provider has reported for this send so far, as the poller
 * ingested it — counts per type and the five rates as `v_campaign_performance` computed them, each captioned from
 * `metric_rules` (D-5: printed, never recomputed). A send with no report yet reads "No reports yet" — an empty
 * state, not a row of zeros; figures the page could not read (`live` undefined) read "Figures unavailable". `dispatched_at` on the row is the moment the clock started; `reporting` sends keep
 * changing until `complete_sends()` closes them 24 h later.
 */
export function SendLiveFigures({ live }: { live: LiveFigures | null | undefined }) {
  if (live === undefined) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="send-live-unavailable" role="status">
        Figures unavailable
      </p>
    );
  }
  if (live === null || !hasLiveFigures(live.row)) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="send-live-empty" role="status">
        No reports yet
      </p>
    );
  }
  const { row, rules } = live;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3" data-testid="send-live">
      <p className="text-xs text-muted-foreground">
        Delivery reports so far
        {row.dispatched_at && (
          <>
            {" "}
            · dispatched{" "}
            <time dateTime={row.dispatched_at} title={formatDateTime(row.dispatched_at)}>
              {relativeTime(row.dispatched_at)}
            </time>
          </>
        )}
      </p>
      <dl className="grid grid-cols-3 gap-3 text-sm sm:grid-cols-5">
        {LIVE_COUNTS.map(([key, label]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="tabular-nums" data-testid={`send-live-${key}`}>
              {formatCount(row[key])}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <div className="flex flex-col items-start">
          <dt className="text-xs text-muted-foreground">{rules.delivered_rate.label}</dt>
          <dd><PerformanceCell rate={row.delivered_rate} count={row.delivered} rule={rules.delivered_rate} /></dd>
        </div>
        <div className="flex flex-col items-start">
          <dt className="text-xs text-muted-foreground">{rules.bounce_rate.label}</dt>
          <dd><PerformanceCell rate={row.bounce_rate} count={row.bounced} rule={rules.bounce_rate} /></dd>
        </div>
        <div className="flex flex-col items-start">
          <dt className="text-xs text-muted-foreground">{rules.open_rate.label}</dt>
          <dd><PerformanceCell rate={row.open_rate} count={row.opens} rule={rules.open_rate} /></dd>
        </div>
        <div className="flex flex-col items-start">
          <dt className="text-xs text-muted-foreground">{rules.click_rate.label}</dt>
          <dd><PerformanceCell rate={row.click_rate} count={row.clicks} rule={rules.click_rate} /></dd>
        </div>
        <div className="flex flex-col items-start">
          <dt className="text-xs text-muted-foreground">{rules.unsubscribe_rate.label}</dt>
          <dd><PerformanceCell rate={row.unsubscribe_rate} count={row.unsubscribes} rule={rules.unsubscribe_rate} /></dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * `failure_reason` is stored as `<code>: <detail>` (`provider_422: …`, `body_hash_mismatch`). Only the code is
 * rendered as text — the detail (a provider's error echo) goes into `title`, hover-only, never in the flow of the
 * page an analyst reads (4.4 review [L]).
 */
export function failureReasonPrefix(reason: string): string {
  const colon = reason.indexOf(":");
  return (colon === -1 ? reason : reason.slice(0, colon)).trim();
}

/**
 * One send in the campaign's history (AC3): lifecycle badge, the three timestamps, the approver,
 * the recipient count, `batch_id`, accepted / rejected. `partial` reads "Partially sent — {accepted}
 * of {count} accepted" when the provider answered, and "Partially sent — provider outcome unknown" when
 * `accepted_count` is null (a capped / expired dispatch: nothing is fabricated for an unknown, FR-19);
 * `failed` shows the `failure_reason` code. Story 6.3: a portal send in `reporting | complete | partial` that
 * carries a `batch_id` gets the live-figures block (`live`, from `v_campaign_performance`), "No reports yet", or
 * "Figures unavailable" when the page could not read the view; a partial with no `batch_id` gets none. Pure display of
 * the `sends` row (RLS) — the app never updates a send; status changes arrive through polling (SendHistory).
 */
export function SendStatus({ send, sourceLabel, retry, live }: SendStatusProps) {
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

      {send.status === "partial" && send.accepted_count != null && (
        <p className="text-sm font-medium" data-testid="send-partial">
          Partially sent — {formatInt(send.accepted_count)} of {formatInt(send.recipient_count)} accepted
        </p>
      )}
      {send.status === "partial" && send.accepted_count == null && (
        <p className="text-sm font-medium" data-testid="send-partial" data-outcome="unknown">
          Partially sent — provider outcome unknown
          {send.failure_reason && (
            <>
              {" "}
              <span className="font-mono text-xs text-muted-foreground" title={send.failure_reason} data-testid="send-failure-reason">
                ({failureReasonPrefix(send.failure_reason)})
              </span>
            </>
          )}
        </p>
      )}
      {send.status === "failed" && (
        <p className="break-words text-sm text-destructive" data-testid="send-failure-reason" title={send.failure_reason ?? undefined}>
          {send.failure_reason ? failureReasonPrefix(send.failure_reason) : "Failed — no reason was recorded"}
        </p>
      )}

      {/* only a send the provider answered (batch_id) can have reports: an unknown-outcome partial says so above, never "No reports yet" */}
      {send.source === "portal" && REPORTING_STATUSES.has(send.status) && send.batch_id !== null && <SendLiveFigures live={live} />}

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
