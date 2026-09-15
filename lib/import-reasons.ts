/**
 * Reason code → one human sentence for the Imports report (Story 2.5, FR-8).
 *
 * The codes are written by the SQL importers (`internal.import_contacts` — Story 2.3,
 * `internal.import_campaigns` / `internal.import_events` — Story 2.4) and are copied here
 * verbatim. Reasons are codes, not numbers, which is why this is a TS map; metric captions
 * (Epic 3) come from `metric_rules` and must not be merged in.
 *
 * An unknown code (a future importer, a typo) renders as the code itself in monospace
 * rather than crashing or being hidden — see `reasonCopy`.
 */
export const REASON_COPY = {
  // structural rejects (every entity)
  wrong_column_count: "Row has the wrong number of columns and was rejected",
  repeated_header: "Header row repeated inside the file and was skipped",
  blank_external_id: "External id is blank — row rejected",
  // contacts
  bad_signup_at: "Signup date could not be read (ISO-8601 or dd/mm/yyyy HH:MM)",
  unknown_brand_code: "Brand code is not one of ours — row rejected",
  blank_brand_code: "Brand code was blank — taken from the file name",
  consent_unknown: "Consent value not recognised — stored as unknown",
  status_unknown: "Status value not recognised — stored as unknown",
  country_unknown: "Country could not be matched to a code — stored as unknown",
  email_missing: "No email address on the row",
  email_invalid: "Email address is not valid — cleared",
  phone_missing: "No phone number on the row",
  phone_invalid: "Phone number is not valid — cleared",
  duplicate_external_id: "Same external id appears more than once in the file — the last row wins",
  nul_bytes_stripped: "Invisible NUL characters were removed from the row",
  followed_routed_contact: "Contact was moved to another brand earlier — this update followed it there",
  // campaigns
  channel_unknown: "Channel is not email or sms — stored as given",
  target_country_unknown: "Target country could not be matched to a code — cleared",
  spend_unparseable: "Spend could not be read as a number — cleared",
  reported_count_unparseable: "A reported count could not be read as a number — cleared",
  sent_at_unparseable: "Sent date could not be read — cleared",
  parent_not_in_brand: "Parent campaign belongs to another brand — link dropped",
  parent_unknown: "Parent campaign does not exist — link dropped",
  // events
  blank_event_id: "Event id is blank — row rejected",
  unknown_contact: "Contact not in this brand — event rejected",
  unknown_campaign: "Campaign not in this brand — event kept for contactability only",
  type_unknown: "Event type not recognised — stored as unknown",
  occurred_at_unparseable: "Event time could not be read — cleared",
  duplicate_event_id: "Same event id appears more than once in the file — the last row wins",
  event_follows_routed_contact: "Contact was moved to another brand earlier — this event followed it there",
} as const;

export type ReasonCode = keyof typeof REASON_COPY;

export const REASON_CODES = Object.keys(REASON_COPY) as ReasonCode[];

/** `routed_to_<brand code>` — one count-only issue per target brand, written by every importer. */
const ROUTED_PREFIX = "routed_to_";

export type ReasonCopy = { known: boolean; text: string };

/**
 * Own keys only: `code in REASON_COPY` would walk the prototype chain and hand back a
 * function for `constructor` / `toString` (same bug class as 1.5's `reasonMessage`).
 */
export function reasonCopy(code: string): ReasonCopy {
  if (Object.hasOwn(REASON_COPY, code)) return { known: true, text: REASON_COPY[code as ReasonCode] };
  if (code.startsWith(ROUTED_PREFIX) && code.length > ROUTED_PREFIX.length) {
    return { known: true, text: `Routed to ${code.slice(ROUTED_PREFIX.length).toUpperCase()}` };
  }
  return { known: false, text: code };
}
