import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Database, Json } from "@/lib/database.types";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ImportRunRow = Pick<
  Database["public"]["Tables"]["import_runs"]["Row"],
  "id" | "source_file" | "entity" | "started_at" | "finished_at" | "summary"
>;

/**
 * `summary` is jsonb written by the SQL importer; a key can be absent (an older run, a run
 * that did not finish). Absent renders as "—", never as 0 — a dash is "not counted", a zero
 * is a fact (FR-15).
 */
export function summaryCount(summary: Json | null, key: string): number | null {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) return null;
  const value = summary[key];
  return typeof value === "number" ? value : null;
}

function Count({ value }: { value: number | null }) {
  return value === null ? <span className="text-muted-foreground">—</span> : <>{value.toLocaleString("en-US")}</>;
}

type Props = { runs: ImportRunRow[]; selectedRunId?: string };

/** Newest first (the page orders `started_at desc`); each row links to its own issue report. */
export function ImportRunList({ runs, selectedRunId }: Props) {
  return (
    <div className="overflow-x-auto">
      <Table data-testid="import-run-list">
        <TableHeader>
          <TableRow>
            <TableHead>File</TableHead>
            <TableHead>Entity</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">Loaded</TableHead>
            <TableHead className="text-right">Rejected</TableHead>
            <TableHead className="text-right">Warned</TableHead>
            <TableHead className="text-right">Routed away</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow
              key={run.id}
              data-state={run.id === selectedRunId ? "selected" : undefined}
              className={cn(run.id === selectedRunId && "font-medium")}
            >
              <TableCell className="whitespace-nowrap">
                <Link href={`/imports?run=${run.id}&page=1`} className="underline-offset-4 hover:underline">
                  {run.source_file ?? run.id}
                </Link>
                {run.finished_at === null && (
                  <Badge variant="destructive" className="ml-2 align-middle">
                    did not finish
                  </Badge>
                )}
              </TableCell>
              <TableCell>{run.entity ?? "—"}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDateTime(run.started_at)}</TableCell>
              <TableCell className="text-right tabular-nums">
                <Count value={summaryCount(run.summary, "loaded")} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <Count value={summaryCount(run.summary, "rejected")} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <Count value={summaryCount(run.summary, "warned_rows")} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <Count value={summaryCount(run.summary, "routed")} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
