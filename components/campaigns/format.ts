import { relativeTime } from "@/lib/format";

/*
 * Campaign-specific display formatting; rates and dates use `lib/format.ts` (`formatPercent`,
 * `formatDate`, Story 3.2). Values are printed as loaded / as the view reports them (D-5).
 * Null / non-numeric input renders as an em dash, never "NaN" or "0".
 */

const DASH = "—";

const count = new Intl.NumberFormat("en-US");

function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `10,640`; null → "—" (a count from a successful query is a number; a missing one is not 0). */
export function formatCount(value: number | string | null | undefined): string {
  const n = toNumber(value);
  return n == null ? DASH : count.format(n);
}

/** `650.07` — the seed's spend as loaded (decimal comma already normalised at import); null → "—". */
export function formatSpend(value: number | string | null | undefined): string {
  const n = toNumber(value);
  return n == null ? DASH : n.toFixed(2);
}

/**
 * "3 minutes ago" / "yesterday" for a sync timestamp — Story 6.3 moved the implementation to
 * `lib/format.ts` (`relativeTime`) so the campaign pages and the send history share one clock; this
 * name stays for its callers. `now` is injectable for tests.
 */
export function formatRelative(value: string | Date, now: number = Date.now()): string {
  return relativeTime(value, now);
}
