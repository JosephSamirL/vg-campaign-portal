/**
 * The one failure sentence of the share door (Story 5.3, AC3). Wrong token, wrong password,
 * revoked, expired, rate-limited, an empty field, a network failure — the viewer reads this and
 * nothing else. Lives beside `actions.ts` rather than in it because a `"use server"` module may
 * export only async functions (the 1.5 `reason-copy.ts` precedent).
 */
export const SHARE_FAILURE_MESSAGE = "This link is not available or the password is incorrect.";
