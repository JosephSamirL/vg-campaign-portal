import { describe, expect, it } from "vitest";
import { REASON_CODES, REASON_COPY, reasonCopy } from "../lib/import-reasons";

// Every reason code the SQL importers write (Stories 2.3 / 2.4). A code missing from the
// copy map would silently render as raw monospace in the report, so pin the full list.
const STORY_CODES = [
  "wrong_column_count",
  "repeated_header",
  "blank_external_id",
  "bad_signup_at",
  "unknown_brand_code",
  "blank_brand_code",
  "consent_unknown",
  "status_unknown",
  "country_unknown",
  "email_missing",
  "email_invalid",
  "phone_missing",
  "phone_invalid",
  "duplicate_external_id",
  "nul_bytes_stripped",
  "followed_routed_contact",
  "channel_unknown",
  "target_country_unknown",
  "spend_unparseable",
  "reported_count_unparseable",
  "sent_at_unparseable",
  "parent_not_in_brand",
  "parent_unknown",
  "blank_event_id",
  "unknown_contact",
  "unknown_campaign",
  "type_unknown",
  "occurred_at_unparseable",
  "duplicate_event_id",
  "event_follows_routed_contact",
];

describe("REASON_COPY", () => {
  it.each(STORY_CODES)("has a human sentence for %s", (code) => {
    expect(REASON_COPY[code as keyof typeof REASON_COPY]).toBeTypeOf("string");
    expect(REASON_COPY[code as keyof typeof REASON_COPY].length).toBeGreaterThan(8);
  });

  it("lists exactly the story's codes (no strays, none missing)", () => {
    expect([...REASON_CODES].sort()).toEqual([...STORY_CODES].sort());
  });
});

describe("reasonCopy", () => {
  it("returns the mapped sentence for a known code", () => {
    expect(reasonCopy("bad_signup_at")).toEqual({
      known: true,
      text: "Signup date could not be read (ISO-8601 or dd/mm/yyyy HH:MM)",
    });
    expect(reasonCopy("unknown_campaign")).toEqual({
      known: true,
      text: "Campaign not in this brand — event kept for contactability only",
    });
  });

  it("renders routed_to_<code> as a sentence naming the brand code in upper case", () => {
    expect(reasonCopy("routed_to_karoo")).toEqual({ known: true, text: "Routed to KAROO" });
    expect(reasonCopy("routed_to_kilele").text).toBe("Routed to KILELE");
  });

  it("returns an unknown code verbatim, flagged for monospace rendering", () => {
    expect(reasonCopy("some_future_code")).toEqual({ known: false, text: "some_future_code" });
    expect(reasonCopy("")).toEqual({ known: false, text: "" });
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "does not resolve prototype key %s to a function",
    (key) => {
      expect(reasonCopy(key)).toEqual({ known: false, text: key });
    },
  );
});
