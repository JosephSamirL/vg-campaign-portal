import { formatDateTime } from "@/lib/format";
import { formatRelative } from "./format";

export type LastSyncedProps = { last_ok_at: string | null; warning?: string | null };

/**
 * "Reports last synced …" above the campaigns table. Until Epic 6 there are no portal sends
 * and nothing to poll, so the page passes `null`; Story 6.3 passes the brand's `v_last_sync`
 * value and an optional warning through this same contract — the component does not change.
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
              {formatRelative(last_ok_at)}
            </time>
          </>
        )}
      </p>
      {warning && <p data-testid="last-synced-warning">{warning}</p>}
    </div>
  );
}
