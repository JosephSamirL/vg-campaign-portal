import { describe, expect, it } from "vitest";
import { formatDateTime, relativeTime } from "../lib/format";

describe("formatDateTime", () => {
  it("formats an ISO timestamp in UTC with date and minutes, no seconds", () => {
    expect(formatDateTime("2026-09-15T09:51:08.189135+00:00")).toBe("15 Sep 2026, 09:51 UTC");
  });

  it("accepts a Date", () => {
    expect(formatDateTime(new Date(Date.UTC(2026, 0, 2, 23, 5)))).toBe("02 Jan 2026, 23:05 UTC");
  });

  it("renders a dash for null, undefined and unparseable input instead of 'Invalid Date'", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("not a date")).toBe("—");
  });
});

describe("relativeTime (Story 6.3)", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");

  it("reads 'just now', minutes, hours, days through Intl.RelativeTimeFormat, and the absolute UTC form beyond a month", () => {
    expect(relativeTime("2026-09-15T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-09-15T11:57:00Z", now)).toBe("3 minutes ago");
    expect(relativeTime("2026-09-15T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-09-14T11:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-09-10T11:00:00Z", now)).toBe("5 days ago");
    expect(relativeTime("2026-07-01T11:00:00Z", now)).toBe("01 Jul 2026, 11:00 UTC");
  });

  it("never prints NaN, Invalid Date or a future-tense surprise for junk; a slightly-future instant is 'just now'", () => {
    expect(relativeTime("garbage", now)).toBe("—");
    expect(relativeTime(null, now)).toBe("—");
    expect(relativeTime("2026-09-15T12:00:20Z", now)).toBe("just now");
  });
});
