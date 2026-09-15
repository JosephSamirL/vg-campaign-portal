import { RetryButton } from "@/components/layout/retry-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { errorDigest } from "@/lib/error-digest";

/**
 * Per-section error state (architecture "Process patterns"): a destructive alert with a Retry
 * that re-runs the server render. Sits INSIDE the tile / chart / table that failed, so the rest
 * of the page keeps its numbers and the failed section never shows one.
 *
 * A server component: the raw PostgREST / Postgres `message` (schema names, error codes) is
 * logged here, server-side, under a digest, and only that digest reaches the browser — brand
 * users see a plain sentence plus a reference they can quote (3.2 / 3.4 review, Low #4/#5).
 */
export function RetryAlert({ message, title = "Could not be read" }: { message: string; title?: string }) {
  const digest = errorDigest(message);
  console.error("section_error", { digest, title, message });
  return (
    <Alert variant="destructive" data-testid="retry-alert" data-digest={digest}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <p>
          This section could not be read just now. Try again in a moment; if it keeps failing, quote reference{" "}
          <span className="font-mono text-xs">{digest}</span>.
        </p>
        <RetryButton />
      </AlertDescription>
    </Alert>
  );
}
