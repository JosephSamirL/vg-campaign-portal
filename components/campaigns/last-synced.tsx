import { formatDateTime, relativeTime } from "@/lib/format";

export type LastSyncedProps = { last_ok_at: string | null; warning?: string | null };

/**
 * "Reports last synced …" on the campaign pages (Story 3.4 placed it; Story 6.3 fills it): `last_ok_at` is the
 * brand's `v_last_sync` value — the newest `provider_batches.last_ok_at`, i.e. the last time a page of delivery
 * reports was ingested for one of this brand's sends. Null (the view returned no row: no portal send has ever
 * been dispatched) keeps the placeholder sentence.
 *
 * `warning` is the muted second line the page computes from `last_poll_status()` (AC5: the newest poll run is
 * not ok / requested / running): "Report sync has not succeeded since …". Muted on purpose — the figures on the
 * page are still real, just possibly stale; a FAILED read of the sync status is a different state and renders
 * the destructive alert in the page, never through this component.
 */
export function LastSynced({ last_ok_at, warning }: LastSyncedProps) {
  return (
    <div className="flex flex-col gap-0.5 text-sm text-muted-foreground" data-testid="last-synced">
      <p>
        {last_ok_at == null ? (
          "Reports last synced: no portal sends yet"
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
