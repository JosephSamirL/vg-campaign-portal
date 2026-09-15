import { Button } from "@/components/ui/button";

/*
 * Owner-only action placeholders (AC4). Display-only: the page decides whether to render
 * them from the server-side session role; the database refuses analysts in Epics 4/5 anyway.
 * 4.4 replaces `SendPlaceholder` with the send confirm dialog, 5.2 replaces
 * `PublishPlaceholder` with the share-link form.
 */

export function SendPlaceholder() {
  return (
    <Button type="button" size="sm" disabled title="Available soon" data-testid="send-placeholder">
      Send
    </Button>
  );
}

export function PublishPlaceholder() {
  return (
    <Button type="button" size="sm" variant="outline" disabled title="Available soon" data-testid="publish-placeholder">
      Publish results
    </Button>
  );
}
