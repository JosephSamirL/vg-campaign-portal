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
