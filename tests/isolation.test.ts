import { createBrowserClient } from "@supabase/ssr";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../lib/database.types";

/**
 * App-level twin of supabase/tests/0001_tenancy.test.sql: the same PostgREST path the
 * portal uses, signed in as the KILELE analyst, must return only KILELE rows (or the
 * user's own app_users row) from every exposed table.
 *
 * Later table-creating stories append their tables here (and their fixtures to the
 * pgTAP suite). Runs against the LOCAL stack only; needs `.env.test` (git-ignored) with
 * TEST_KILELE_ANALYST_EMAIL / TEST_KILELE_ANALYST_PASSWORD and TEST_SUPABASE_URL /
 * TEST_SUPABASE_PUBLISHABLE_KEY (see `.env.example`). Never falls back to `.env.local`,
 * so a hosted URL there can never be signed into by accident (1.5 review, Medium #3).
 *
 * Unconfigured: skipped with a loud console message locally; a hard failure under CI.
 * Non-local TEST_SUPABASE_URL: refused unless ALLOW_HOSTED_TESTS=1 is set explicitly.
 */
export const TABLES = [
  "brands",
  "app_users",
  "contacts",
  "campaigns",
  "events",
  "import_runs",
  "import_issues",
  "metric_rules", // Story 3.1: shared (no brand_id) — readable when signed in, refused anonymously
  "sends", // Story 4.1: send records — SELECT only through PostgREST; empty locally until 4.2 confirms / 4.5 imports
  "send_recipients",
  "provider_batches",
] as const satisfies readonly (keyof Database["public"]["Tables"])[];
/** Exposed views (Story 2.3+): same isolation contract as the tables they read. */
export const VIEWS = [
  "v_import_issue_groups",
  "v_dashboard_totals", // Story 3.1: the four metrics views, security_invoker
  "v_signups_30d",
  "v_campaign_performance",
  "v_contacts",
  "v_share_links", // Story 5.1: the ONLY read path for share links (no hash columns, + status)
] as const satisfies readonly (keyof Database["public"]["Views"])[];
/**
 * Story 5.1: `share_links` is deliberately NOT in TABLES — `authenticated` holds a column-level SELECT on its
 * non-hash columns only (no table-level grant, S2), so `select *` is refused by Postgres (42501) even for the
 * owner's own brand; brand users read `v_share_links`. Its isolation contract is asserted separately below.
 */
const SHARE_LINKS_COLUMNS = "id, brand_id, campaign_id, expires_at, revoked_at, created_by, created_at";
const RELATIONS = [...TABLES, ...VIEWS] as const;
type Relation = (typeof RELATIONS)[number];

/**
 * Tables that are guaranteed to hold a KILELE row on the local stack. `brands`/`app_users`
 * are filled by the migrations + seed.sql; `contacts`/`campaigns`/`events` and the import report
 * (`import_runs`/`import_issues`/`v_import_issue_groups`) by `pnpm seed` — the documented local
 * setup since Story 2.4 (README "Seed load counts"); `metric_rules` and the metrics views (Story 3.1)
 * are filled by the migration / derived from the seeded tables. The own-brand > 0 check therefore
 * covers every relation; the anonymous refusal and the "no foreign brand_id" checks run regardless.
 * Story 4.1's `sends` / `send_recipients` / `provider_batches` are NOT listed: nothing writes them until
 * Story 4.2 (confirm) / 4.5 (seed send log) — own-brand > 0 for them is proven by the pgTAP fixtures meanwhile.
 */
const SEEDED_TABLES: readonly Relation[] = [
  "brands",
  "app_users",
  "contacts",
  "campaigns",
  "events",
  "import_runs",
  "import_issues",
  "v_import_issue_groups",
  "metric_rules", // nine rows seeded by 0005_metrics.sql itself
  "v_dashboard_totals", // one row per visible brand; v_signups_30d always has 30 rows per brand
  "v_signups_30d",
  "v_campaign_performance",
  "v_contacts",
];

const OWN_BRAND = "KILELE";
const OTHER_BRANDS = ["KAROO", "MARRAKECH"];

const REQUIRED = [
  "TEST_SUPABASE_URL",
  "TEST_SUPABASE_PUBLISHABLE_KEY",
  "TEST_KILELE_ANALYST_EMAIL",
  "TEST_KILELE_ANALYST_PASSWORD",
] as const;
const LOCAL_URL = "http://127.0.0.1:54321";

const url = process.env.TEST_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_PUBLISHABLE_KEY;
const email = process.env.TEST_KILELE_ANALYST_EMAIL;
const password = process.env.TEST_KILELE_ANALYST_PASSWORD;
const missing = REQUIRED.filter((name) => !process.env[name]);
const configured = missing.length === 0;

/** Only the local stack is a legal target unless the operator opts in explicitly. */
export function isLocalSupabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.hostname === "127.0.0.1" && u.port === "54321";
  } catch {
    return false;
  }
}

if (configured && !isLocalSupabaseUrl(url) && process.env.ALLOW_HOSTED_TESTS !== "1") {
  throw new Error(
    `tests/isolation.test.ts: TEST_SUPABASE_URL must be the local stack (${LOCAL_URL}); ` +
      `refusing to sign into ${url}. Set ALLOW_HOSTED_TESTS=1 to override deliberately.`,
  );
}

if (!configured) {
  const message =
    `tests/isolation.test.ts: not configured — missing ${missing.join(", ")} ` +
    `(put them in the git-ignored .env.test; see .env.example).`;
  if (process.env.CI) throw new Error(`${message} CI requires the isolation test to run.`);
  // process.stderr, not console.warn: Vitest swallows console output from a file whose tests all skip.
  process.stderr.write(`\n${"=".repeat(88)}\nSKIPPED: ${message}\n${"=".repeat(88)}\n\n`);
}

/** `from()` is overloaded per table / view, so a mixed relation name has to be narrowed first. */
function selectAll(sb: ReturnType<typeof client>, rel: Relation) {
  return (VIEWS as readonly string[]).includes(rel)
    ? sb.from(rel as (typeof VIEWS)[number]).select("*")
    : sb.from(rel as (typeof TABLES)[number]).select("*");
}

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
  // Created inside beforeAll: a skipped describe still runs its body at collection time.
  let supabase: ReturnType<typeof client>;
  let ownBrandId: string;

  beforeAll(async () => {
    supabase = client();
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

  it.each(RELATIONS)("%s: every visible row belongs to KILELE, zero KAROO/MARRAKECH rows", async (table) => {
    const { data, error } = await selectAll(supabase, table);
    expect(error).toBeNull();
    if (SEEDED_TABLES.includes(table)) expect(data?.length ?? 0).toBeGreaterThan(0);
    for (const row of data ?? []) {
      const r = row as Record<string, unknown>;
      if ("brand_id" in r) expect(r.brand_id).toBe(ownBrandId);
      if ("code" in r) expect(OTHER_BRANDS).not.toContain(r.code);
    }
  });

  it("share_links: `select *` is refused for a signed-in user (column-level grant only), the granted columns are brand-scoped", async () => {
    const star = await supabase.from("share_links").select("*");
    expect(star.error?.code).toBe("42501");
    expect(star.data).toBeNull();
    const hash = await supabase.from("share_links").select("token_hash");
    expect(hash.error?.code).toBe("42501");
    const { data, error } = await supabase.from("share_links").select(SHARE_LINKS_COLUMNS);
    expect(error).toBeNull();
    for (const row of data ?? []) expect(row.brand_id).toBe(ownBrandId);
  });

  it("share_links: anonymous requests are refused on the granted columns too", async () => {
    const { data, error } = await client().from("share_links").select(SHARE_LINKS_COLUMNS);
    expect(error?.code).toBe("42501");
    expect(data).toBeNull();
  });

  it.each(RELATIONS)("%s: anonymous requests are refused, not merely filtered", async (table) => {
    const { data, error } = await selectAll(client(), table);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501"); // permission denied — no grant to anon
    expect(data).toBeNull();
  });
});

if (!configured) {
  it.todo(`isolation test is configured (.env.test with ${missing.join(", ")}) — SKIPPED, not passed`);
}
