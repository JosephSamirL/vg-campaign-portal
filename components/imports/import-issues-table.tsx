import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Database, Json } from "@/lib/database.types";
import { reasonCopy } from "@/lib/import-reasons";
import { IssueReason } from "./issue-reason";

export type ImportIssueRow = Pick<
  Database["public"]["Tables"]["import_issues"]["Row"],
  "id" | "source_file" | "row_no" | "severity" | "reason" | "detail"
>;

export type ImportIssueGroup = Pick<
  Database["public"]["Views"]["v_import_issue_groups"]["Row"],
  "severity" | "reason" | "n"
>;

type Severity = Database["public"]["Enums"]["issue_severity"];

const SEVERITY_VARIANT: Record<Severity, "destructive" | "secondary" | "outline"> = {
  reject: "destructive",
  warn: "secondary",
  route: "outline",
};

/** `detail` is jsonb; read one key defensively — a missing or non-object detail is simply blank. */
function detailValue(detail: Json | null, key: string): string | number | null {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return null;
  const value = detail[key];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

type Props = {
  runId: string;
  groups: ImportIssueGroup[];
  issues: ImportIssueRow[];
  /** Exact total for the run (`count: 'exact'`), used only for paging. */
  count: number;
  page: number;
  pageSize: number;
};

/**
 * Issue report for one run: the per-(severity, reason) counts from `v_import_issue_groups`,
 * then the current page of rows. A `route` issue is count-only by construction (Story 2.3
 * stores no row data for routed rows) and renders as one sentence; every other issue shows at
 * most the single offending value from `detail.value` — never a whole row (FR-8).
 */
export function ImportIssuesTable({ runId, groups, issues, count, page, pageSize }: Props) {
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const pageHref = (p: number) => `/imports?run=${runId}&page=${p}`;
  // A page past the end (stale link) still shows the pager; Prev then lands on the last real page.
  const prevPage = Math.min(page - 1, totalPages);

  return (
    <div className="flex flex-col gap-4">
      {groups.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" data-testid="issue-groups">
          {groups.map((g) => (
            <li key={`${g.severity}-${g.reason}`} className="flex flex-wrap items-center gap-2">
              <Badge variant={SEVERITY_VARIANT[g.severity ?? "warn"]}>{g.severity}</Badge>
              <span>
                {reasonCopy(g.reason ?? "").text} ({(g.n ?? 0).toLocaleString("en-US")})
              </span>
            </li>
          ))}
        </ul>
      )}

      {issues.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="issues-empty">
          No rejected or warned rows in this run
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table data-testid="import-issues-table" className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead className="text-right">Row</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.map((issue) =>
                issue.severity === "route" ? (
                  <TableRow key={issue.id} data-severity="route">
                    <TableCell>{issue.source_file ?? "—"}</TableCell>
                    <TableCell />
                    <TableCell>
                      <Badge variant="outline">route</Badge>
                    </TableCell>
                    <TableCell colSpan={2}>
                      routed to {detailValue(issue.detail, "to") ?? "?"}: {detailValue(issue.detail, "count") ?? "?"}{" "}
                      rows
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={issue.id} data-severity={issue.severity}>
                    <TableCell>{issue.source_file ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{issue.row_no ?? ""}</TableCell>
                    <TableCell>
                      <Badge variant={SEVERITY_VARIANT[issue.severity]}>{issue.severity}</Badge>
                    </TableCell>
                    <TableCell>
                      <IssueReason code={issue.reason} />
                    </TableCell>
                    <TableCell>
                      {detailValue(issue.detail, "value") !== null && (
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                          {String(detailValue(issue.detail, "value"))}
                        </code>
                      )}
                    </TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Issue pages" data-testid="issue-pager">
        <span className="text-muted-foreground">
          Page {page.toLocaleString("en-US")} of {totalPages.toLocaleString("en-US")} · {count.toLocaleString("en-US")}{" "}
          {count === 1 ? "issue" : "issues"}
        </span>
        <div className="flex gap-2">
          {page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(prevPage)} rel="prev">
                Prev
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              Prev
            </Button>
          )}
          {page < totalPages ? (
            <Button asChild variant="outline" size="sm">
              <Link href={pageHref(page + 1)} rel="next">
                Next
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          )}
        </div>
      </nav>
    </div>
  );
}
