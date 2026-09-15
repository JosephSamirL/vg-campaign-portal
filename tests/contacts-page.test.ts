import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/contacts` page contract (Story 3.3). The page is an async server component; with mocked
 * `searchParams` and a recording mock of the server client it yields a tree of sync
 * components (the popover is a client component but renders synchronously on the server),
 * which `renderToStaticMarkup` turns into HTML we assert on: the three states, the URL-only
 * filters, the exact `v_contacts` query, the rule-text popover, and the pager links.
 */

type Result = { data: unknown; error: unknown; count?: number | null };

const responses: Record<string, Result | Result[]> = {};
const calls: Record<string, Array<[string, unknown[]]>> = {};

function builder(table: string) {
  calls[table] ??= [];
  const chain: Record<string, unknown> = {};
  const record = (method: string) =>
    (...args: unknown[]) => {
      calls[table].push([method, args]);
      return chain;
    };
  for (const m of ["select", "or", "is", "eq", "order", "range", "maybeSingle"]) chain[m] = record(m);
  chain.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => {
    const r = responses[table];
    const result = Array.isArray(r) ? r.shift() : r;
    return Promise.resolve(result ?? { data: null, error: { message: `no mock for ${table}` } }).then(resolve, reject);
  };
  return chain;
}

const from = vi.fn((table: string) => builder(table));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from }) }));

const { default: ContactsPage } = await import("../app/(portal)/contacts/page");

const RULE = {
  key: "contactable",
  label: "Contactable",
  rule_text: "Total customers **and** consent = true (blank/unknown = not consented) **and** status ∉ {bounced, unsubscribed}",
  alternative_text: "Consent-only, or ignoring seed events (11.9k Kilele contacts differ)",
};

const rows = [
  {
    id: "5c1d2c3e-0000-4000-8000-000000000001",
    external_id: "KIL-C-000001",
    full_name: "Amina Wanjiru",
    email: "amina.wanjiru@example.com",
    phone: "+254700000001",
    country: "KE",
    city: "Nairobi",
    status: "active",
    consent_marketing: true,
    contactable: true,
    signup_at: "2026-09-01T08:15:00+00:00",
  },
  {
    id: "5c1d2c3e-0000-4000-8000-000000000002",
    external_id: "KIL-C-000002",
    full_name: "Sarah Otieno",
    email: "sarah.otieno@example.com",
    phone: null,
    country: "KE",
    city: null,
    status: null,
    consent_marketing: null,
    contactable: false,
    signup_at: null,
  },
];

async function render(params: Record<string, string | string[] | undefined>) {
  const element = await ContactsPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  for (const k of Object.keys(calls)) delete calls[k];
  from.mockClear();
  responses.metric_rules = { data: RULE, error: null };
});

describe("/contacts list", () => {
  it("throws the query error (→ error.tsx) instead of rendering an empty table or 0 contacts", async () => {
    responses.v_contacts = { data: null, error: { message: "relation does not exist", code: "42P01" }, count: null };
    await expect(render({})).rejects.toMatchObject({ message: "relation does not exist" });
  });

  it("renders the first Kilele page with the exact server-side query and 'page 1 of 1,645'", async () => {
    responses.v_contacts = { data: rows, error: null, count: 82205 };
    const html = await render({});
    expect(from).toHaveBeenCalledWith("v_contacts");
    expect(calls.v_contacts).toEqual([
      ["select", ["id, external_id, full_name, email, phone, country, city, status, consent_marketing, contactable, signup_at", { count: "exact" }]],
      ["order", ["signup_at", { ascending: false, nullsFirst: false }]],
      ["order", ["id"]],
      ["range", [0, 49]],
    ]);
    expect(html).toContain("82,205 contacts");
    expect(html).toContain("Page 1 of 1,645");
    expect(html).toContain("Amina Wanjiru");
    expect(html).toContain("amina.wanjiru@example.com");
    expect(html).toContain("+254700000001");
    expect(html).toContain("Nairobi");
    expect(html).toContain("01 Sep 2026");
    expect(html).toContain('data-testid="contacts-table"');
    expect(html).not.toContain('data-testid="empty-state"');
  });

  it("renders null status / consent / signup as 'unknown' or a dash, and contactable as Yes/No badges", async () => {
    responses.v_contacts = { data: rows, error: null, count: 2 };
    const html = await render({});
    expect(html).toMatch(/data-testid="contactable"[^>]*>Yes</);
    expect(html).toMatch(/data-testid="contactable"[^>]*>No</);
    expect(html).toMatch(/data-testid="status"[^>]*>active</);
    expect(html).toMatch(/data-testid="status"[^>]*><span[^>]*muted[^>]*>unknown</);
    expect(html).toMatch(/data-testid="consent"[^>]*>Yes</);
    expect(html).toMatch(/data-testid="consent"[^>]*><span[^>]*muted[^>]*>unknown</);
    expect(html).toContain("—");
  });

  it("puts the contactable rule text from metric_rules in the header popover, never a literal", async () => {
    responses.v_contacts = { data: rows, error: null, count: 2 };
    const html = await render({});
    expect(calls.metric_rules).toEqual([
      ["select", ["key, label, rule_text, alternative_text"]],
      ["eq", ["key", "contactable"]],
      ["maybeSingle", []],
    ]);
    expect(html).toContain('aria-label="How contactable is counted"');
    expect(html).toContain("consent = true (blank/unknown = not consented)");
    expect(html).toContain("Consent-only, or ignoring seed events");
  });

  it("says so when the rule text could not be read (no hard-coded fallback)", async () => {
    responses.v_contacts = { data: rows, error: null, count: 2 };
    responses.metric_rules = { data: null, error: { message: "permission denied" } };
    const html = await render({});
    expect(html).toContain("Amina Wanjiru");
    expect(html).toContain("The rule text could not be loaded");
    expect(html).not.toContain("consent = true");
  });

  it("scrolls the table inside its own container", async () => {
    responses.v_contacts = { data: rows, error: null, count: 2 };
    const html = await render({});
    expect(html).toMatch(/overflow-x-auto[^>]*><table/);
  });
});

describe("/contacts filters (URL only)", () => {
  it("passes q / status / contactable to the query and keeps them in the form", async () => {
    responses.v_contacts = { data: [], error: null, count: 0 };
    const html = await render({ q: "ami", status: "unknown", contactable: "true", page: "2" });
    expect(calls.v_contacts).toContainEqual(["or", ["full_name.ilike.*ami*,email.ilike.ami*"]]);
    expect(calls.v_contacts).toContainEqual(["is", ["status", null]]);
    expect(calls.v_contacts).toContainEqual(["eq", ["contactable", true]]);
    expect(calls.v_contacts).toContainEqual(["range", [50, 99]]);
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).toMatch(/<form[^>]*action="\/contacts"/);
    expect(html).toMatch(/name="q"[^>]*value="ami"/);
    expect(html).toMatch(/<option[^>]*selected=""[^>]*value="unknown"|<option[^>]*value="unknown"[^>]*selected=""/);
    expect(html).toContain('href="/contacts"'); // Clear
    // the form never carries a page field: submitting resets to page 1
    expect(html).not.toMatch(/name="page"/);
  });

  it("shows 'No contacts match' with the form when a filter yields nothing", async () => {
    responses.v_contacts = { data: [], error: null, count: 0 };
    const html = await render({ q: "zzzz" });
    expect(html).toContain("No contacts match");
    expect(html).not.toContain("No contacts loaded yet");
    expect(html).toContain('name="q"');
    expect(html).not.toContain('data-testid="contacts-table"');
  });

  it("shows 'No contacts loaded yet' when the brand has nothing and no filter is set", async () => {
    responses.v_contacts = { data: [], error: null, count: 0 };
    const html = await render({ q: "", status: "", contactable: "" });
    expect(html).toContain("No contacts loaded yet");
    expect(html).not.toContain("No contacts match");
  });

  it("falls back to defaults for invalid values instead of failing", async () => {
    responses.v_contacts = { data: rows, error: null, count: 2 };
    const html = await render({ page: "abc", status: "deleted", contactable: "maybe", q: 'a,b(c)"' });
    expect(calls.v_contacts).toContainEqual(["range", [0, 49]]);
    expect(calls.v_contacts).toContainEqual(["or", ["full_name.ilike.*a b c*,email.ilike.a b c*"]]);
    expect(calls.v_contacts.find(([m]) => m === "eq" || m === "is")).toBeUndefined();
    expect(html).toContain("Page 1 of 1");
  });
});

describe("/contacts paging", () => {
  it("links previous/next preserving q/status/contactable and disables at the bounds", async () => {
    responses.v_contacts = { data: rows, error: null, count: 82205 };
    const html = await render({ page: "2", q: "ami", contactable: "true" });
    expect(html).toContain('href="/contacts?q=ami&amp;contactable=true&amp;page=1"');
    expect(html).toContain('href="/contacts?q=ami&amp;contactable=true&amp;page=3"');
    expect(html).toContain("Page 2 of 1,645");
  });

  it("disables Previous on page 1 and Next on the last page", async () => {
    responses.v_contacts = { data: rows, error: null, count: 82205 };
    let html = await render({});
    expect(html).toMatch(/aria-disabled="true"[^>]*>[^<]*<svg[\s\S]*?<span>Previous<\/span>/);
    expect(html).toContain('href="/contacts?page=2"');
    html = await render({ page: "1645" });
    expect(html).toContain('href="/contacts?page=1644"');
    expect(html).toMatch(/aria-disabled="true"[^>]*><span>Next<\/span>/);
  });

  it("treats a page past the end as 'No contacts on this page' naming the last page — never 'these filters'", async () => {
    responses.v_contacts = [
      { data: null, error: { message: "Requested range not satisfiable", code: "PGRST103" }, count: null },
      { data: null, error: null, count: 82205 },
    ];
    const html = await render({ page: "99999" });
    expect(html).toContain("No contacts on this page");
    expect(html).toContain("the last page is 1,645");
    expect(html).not.toContain("No contacts match");
    expect(html).not.toContain("these filters");
    expect(html).toContain("Page 99,999 of 1,645");
    expect(html).toContain('href="/contacts?page=1645"'); // Previous lands on the last real page
    expect(html).toMatch(/aria-disabled="true"[^>]*><span>Next<\/span>/);
  });
});
