/** Copy for `/login?reason=…` — the only place these sentences live (AC #4, #5). */
export const REASON_COPY = {
  not_allowed: "This Google account is not on the allow-list for this portal.",
  no_access: "Your account has no brand access. Contact Velocity Growth.",
  oauth_failed: "Google sign-in was cancelled or failed. Try again.",
} as const;

export type LoginReason = keyof typeof REASON_COPY;

export function reasonMessage(reason: string | string[] | undefined): string | null {
  const key = Array.isArray(reason) ? reason[0] : reason;
  return key && key in REASON_COPY ? REASON_COPY[key as LoginReason] : null;
}
