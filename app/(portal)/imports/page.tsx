import { z } from "zod";
import { ImportIssuesTable, type ImportIssueGroup, type ImportIssueRow } from "@/components/imports/import-issues-table";
import { ImportRunList, type ImportRunRow } from "@/components/imports/import-run-list";
import { EmptyState } from "@/components/layout/empty-state";
import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 100;

type SearchParams = Record<string, string | string[] | undefined>;

/** `?run=&page=` are the only state this page has (D-12: paging/filter state lives in the URL). */
const paramsSchema = z.object({
  run: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

/** Invalid values are treated as absent rather than as an error: a bad link is not a failure. */
function parseParams(raw: SearchParams): { run?: string; page: number } {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const run = paramsSchema.shape.run.safeParse(first(raw.run));
  const page = paramsSchema.shape.page.safeParse(first(raw.page));
  return { run: run.success ? run.data : undefined, page: page.success ? page.data : 1 };
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/*
 * Query helpers. Every one of them throws on a Supabase `error`: supabase-js does not throw,
 * and a swallowed error would render an empty table pretending to be zero (FR-15). The
 * throw reaches `./error.tsx`. Reads go through the cookie-session server client, so RLS
 * scopes everything to the caller's brand (D-12) — no `brand_id` filter here by design.
 */

async function loadRuns(supabase: Supabase): Promise<ImportRunRow[]> {
  const { data, error } = await supabase
    .from("import_runs")
    .select("id, source_file, entity, started_at, finished_at, summary")
    .order("started_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

async function loadGroups(supabase: Supabase, runId: string): Promise<ImportIssueGroup[]> {
  const { data, error } = await supabase
    .from("v_import_issue_groups")
    .select("severity, reason, n")
    .eq("run_id", runId)
    .order("severity")
    .order("reason");
  if (error) throw error;
  return data ?? [];
}

async function loadIssues(supabase: Supabase, runId: string, page: number): Promise<{ issues: ImportIssueRow[]; count: number }> {
  const from = (page - 1) * PAGE_SIZE;
  const { data, count, error } = await supabase
    .from("import_issues")
    .select("id, source_file, row_no, severity, reason, detail", { count: "exact" })
    .eq("run_id", runId)
    .order("severity")
    .order("reason")
    .order("row_no", { nullsFirst: true })
    .range(from, from + PAGE_SIZE - 1);
  // PostgREST answers an offset beyond the total with PGRST103 rather than an empty page.
  // A `?page=` past the end is a stale link, not a failed query: render the empty sentence
  // with a truthful pager (exact count, head-only) instead of error.tsx.
  if (error?.code === "PGRST103") {
    const head = await supabase.from("import_issues").select("id", { count: "exact", head: true }).eq("run_id", runId);
    if (head.error) throw head.error;
    return { issues: [], count: head.count ?? 0 };
  }
  if (error) throw error;
  return { issues: data ?? [], count: count ?? 0 };
}

/**
 * `/imports` — every load for the caller's brand, newest first, and the issue report for the
 * selected run (FR-8). Read-only: seeds are engineer-run (FR-5), so there is no action here.
 */
export default async function ImportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { run: runId, page } = parseParams(await searchParams);
  const supabase = await createClient();

  const runs = await loadRuns(supabase);
  if (runs.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Imports</h1>
        <EmptyState title="No imports yet" description="Seed data has not been loaded for this brand." />
      </div>
    );
  }

  // A run id that RLS did not return is another brand's (or nobody's): report it, never error.
  const selected = runId ? runs.find((r) => r.id === runId) : undefined;
  const detail = selected
    ? await Promise.all([loadGroups(supabase, selected.id), loadIssues(supabase, selected.id, page)])
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Imports</h1>
        <p className="text-sm text-muted-foreground">
          Every file loaded for your brand, with what was rejected or warned and why. Pick a run to see its rows.
        </p>
      </div>

      <ImportRunList runs={runs} selectedRunId={selected?.id} />

      {runId && !selected && (
        <p className="text-sm text-muted-foreground" data-testid="run-not-found">
          Run not found
        </p>
      )}

      {selected && detail && (
        <section className="flex flex-col gap-3" aria-labelledby="run-detail-heading">
          <h2 id="run-detail-heading" className="text-lg font-semibold">
            {selected.source_file ?? selected.id}
          </h2>
          <ImportIssuesTable
            runId={selected.id}
            groups={detail[0]}
            issues={detail[1].issues}
            count={detail[1].count}
            page={page}
            pageSize={PAGE_SIZE}
          />
        </section>
      )}
    </div>
  );
}
