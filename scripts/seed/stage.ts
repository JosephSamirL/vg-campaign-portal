// Story 2.2 — read one seed file exactly as it is and COPY it into
// `staging.stage_<entity>` (D-3, Amendment #8).
//
// TS does only the *parsing*: decode (utf-8 fatal / windows-1252), strip BOM
// and NUL bytes, RFC-4180 records (quoted commas and newlines), trim each
// cell, and — when a record has the expected column count — reorder it into
// canonical order and rewrite declared decimal commas. Ragged records keep
// their raw order with their `ncols`. Nothing else is interpreted here: no
// date, consent, country, brand, or email logic (that is SQL, Stories 2.3/2.4).
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { parse } from "csv-parse/sync";
import type { Sql } from "postgres";
import { CANONICAL, normalizeHeader, type FileDialect } from "./dialects";

export interface StagedRecord {
  /** 1-based physical line the record starts on (header = 1). */
  rowNo: number;
  ncols: number;
  cols: string[];
  hadNul: boolean;
}

export interface ParseSummary {
  file: string;
  records: number;
  blankLinesSkipped: number;
  ragged: number;
  hadNul: number;
  multiLine: number;
}

export interface StageMeta {
  runId: string;
  sourceFile: string;
  fileBrand: string;
  asOf: string;
  fileRank: number;
}

type CsvRecord = {
  record: string[];
  info: { lines: number; empty_lines: number };
};

const DECIMAL_COMMA = /^-?\d+,\d+$/;

/** Decode the file per its dialect; a fatal UTF-8 error means the dialect is wrong. */
function decode(dialect: FileDialect, buf: Buffer): string {
  const decoder = new TextDecoder(dialect.encoding, { fatal: dialect.encoding === "utf-8", ignoreBOM: true });
  let text: string;
  try {
    text = decoder.decode(buf);
  } catch (err) {
    throw new Error(`${dialect.file}: not valid ${dialect.encoding} — fix its encoding in dialects.ts (${(err as Error).message})`);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Pure: buffer → staged records + summary. Exported for `tests/stage.test.ts`. */
export function parseSeedFile(dialect: FileDialect, buf: Buffer): { records: StagedRecord[]; summary: ParseSummary } {
  const text = decode(dialect, buf);
  const rows = parse(text, {
    delimiter: dialect.delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    info: true,
    trim: false,
  }) as unknown as CsvRecord[]; // `info: true` wraps each record; the sync typings do not model it

  const summary: ParseSummary = { file: dialect.file, records: 0, blankLinesSkipped: 0, ragged: 0, hadNul: 0, multiLine: 0 };
  if (rows.length === 0) return { records: [], summary };

  // Header → canonical positions. Every canonical column must be present.
  const canonical = CANONICAL[dialect.entity];
  const header = rows[0].record.map((h) => normalizeHeader(h, dialect.headerMap));
  const position = new Map<string, number>();
  header.forEach((h, i) => {
    if (!position.has(h)) position.set(h, i);
  });
  const missing = canonical.filter((c) => !position.has(c));
  if (missing.length > 0) {
    throw new Error(`${dialect.file}: header is missing canonical column(s) ${missing.join(", ")} — got [${header.join(", ")}]`);
  }
  if (header.length !== dialect.expectedCols) {
    throw new Error(`${dialect.file}: header has ${header.length} columns, dialect expects ${dialect.expectedCols}`);
  }
  const order = canonical.map((c) => position.get(c) as number);
  const decimalIdx = dialect.decimalCommaColumns.map((c) => canonical.indexOf(c)).filter((i) => i >= 0);

  const records: StagedRecord[] = [];
  let lastInfo = rows[0].info;
  for (let r = 1; r < rows.length; r++) {
    const { record: raw, info } = rows[r];
    lastInfo = info;
    const hadNul = raw.some((c) => c.includes("\0"));
    let cells = raw.map((c) => c.replace(/\0/g, "").trim());
    const embeddedNewlines = raw.reduce((n, c) => n + (c.match(/\n/g)?.length ?? 0), 0);
    const ncols = cells.length;

    if (ncols === dialect.expectedCols) {
      cells = order.map((i) => cells[i]);
      for (const i of decimalIdx) {
        if (DECIMAL_COMMA.test(cells[i])) cells[i] = cells[i].replace(",", ".");
      }
    } else {
      summary.ragged++;
    }
    if (hadNul) summary.hadNul++;
    if (embeddedNewlines > 0) summary.multiLine++;

    records.push({ rowNo: info.lines - embeddedNewlines, ncols, cols: cells, hadNul });
  }
  summary.records = records.length;
  summary.blankLinesSkipped = lastInfo.empty_lines;
  return { records, summary };
}

/** Postgres `text[]` literal: every element double-quoted, `\` → `\\`, `"` → `\"`. */
export function toArrayLiteral(cols: string[]): string {
  if (cols.length === 0) return "{}";
  return `{${cols.map((c) => `"${c.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

function csvQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** One `COPY … FROM STDIN WITH (FORMAT csv)` line for a staged record. */
export function toCopyLine(meta: StageMeta, rec: StagedRecord): string {
  return [
    meta.runId,
    csvQuote(meta.sourceFile),
    csvQuote(meta.fileBrand),
    String(rec.rowNo),
    String(rec.ncols),
    csvQuote(toArrayLiteral(rec.cols)),
    rec.hadNul ? "t" : "f",
    meta.asOf,
    String(meta.fileRank),
  ].join(",") + "\n";
}

export const STAGING_COLUMNS = "run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank";

export interface StageOptions {
  /** Directory holding the seed CSVs (default `docs/data`). */
  dataDir?: string;
  /** Stage only the first N records of the file. */
  sample?: number;
  runId?: string;
}

export interface StageResult {
  summary: ParseSummary;
  staged: number;
  runId: string;
  table: string;
}

/**
 * Delete the file's previous rows (idempotent re-stage; never truncate — a
 * `--file` run must keep the other files) and COPY its records in with a
 * fresh `run_id`.
 */
export async function stageFile(sql: Sql, dialect: FileDialect, opts: StageOptions = {}): Promise<StageResult> {
  const dataDir = opts.dataDir ?? path.resolve(process.cwd(), "docs", "data");
  const buf = readFileSync(path.join(dataDir, dialect.file));
  const { records, summary } = parseSeedFile(dialect, buf);
  const toStage = opts.sample !== undefined ? records.slice(0, opts.sample) : records;
  const runId = opts.runId ?? randomUUID();
  const tableName = `stage_${dialect.entity}`;
  const table = `staging.${tableName}`;
  const meta: StageMeta = { runId, sourceFile: dialect.file, fileBrand: dialect.brand, asOf: dialect.asOf, fileRank: dialect.fileRank };

  await sql.begin(async (tx) => {
    await tx`delete from ${tx("staging")}.${tx(tableName)} where source_file = ${dialect.file}`;
    const w = await tx.unsafe(`copy ${table} (${STAGING_COLUMNS}) from stdin with (format csv)`).writable();
    for (const rec of toStage) {
      if (!w.write(toCopyLine(meta, rec))) await once(w, "drain");
    }
    w.end();
    await finished(w);
  });

  return { summary, staged: toStage.length, runId, table };
}
