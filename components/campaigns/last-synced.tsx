import { formatDateTime, relativeTime } from "@/lib/format";

export type LastSyncedProps = {
  last_ok_at: string | null;
  warning?: string | null;
  /**
   * Whether `v_last_sync` returned a row at all (the brand has dispatched at least one batch). A row with a null
   * `last_ok_at` is "Reports not synced yet" — a marketer waiting for the first report; no row keeps 3.4's
   * "no portal sends yet" placeholder (AC5). Defaults to "a row exists iff last_ok_at is set" for older callers.
   */
  has_batches?: boolean;
};

/**
 * "Reports last synced …" on the campaign pages (Story 3.4 placed it; Story 6.3 fills it): `last_ok_at` is the
 * brand's `v_last_sync` value — the newest `provider_batches.last_ok_at`, i.e. the last time a page of delivery
 * reports was ingested for one of this brand's sends. Null with `has_batches` (the view returned a row whose
 * `last_ok_at` is still null: a batch exists, no page has landed) reads "Reports not synced yet"; null without a row
 * (no portal send has ever been dispatched) keeps the placeholder sentence — three states, never a fake "synced".
 *
 * `warning` is the muted second line the page computes from `last_poll_status()` (AC5: the newest poll run is
 * not ok / requested / running): "Report sync has not succeeded since …". Muted on purpose — the figures on the
 * page are still real, just possibly stale; a FAILED read of the sync status is a different state and renders
 * the destructive alert in the page, never through this component.
 */
export function LastSynced({ last_ok_at, warning, has_batches = last_ok_at != null }: LastSyncedProps) {
  return (
    <div className="flex flex-col gap-0.5 text-sm text-muted-foreground" data-testid="last-synced">
      <p>
        {last_ok_at == null ? (
          has_batches ? (
            <span data-testid="last-synced-pending">Reports not synced yet</span>
          ) : (
            "Reports last synced: no portal sends yet"
          )
        ) : (
          <>
            Reports last synced{" "}
            <time dateTime={last_ok_at} title={formatDateTime(last_ok_at)}>
              {relativeTime(last_ok_at)}
            </time>
          </>
        )}
      </p>
      {warning && (
        <p className="text-muted-foreground" data-testid="last-synced-warning">
          {warning}
        </p>
      )}
    </div>
  );
}
