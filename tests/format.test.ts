import { describe, expect, it } from "vitest";
import { formatDateTime } from "../lib/format";

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
