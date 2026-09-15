// Story 2.2 — per-file CSV dialects for the eleven seed files (D-3).
//
// Everything a file needs to be *read* lives here: delimiter, encoding, the
// source-header → canonical-column map, the columns that use a decimal comma,
// and the hard-coded `as_of` / `file_rank` (never derived from the filename —
// base exports 2026-08-01 / rank 10, the delta 2026-09-01 / rank 20). Nothing
// here interprets values; every keep/reject rule is SQL (Stories 2.3 / 2.4).

export type Entity = "contacts" | "campaigns" | "events" | "send_log";
export type Brand = "KILELE" | "KAROO" | "MARRAKECH";

export interface FileDialect {
  /** Basename under `docs/data/` — also the `source_file` staging key. */
  file: string;
  brand: Brand;
  entity: Entity;
  delimiter: "," | ";";
  encoding: "utf-8" | "windows-1252";
  /** Column count of a well-formed record = `CANONICAL[entity].length`. */
  expectedCols: number;
  /** Normalised source header → canonical column (identity when absent). */
  headerMap: Record<string, string>;
  /** Canonical columns whose values use `221,09` — rewritten to `221.09`. */
  decimalCommaColumns: string[];
  /** `YYYY-MM-DD`, hard-coded per file. */
  asOf: string;
  fileRank: number;
}

/** Canonical column order per entity — `cols[1..n]` in SQL has this order. */
export const CANONICAL: Record<Entity, readonly string[]> = {
  contacts: [
    "external_id", "full_name", "email", "phone", "country", "city", "signup_at",
    "status", "consent_marketing", "deleted_at", "suppressed_until", "brand_code", "notes",
  ],
  campaigns: [
    "external_id", "name", "channel", "target_country", "reported_sent", "reported_delivered",
    "reported_bounced", "reported_opens", "reported_clicks", "spend", "sent_at", "send_local_time",
    "parent_external_id",
  ],
  events: ["event_id", "contact_external_id", "campaign_external_id", "type", "channel", "occurred_at"],
  send_log: ["batch_key", "campaign_external_id", "queued_at", "recipient_count", "status"],
};

/** Strip BOM, trim, lower-case, spaces → `_`, then apply the dialect's map. */
export function normalizeHeader(h: string, headerMap: Record<string, string>): string {
  const key = h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_");
  return headerMap[key] ?? key;
}

const BASE = { asOf: "2026-08-01", fileRank: 10 } as const;
const DELTA = { asOf: "2026-09-01", fileRank: 20 } as const;

const CAMPAIGN_HEADERS = {
  campaign_name: "name",
  sent_at_utc: "sent_at",
  parent_campaign_id: "parent_external_id",
};
const EVENT_HEADERS = {
  external_contact_id: "contact_external_id",
  event_type: "type",
  occurred_at_utc: "occurred_at",
};

function dialect(
  file: string,
  brand: Brand,
  entity: Entity,
  delimiter: "," | ";",
  encoding: "utf-8" | "windows-1252",
  headerMap: Record<string, string>,
  when: { asOf: string; fileRank: number },
  decimalCommaColumns: string[] = [],
): FileDialect {
  return { file, brand, entity, delimiter, encoding, expectedCols: CANONICAL[entity].length, headerMap, decimalCommaColumns, ...when };
}

/** The eleven seed files, in staging order (verified against `head -2` on 2026-09-14). */
export const DIALECTS: FileDialect[] = [
  // contacts — Kilele: UTF-8 with BOM, already canonical order
  dialect("kilele-contacts.csv", "KILELE", "contacts", ",", "utf-8", {}, BASE),
  dialect("kilele-contacts-delta-2026-09-01.csv", "KILELE", "contacts", ",", "utf-8", {}, DELTA),
  // Karoo: windows-1252 (0x96/0x92/0xE1), title-case headers in a different
  // order — `normalizeHeader` turns `Full Name` into `full_name` etc., the
  // reorder happens by header position
  dialect("karoo-contacts.csv", "KAROO", "contacts", ",", "windows-1252", {}, BASE),
  // Marrakech: `;` delimiter, French headers
  dialect("marrakech-contacts.csv", "MARRAKECH", "contacts", ";", "utf-8", { e_mail: "email", mobile: "phone", pays: "country" }, BASE),
  // campaigns
  dialect("kilele-campaigns.csv", "KILELE", "campaigns", ",", "utf-8", CAMPAIGN_HEADERS, BASE),
  dialect("karoo-campaigns.csv", "KAROO", "campaigns", ",", "utf-8", CAMPAIGN_HEADERS, BASE),
  dialect("marrakech-campaigns.csv", "MARRAKECH", "campaigns", ";", "utf-8", CAMPAIGN_HEADERS, BASE, ["spend"]),
  // events
  dialect("kilele-events.csv", "KILELE", "events", ",", "utf-8", EVENT_HEADERS, BASE),
  dialect("karoo-events.csv", "KAROO", "events", ",", "utf-8", EVENT_HEADERS, BASE),
  dialect("marrakech-events.csv", "MARRAKECH", "events", ";", "utf-8", EVENT_HEADERS, BASE),
  // send log (staged only — the import is Story 4.5)
  dialect("kilele-send-log.csv", "KILELE", "send_log", ",", "utf-8", { queued_at_utc: "queued_at" }, BASE),
];
