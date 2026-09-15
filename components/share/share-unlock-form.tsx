"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { unlockShareFormAction, type SharedResults } from "@/app/(public)/share/[token]/actions";
import { SHARE_FAILURE_MESSAGE } from "@/app/(public)/share/[token]/copy";
import { SharedResultsCard } from "@/components/share/shared-results-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/actions";

/**
 * The stranger's password form (Story 5.3). Three states and nothing else: pending (field and
 * button disabled, spinner), failure (ONE sentence in ONE alert — the same tree whatever the
 * cause), success (the results card replaces the form). The token travels in a hidden field to an
 * unbound action (see `actions.ts` for why not `.bind`) and is never displayed; there is no
 * "forgot password", "request access" or owner contact — each would hint that the link exists.
 * Nothing is remembered: a reload asks for the password again.
 *
 * React resets an uncontrolled form once its action settles, so the password field is empty
 * after a failed attempt without any state of our own. The alert prints the constant, not
 * `state.message`, so the sentence cannot vary with the payload.
 */
export function ShareUnlockForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<ActionResult<SharedResults> | null, FormData>(unlockShareFormAction, null);

  if (state?.ok) return <SharedResultsCard data={state.data} />;

  const failed = state !== null && !state.ok;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Campaign results</CardTitle>
        <CardDescription>Enter the password you were given.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-6">
          {/* the route's own token — the viewer already has it in the URL; it is never shown */}
          <input type="hidden" name="token" value={token} />
          <div className="grid gap-2">
            <Label htmlFor="share-password">Password</Label>
            <Input
              id="share-password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={pending}
            />
          </div>
          {failed && (
            <Alert variant="destructive" data-testid="share-failure">
              <AlertDescription>{SHARE_FAILURE_MESSAGE}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {pending ? "Checking…" : "View results"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
