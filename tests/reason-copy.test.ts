import { describe, expect, it } from "vitest";
import { REASON_COPY, reasonMessage } from "../app/(public)/login/reason-copy";

describe("reasonMessage", () => {
  it.each(Object.keys(REASON_COPY))("returns the copy for %s", (key) => {
    expect(reasonMessage(key)).toBe(REASON_COPY[key as keyof typeof REASON_COPY]);
  });

  it("takes the first value of a repeated ?reason=", () => {
    expect(reasonMessage(["no_access", "not_allowed"])).toBe(REASON_COPY.no_access);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "renders the default (null) for prototype key %s instead of a function",
    (key) => {
      expect(reasonMessage(key)).toBeNull();
    },
  );

  it.each(["", "unknown", undefined, []])("is null for %s", (value) => {
    expect(reasonMessage(value as string | string[] | undefined)).toBeNull();
  });
});
