import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/imports` page contract (Story 2.5). The page is an async server component; calling it
 * with mocked `searchParams` and a mocked server client yields a tree of sync components,
 * which `renderToStaticMarkup` turns into HTML we can assert on. The mock records every
 * builder call so the query shape (order, range, count) is pinned too.
 */

type Result = { data: unknown; error: unknown; count?: number | null };

/** One canned result per table, or a queue (array) consumed one call at a time. */
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
  for (const m of ["select", "eq", "order", "range"]) chain[m] = record(m);
  chain.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => {
    const r = responses[table];
    const result = Array.isArray(r) ? r.shift() : r;
    return Promise.resolve(result ?? { data: null, error: { message: `no mock for ${table}` } }).then(resolve, reject);
  };
  return chain;
}

const from = vi.fn((table: string) => builder(table));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from }) }));

const { default: ImportsPage } = await import("../app/(portal)/imports/page");

const KILELE_RUN = "c04d7c8b-75c7-4779-b28b-3a99eb25aa62";
const DELTA_RUN = "d765ea5e-0d01-418a-a91c-00912e2e6905";
const OTHER_BRAND_RUN = "41f5824b-cdda-4012-9585-49d29c79c180";

const runs = [
  {
    id: DELTA_RUN,
    source_file: "kilele-contacts-delta-2026-09-01.csv",
    entity: "contacts",
    started_at: "2026-09-15T09:51:12.404853+00:00",
    finished_at: null,
    summary: { staged: 4180 },
  },
  {
    id: KILELE_RUN,
    source_file: "kilele-contacts.csv",
    entity: "contacts",
    started_at: "2026-09-15T09:51:08.189135+00:00",
    finished_at: "2026-09-15T09:51:13.000000+00:00",
    summary: { loaded: 81144, rejected: 71, warned_rows: 25125, routed: 312 },
  },
];

async function render(params: Record<string, string | string[] | undefined>) {
  const element = await ImportsPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  for (const k of Object.keys(calls)) delete calls[k];
  from.mockClear();
});

describe("/imports run list", () => {
  it("throws the Supabase error (→ error.tsx) instead of rendering an empty table", async () => {
    responses.import_runs = { data: null, error: { message: "relation does not exist", code: "42P01" } };
    await expect(render({})).rejects.toMatchObject({ message: "relation does not exist" });
  });

  it("renders the empty state when the brand has no runs", async () => {
    responses.import_runs = { data: [], error: null };
    const html = await render({});
    expect(html).toContain("No imports yet");
    expect(html).toContain("Seed data has not been loaded for this brand.");
    expect(html).not.toContain("import-run-list");
  });

  it("lists runs newest first through the server client with the story's select and order", async () => {
    responses.import_runs = { data: runs, error: null };
    const html = await render({});
    expect(from).toHaveBeenCalledWith("import_runs");
    expect(calls.import_runs).toEqual([
      ["select", ["id, source_file, entity, started_at, finished_at, summary"]],
      ["order", ["started_at", { ascending: false }]],
    ]);
    expect(html.indexOf("kilele-contacts-delta-2026-09-01.csv")).toBeLessThan(html.indexOf("kilele-contacts.csv"));
    expect(html).toContain("15 Sep 2026, 09:51 UTC");
    // counts from summary; the run without them renders dashes, never 0
    expect(html).toContain("81,144");
    expect(html).toContain("312");
    expect(html).toContain("did not finish");
    expect(html).toContain(`href="/imports?run=${KILELE_RUN}&amp;page=1"`);
    // no run selected → no issue queries
    expect(from).not.toHaveBeenCalledWith("import_issues");
    expect(from).not.toHaveBeenCalledWith("v_import_issue_groups");
  });
});

describe("/imports?run=", () => {
  const groups = [
    { severity: "reject", reason: "wrong_column_count", n: 70 },
    { severity: "warn", reason: "consent_unknown", n: 9810 },
    { severity: "route", reason: "routed_to_karoo", n: 1 },
  ];
  const issues = [
    { id: 1, source_file: "kilele-contacts.csv", row_no: 17, severity: "reject", reason: "wrong_column_count", detail: { value: "7" } },
    { id: 2, source_file: "kilele-contacts.csv", row_no: 22152, severity: "warn", reason: "consent_unknown", detail: { value: "" } },
    { id: 3, source_file: "kilele-contacts.csv", row_no: 40, severity: "warn", reason: "made_up_code", detail: null },
    { id: 4, source_file: "kilele-contacts.csv", row_no: null, severity: "route", reason: "routed_to_karoo", detail: { to: "KAROO", count: 312, secret: "must-not-render" } },
  ];

  it("renders groups then the paged issues with the story's query shape", async () => {
    responses.import_runs = { data: runs, error: null };
    responses.v_import_issue_groups = { data: groups, error: null };
    responses.import_issues = { data: issues, error: null, count: 250 };
    const html = await render({ run: KILELE_RUN, page: "2" });

    expect(calls.v_import_issue_groups).toEqual([
      ["select", ["severity, reason, n"]],
      ["eq", ["run_id", KILELE_RUN]],
      ["order", ["severity"]],
      ["order", ["reason"]],
    ]);
    expect(calls.import_issues).toEqual([
      ["select", ["id, source_file, row_no, severity, reason, detail", { count: "exact" }]],
      ["eq", ["run_id", KILELE_RUN]],
      ["order", ["severity"]],
      ["order", ["reason"]],
      ["order", ["row_no", { nullsFirst: true }]],
      ["range", [100, 199]],
    ]);

    // group headers with counts and copy
    expect(html).toContain("Row has the wrong number of columns and was rejected (70)");
    expect(html).toContain("Consent value not recognised — stored as unknown (9,810)");
    expect(html).toContain("Routed to KAROO (1)");
    // issue rows: single offending value in <code>
    expect(html).toMatch(/<td[^>]*>22152<\/td>/); // row numbers render plain, no thousands separator
    expect(html).toMatch(/<code[^>]*>7<\/code>/);
    // unknown reason code renders verbatim in monospace
    expect(html).toMatch(/<code[^>]*>made_up_code<\/code>/);
    // route issue: sentence only, no row number, nothing else from detail
    expect(html).toContain("routed to KAROO: 312 rows");
    expect(html).not.toContain("must-not-render");
    // pager preserving run: page 2 of 3
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain(`href="/imports?run=${KILELE_RUN}&amp;page=1"`);
    expect(html).toContain(`href="/imports?run=${KILELE_RUN}&amp;page=3"`);
  });

  it("renders the muted sentence (not an empty table) for a clean run, and for a page past the end", async () => {
    responses.import_runs = { data: runs, error: null };
    responses.v_import_issue_groups = { data: [], error: null };
    responses.import_issues = { data: [], error: null, count: 0 };
    const html = await render({ run: DELTA_RUN, page: "1" });
    expect(html).toContain("No rejected or warned rows in this run");
    expect(html).not.toContain("import-issues-table");
    expect(html).toContain("Page 1 of 1");

    // PostgREST answers an offset beyond the total with PGRST103, not an empty page: the page
    // must treat that as "nothing here", fetch the exact count head-only for the pager, and
    // point Prev at the last real page instead of error.tsx.
    calls.import_issues = [];
    responses.import_issues = [
      { data: null, error: { code: "PGRST103", message: "Requested range not satisfiable" }, count: null },
      { data: null, error: null, count: 250 },
    ];
    const past = await render({ run: KILELE_RUN, page: "9" });
    expect(past).toContain("No rejected or warned rows in this run");
    expect(past).toContain("Page 9 of 3");
    expect(past).toContain(`href="/imports?run=${KILELE_RUN}&amp;page=3"`);
    expect(past).not.toContain(`page=8"`);
    expect(calls.import_issues).toEqual([
      ["select", ["id, source_file, row_no, severity, reason, detail", { count: "exact" }]],
      ["eq", ["run_id", KILELE_RUN]],
      ["order", ["severity"]],
      ["order", ["reason"]],
      ["order", ["row_no", { nullsFirst: true }]],
      ["range", [800, 899]],
      ["select", ["id", { count: "exact", head: true }]],
      ["eq", ["run_id", KILELE_RUN]],
    ]);
  });

  it("shows the run list plus 'Run not found' for another brand's run id, without querying issues", async () => {
    responses.import_runs = { data: runs, error: null };
    const html = await render({ run: OTHER_BRAND_RUN });
    expect(html).toContain("Run not found");
    expect(html).toContain("kilele-contacts.csv");
    expect(from).not.toHaveBeenCalledWith("import_issues");
    expect(from).not.toHaveBeenCalledWith("v_import_issue_groups");
  });

  it("treats a malformed run id or page as absent", async () => {
    responses.import_runs = { data: runs, error: null };
    const html = await render({ run: "not-a-uuid", page: "-3" });
    expect(html).not.toContain("Run not found");
    expect(from).not.toHaveBeenCalledWith("import_issues");

    responses.v_import_issue_groups = { data: [], error: null };
    responses.import_issues = { data: [], error: null, count: 0 };
    await render({ run: KILELE_RUN, page: "zero" });
    expect(calls.import_issues.find(([m]) => m === "range")).toEqual(["range", [0, 99]]);
  });

  it("throws when the groups or issues query fails, never rendering a 0", async () => {
    responses.import_runs = { data: runs, error: null };
    responses.v_import_issue_groups = { data: null, error: { message: "permission denied for view", code: "42501" } };
    await expect(render({ run: KILELE_RUN })).rejects.toMatchObject({ message: "permission denied for view" });

    responses.v_import_issue_groups = { data: [], error: null };
    responses.import_issues = { data: null, error: { message: "statement timeout", code: "57014" }, count: null };
    await expect(render({ run: KILELE_RUN })).rejects.toMatchObject({ message: "statement timeout" });
  });
});
