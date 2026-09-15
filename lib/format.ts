/** Display formatting shared by the portal's server components (architecture "Format patterns"). */

const dateTime = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/**
 * `15 Sep 2026, 09:51 UTC`. Always UTC: the portal is read from several countries and the
 * import timestamps are server times, so a fixed zone reads the same for everyone. Assembled
 * from `formatToParts` so the layout does not depend on a locale's punctuation (en-GB spells
 * "Sept" under recent ICU). Null / unparseable input renders as an em dash, never "Invalid Date".
 */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (value == null) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const p = Object.fromEntries(dateTime.formatToParts(date).map((part) => [part.type, part.value]));
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} UTC`;
}

const dateOnly = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const dayMonth = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `82,205` — counts from the views (bigint → number). */
export function formatInt(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * `119.16%` — a rate exactly as the view computed it: two decimals, never clamped (total opens
 * can exceed 100 %, and `metric_rules.open_rate` says so). `null` (zero denominator, or a rate the
 * source does not report) renders as a dash — "not counted" is not "0 %".
 */
export function formatPercent(rate: number | null | undefined): string {
  if (rate == null) return "—";
  const n = Number(rate);
  return Number.isNaN(n) ? "—" : `${n.toFixed(2)}%`;
}

/**
 * `17 Apr 2026` — the UTC calendar date of an ISO timestamp or a `date` column. UTC like
 * `formatDateTime`: a `date` value parses as UTC midnight, so any other zone could shift it a day.
 */
export function formatDate(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  const p = Object.fromEntries(dateOnly.formatToParts(date).map((part) => [part.type, part.value]));
  return `${p.day} ${p.month} ${p.year}`;
}

/** `17 Aug` — short UTC day label for the 30-day chart axis (PRD §5: the chart shows UTC dates). */
export function formatUtcDate(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  const p = Object.fromEntries(dayMonth.formatToParts(date).map((part) => [part.type, part.value]));
  return `${p.day} ${p.month}`;
}
