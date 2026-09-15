import { formatInt } from "@/lib/format";

/**
 * The error contract every RPC raises (architecture "Error handling"): `P0001` with the
 * message set to exactly one of these. Server actions map them to `{ ok: false, code }`
 * (lib/actions.ts `wrapRpc`) and the UI switches on `code` for its inline <Alert>; anything
 * outside the list is unexpected and reaches the route's `error.tsx`.
 *
 * `share_denied` / `rate_limited` are reserved for Epic 5 (S1: `get_shared_results` returns
 * them as a status column rather than raising).
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

/** The copy for a code; a numeric hint is formatted with thousands separators, any other hint verbatim. */
export function rpcMessage(code: RpcCode, hint?: string | null): string {
  const text = COPY[code];
  if (!text.includes("{hint}")) return text;
  const trimmed = hint?.trim() ?? "";
  const shown = trimmed === "" ? "a different count" : /^\d+$/.test(trimmed) ? formatInt(Number(trimmed)) : trimmed;
  return text.replace("{hint}", shown);
}
