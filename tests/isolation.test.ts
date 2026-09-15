import { createBrowserClient } from "@supabase/ssr";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../lib/database.types";

/**
 * App-level twin of supabase/tests/0001_tenancy.test.sql: the same PostgREST path the
 * portal uses, signed in as the KILELE analyst, must return only KILELE rows (or the
 * user's own app_users row) from every exposed table.
 *
 * Later table-creating stories append their tables here (and their fixtures to the
 * pgTAP suite). Runs against the local stack; needs `.env.test` (git-ignored) with
 * TEST_KILELE_ANALYST_EMAIL / TEST_KILELE_ANALYST_PASSWORD and, when `.env.local`
 * points at the hosted project, TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY.
 */
export const TABLES = ["brands", "app_users", "contacts", "campaigns", "events"] as const satisfies readonly (
  keyof Database["public"]["Tables"]
)[];

/**
 * Tables that are guaranteed to hold a KILELE row on the local stack. `brands`/`app_users`
 * are filled by the migrations + seed; Story 2.1's `contacts`/`campaigns`/`events` are empty
 * until Story 2.4 loads the seed files (move them here once it has). The own-brand > 0 proof
 * for them lives in the pgTAP suite's fixtures meanwhile; the anonymous refusal and the
 * "no foreign brand_id" checks below run for every table regardless.
 */
const SEEDED_TABLES: readonly (typeof TABLES)[number][] = ["brands", "app_users"];

const OWN_BRAND = "KILELE";
const OTHER_BRANDS = ["KAROO", "MARRAKECH"];

const url = process.env.TEST_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const email = process.env.TEST_KILELE_ANALYST_EMAIL;
const password = process.env.TEST_KILELE_ANALYST_PASSWORD;
const configured = Boolean(url && key && email && password);

/** The app's browser client, with an in-memory cookie jar since there is no `document` here. */
function client() {
  const jar = new Map<string, string>();
  return createBrowserClient<Database>(url!, key!, {
    isSingleton: false,
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
}

describe.skipIf(!configured)("brand isolation through PostgREST (KILELE analyst)", () => {
  const supabase = client();
  let ownBrandId: string;

  beforeAll(async () => {
    const { error } = await supabase.auth.signInWithPassword({ email: email!, password: password! });
    if (error) throw new Error(`sign-in failed for the KILELE analyst: ${error.message}`);
    const { data: me } = await supabase
      .from("app_users")
      .select("brand_id, role")
      .eq("email", email!)
      .single();
    if (!me) throw new Error("no app_users row for the signed-in analyst");
    expect(me.role).toBe("analyst");
    ownBrandId = me.brand_id;
  });

  it("brands: exactly the analyst's own brand", async () => {
    const { data, error } = await supabase.from("brands").select("id, code");
    expect(error).toBeNull();
    expect(data?.map((b) => b.code)).toEqual([OWN_BRAND]);
    expect(data?.[0]?.id).toBe(ownBrandId);
  });

  it("app_users: only the analyst's own row", async () => {
    const { data, error } = await supabase.from("app_users").select("email, brand_id");
    expect(error).toBeNull();
    expect(data?.map((u) => u.email)).toEqual([email]);
  });

  it.each(TABLES)("%s: every visible row belongs to KILELE, zero KAROO/MARRAKECH rows", async (table) => {
    const { data, error } = await supabase.from(table).select("*");
    expect(error).toBeNull();
    if (SEEDED_TABLES.includes(table)) expect(data?.length ?? 0).toBeGreaterThan(0);
    for (const row of data ?? []) {
      const r = row as Record<string, unknown>;
      if ("brand_id" in r) expect(r.brand_id).toBe(ownBrandId);
      if ("code" in r) expect(OTHER_BRANDS).not.toContain(r.code);
    }
  });

  it.each(TABLES)("%s: anonymous requests are refused, not merely filtered", async (table) => {
    const { data, error } = await client().from(table).select("*");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501"); // permission denied — no grant to anon
    expect(data).toBeNull();
  });
});

if (!configured) {
  it("isolation test is configured (.env.test present)", () => {
    console.warn("tests/isolation.test.ts skipped: .env.test with TEST_KILELE_ANALYST_* is missing");
  });
}
