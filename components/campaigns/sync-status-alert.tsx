import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { errorDigest } from "@/lib/error-digest";

/**
 * A FAILED read of `v_last_sync` / `last_poll_status()` (Story 6.3 AC5): the third state — not "synced", not
 * "sync failing", but "we could not find out". Inline, destructive, with the digest the server log carries
 * (FR-15); the raw PostgREST text never reaches the browser. Distinct on purpose from `LastSynced`'s muted warning.
 */
export function SyncStatusAlert({ message }: { message: string }) {
  const digest = errorDigest(message);
  console.error("section_error", { digest, title: "Sync status unavailable", message });
  return (
    <Alert variant="destructive" data-testid="sync-status-alert" data-digest={digest}>
      <AlertTitle>Sync status unavailable</AlertTitle>
      <AlertDescription>
        The last report sync could not be read just now; the figures below may be behind. If it keeps failing, quote reference{" "}
        <span className="font-mono text-xs">{digest}</span>.
      </AlertDescription>
    </Alert>
  );
}
