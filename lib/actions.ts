/**
 * Every server action returns this shape (architecture "Format patterns"): expected
 * failures carry a snake_case `code` the UI can switch on plus a human `message` for the
 * inline <Alert>; success carries `data`. Successful sign-in redirects instead of returning.
 */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };
