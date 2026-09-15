import { formatInt } from "@/lib/format";

/**
 * The error contract every RPC raises (architecture "Error handling"): `P0001` with the
 * message set to exactly one of these. Server actions map them to `{ ok: false, code }`
 * (lib/actions.ts `wrapRpc`) and the UI switches on `code` for its inline <Alert>; anything
 * outside the list is unexpected and reaches the route's `error.tsx`.
 *
 * `share_denied` / `rate_limited` belong to Epic 5 (S1: `get_shared_results` returns them as a
 * status column rather than raising; Story 5.3 maps `status <> 'ok'` to `{ ok: false, code }`).
 */
export const RPC_CODES = [
  "not_owner",
  "not_in_brand",
  "count_mismatch",
  "invalid_input",
  "send_in_progress",
  "share_denied",
  "rate_limited",
] as const;

export type RpcCode = (typeof RPC_CODES)[number];

export function isRpcCode(value: unknown): value is RpcCode {
  return typeof value === "string" && (RPC_CODES as readonly string[]).includes(value);
}

/**
 * One plain sentence per code, for the inline alert. `{hint}` is substituted with the RPC's
 * `hint` (D-6 / amendment #11: `count_mismatch` carries the new recipient count, so the number
 * on screen is always the number that would be sent).
 */
const COPY: Record<RpcCode, string> = {
  not_owner: "Only the brand owner can send.",
  not_in_brand: "That campaign isn't in your brand.",
  count_mismatch: "The list changed since you looked — {hint} now. Confirm again.",
  invalid_input: "This campaign can't be sent (no recipients or unsupported channel).",
  send_in_progress: "A send for this campaign is already in progress.",
  share_denied: "That share link can't be opened.",
  rate_limited: "Too many attempts — wait a minute and try again.",
};

/**
 * Which surface raised the code: the same `not_owner` reads "can send" beside the Send button and
 * "can publish or revoke share links" in the share dialog (Story 5.2). `send` is the default so
 * every Story 4.4 call site keeps its sentence; only the copy differs, never the code.
 */
export type RpcContext = "send" | "share";

const SHARE_COPY: Partial<Record<RpcCode, string>> = {
  not_owner: "Only the brand owner can publish or revoke share links.",
  invalid_input: "The password needs at least 8 characters and the expiry must be in the future.",
};

/** The copy for a code; a numeric hint is formatted with thousands separators, any other hint verbatim. */
export function rpcMessage(code: RpcCode, hint?: string | null, context: RpcContext = "send"): string {
  const text = (context === "share" ? SHARE_COPY[code] : undefined) ?? COPY[code];
  if (!text.includes("{hint}")) return text;
  const trimmed = hint?.trim() ?? "";
  const shown = trimmed === "" ? "a different count" : /^\d+$/.test(trimmed) ? formatInt(Number(trimmed)) : trimmed;
  return text.replace("{hint}", shown);
}
