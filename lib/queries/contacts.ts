import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/database.types";
import type { MetricRule, Result } from "@/lib/queries/dashboard";

/**
 * `/contacts` boundary and query (Story 3.3). Every filter lives in the URL (D-12); this
 * module turns the raw `searchParams` into a total, validated shape and issues ONE
 * server-side query per page against `v_contacts` — the view carries `contactable`
 * (D-4/D-5, never recomputed here) and is `security_invoker`, so RLS on `contacts` scopes the
 * rows to the caller's brand without any `brand_id` filter in app code.
 */

export const PAGE_SIZE = 50;

export const CONTACT_STATUSES = ["active", "pending", "bounced", "unsubscribed", "unknown"] as const;

/**
 * Total parser: every field carries `.catch()`, so `.parse()` never throws — a bad link is a
 * default, not a 500 (AC2). `q` drops the characters PostgREST's `or=` grammar reserves
 * (`,` `(` `)` `"` `\`) and keeps `.` so an email prefix such as `sarah.wanjiru` still matches.
 */
export const contactsParamsSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  q: z
    .string()
    .trim()
    .max(64)
    .transform((s) => s.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim())
    .catch(""),
  status: z.enum(CONTACT_STATUSES).optional().catch(undefined),
  contactable: z.enum(["true", "false"]).optional().catch(undefined),
});

export type ContactsParams = z.infer<typeof contactsParamsSchema>;

export type ContactRow = Pick<
  Database["public"]["Views"]["v_contacts"]["Row"],
  | "id"
  | "external_id"
  | "full_name"
  | "email"
  | "phone"
  | "country"
  | "city"
  | "status"
  | "consent_marketing"
  | "contactable"
  | "signup_at"
>;

export type { MetricRule, Result };

export type ContactsPage = { rows: ContactRow[]; count: number; page: number; pages: number };

const SELECT = "id, external_id, full_name, email, phone, country, city, status, consent_marketing, contactable, signup_at";

type Supabase = SupabaseClient<Database>;

function selectPage(supabase: Supabase) {
  return supabase
    .from("v_contacts")
    .select(SELECT, { count: "exact" })
    .order("signup_at", { ascending: false, nullsFirst: false })
    .order("id");
}

function selectHead(supabase: Supabase) {
  return supabase.from("v_contacts").select("id", { count: "exact", head: true });
}

/** The filters, applied identically to the page query and the head-only count query. */
function applyFilters<Q extends ReturnType<typeof selectPage> | ReturnType<typeof selectHead>>(query: Q, p: ContactsParams): Q {
  let q = query;
  // `*` is the PostgREST like wildcard inside `or=` (a `%` would be URL-mangled).
  if (p.q) q = q.or(`full_name.ilike.*${p.q}*,email.ilike.${p.q}*`) as Q;
  if (p.status === "unknown") q = q.is("status", null) as Q;
  else if (p.status) q = q.eq("status", p.status) as Q;
  if (p.contactable) q = q.eq("contactable", p.contactable === "true") as Q;
  return q;
}

function pagesFor(count: number): number {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

/**
 * One page of the caller's contacts, ordered `signup_at desc nulls last, id`, with the exact
 * filtered total (`count: 'exact'` — the page count must be exact, so never `'planned'`).
 * PostgREST answers an offset past the total with `PGRST103` rather than an empty page; a
 * stale `?page=` is not a failed query, so that case re-reads the exact count head-only and
 * returns an empty page (the UI shows "No contacts match" with a truthful pager). Any other
 * error is returned as `ok: false` — the caller renders an alert, never `0 contacts`.
 */
export async function getContactsPage(supabase: Supabase, p: ContactsParams): Promise<Result<ContactsPage>> {
  const from = (p.page - 1) * PAGE_SIZE;
  const query = applyFilters(selectPage(supabase), p);
  const { data, count, error } = await query.range(from, from + PAGE_SIZE - 1);

  if (error?.code === "PGRST103") {
    const head = await applyFilters(selectHead(supabase), p);
    if (head.error) return { ok: false, message: head.error.message };
    const total = head.count ?? 0;
    return { ok: true, data: { rows: [], count: total, page: p.page, pages: pagesFor(total) } };
  }
  if (error) return { ok: false, message: error.message };

  const total = count ?? 0;
  return { ok: true, data: { rows: data ?? [], count: total, page: p.page, pages: pagesFor(total) } };
}

/**
 * The `contactable` rule text for the column header (AC3). One row, read from `metric_rules`
 * so the caption is never a string literal in the UI (D-5). Story 3.2's `getMetricRules`
 * reads all nine; the list page needs exactly this one. A missing row is `ok` with `null` —
 * the popover then says the rule could not be loaded rather than inventing text.
 */
export async function getContactableRule(supabase: Supabase): Promise<Result<MetricRule | null>> {
  const { data, error } = await supabase
    .from("metric_rules")
    .select("key, label, rule_text, alternative_text")
    .eq("key", "contactable")
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  return { ok: true, data };
}
