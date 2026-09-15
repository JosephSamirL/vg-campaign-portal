import { formatDateTime } from "@/lib/format";

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

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * "3 minutes ago" / "yesterday" for a sync timestamp; falls back to the absolute UTC form
 * for anything unparseable or further than a month away. `now` is injectable for tests.
 */
export function formatRelative(value: string | Date, now: number = Date.now()): string {
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  if (Number.isNaN(t)) return DASH;
  const seconds = Math.round((t - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  return formatDateTime(d);
}
