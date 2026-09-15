/** Copy for `/login?reason=…` — the only place these sentences live (AC #4, #5). */
export const REASON_COPY = {
  not_allowed: "This Google account is not on the allow-list for this portal.",
  no_access: "Your account has no brand access. Contact Velocity Growth.",
  oauth_failed: "Google sign-in was cancelled or failed. Try again.",
} as const;

export type LoginReason = keyof typeof REASON_COPY;

/**
 * Own keys only — `key in REASON_COPY` walked the prototype chain, so `?reason=constructor`
 * (or `toString`, `__proto__`) returned a function and crashed the page (1.5 review, Medium #1).
 */
export function reasonMessage(reason: string | string[] | undefined): string | null {
  const key = Array.isArray(reason) ? reason[0] : reason;
  return typeof key === "string" && Object.hasOwn(REASON_COPY, key) ? REASON_COPY[key as LoginReason] : null;
}
