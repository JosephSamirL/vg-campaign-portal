// Seed loader entry point (local machine only — needs the service-role key
// for the users step and `DATABASE_URL` for staging; neither reaches Vercel).
//
//   pnpm seed                         users, stage all eleven files, then import
//   pnpm seed --only=users            Story 1.4 provisioning only
//   pnpm seed --only=stage            Story 2.2 staging only
//   pnpm seed --only=stage --sample=10 --file=kilele-contacts.csv
//   pnpm seed --only=import --entity=contacts   Story 2.3: run internal.import_contacts per staged file
//
// Step 1 (Story 1.4): provision the allow-listed logins. Step 2 (Story 2.2):
// COPY every seed file into `staging.stage_*`. Step 3 (Story 2.3): call
// `internal.import_<entity>(run_id)` per staged file — every keep/reject rule
// is SQL; this script only calls it and prints the summary. Story 2.4 adds
// campaigns / events and the full load order.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { DIALECTS, type Entity } from "./dialects";
import { stageFile, type StageResult } from "./stage";
import { provisionUsers } from "./users";

type Only = "users" | "stage" | "import" | "all";

const ENTITIES: readonly Entity[] = ["contacts", "campaigns", "events", "send_log"];

/** Importers that exist so far (Story 2.3: contacts; 2.4 adds campaigns / events; 4.5 send_log). */
const IMPORTERS: Partial<Record<Entity, string>> = { contacts: "internal.import_contacts" };

export interface SeedArgs {
  only: Only;
  sample?: number;
  file?: string;
  entity?: Entity;
}

/** `--only=users|stage|import|all` (default all), `--sample=N`, `--file=<basename>`, `--entity=<entity>`. */
export function parseArgs(argv: string[]): SeedArgs {
  const args: SeedArgs = { only: "all" };
  for (const a of argv) {
    const [flag, value] = a.split("=", 2);
    switch (flag) {
      case "--only":
        if (value !== "users" && value !== "stage" && value !== "import" && value !== "all") {
          throw new Error(`--only must be users|stage|import|all, got ${value}`);
        }
        args.only = value;
        break;
      case "--entity": {
        const entity = ENTITIES.find((e) => e === value);
        if (!entity) throw new Error(`--entity must be one of ${ENTITIES.join("|")}, got ${value}`);
        if (!IMPORTERS[entity]) throw new Error(`--entity=${entity}: no importer yet (Story 2.4 adds campaigns / events)`);
        args.entity = entity;
        break;
      }
      case "--sample": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) throw new Error(`--sample must be a non-negative integer, got ${value}`);
        args.sample = n;
        break;
      }
      case "--file":
        if (!value) throw new Error("--file needs a basename, e.g. --file=kilele-contacts.csv");
        if (!DIALECTS.some((d) => d.file === value)) throw new Error(`--file=${value} is not one of: ${DIALECTS.map((d) => d.file).join(", ")}`);
        args.file = value;
        break;
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

const STAGING_TABLES = ["stage_contacts", "stage_campaigns", "stage_events", "stage_send_log"] as const;

function pad(s: string | number, width: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(width) : str.padEnd(width);
}

function printTable(headers: string[], rows: (string | number)[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells: (string | number)[]) => cells.map((c, i) => pad(c, widths[i], typeof c === "number")).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

async function stage(args: SeedArgs): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (Supavisor session pooler, port 5432; local: postgresql://postgres:postgres@127.0.0.1:54322/postgres)");
  const sql = postgres(url, { max: 1, ssl: /supabase\.co|pooler\.supabase\.com/.test(url) ? "require" : false });
  const dialects = args.file ? DIALECTS.filter((d) => d.file === args.file) : DIALECTS;
  const results: StageResult[] = [];
  try {
    for (const d of dialects) {
      const t0 = Date.now();
      const r = await stageFile(sql, d, { sample: args.sample });
      results.push(r);
      console.log(`staged ${pad(d.file, 38)} ${pad(r.staged, 7, true)} rows → ${r.table} (${Date.now() - t0} ms)`);
    }

    console.log("\nParse summary");
    printTable(
      ["file", "records", "staged", "blank_lines", "ragged", "had_nul", "multi_line"],
      results.map((r) => [r.summary.file, r.summary.records, r.staged, r.summary.blankLinesSkipped, r.summary.ragged, r.summary.hadNul, r.summary.multiLine]),
    );

    console.log("\nVerification (select source_file, count(*), min(ncols), max(ncols), count(*) filter (where had_nul) … group by 1 order by 1)");
    const rows: (string | number)[][] = [];
    for (const table of STAGING_TABLES) {
      const res = await sql.unsafe<{ source_file: string; count: string; min: number; max: number; had_nul: string }[]>(
        `select source_file, count(*)::text as count, min(ncols) as min, max(ncols) as max, (count(*) filter (where had_nul))::text as had_nul
           from staging.${table} group by 1 order by 1`,
      );
      for (const r of res) rows.push([table, r.source_file, Number(r.count), r.min, r.max, Number(r.had_nul)]);
    }
    printTable(["table", "source_file", "count", "min_ncols", "max_ncols", "had_nul"], rows);
  } finally {
    await sql.end();
  }
}

interface ImportSummary {
  staged: number;
  rejected: number;
  routed: number;
  candidates: number;
  inserted: number;
  updated: number;
  unchanged: number;
  loaded: number;
  duplicates: number;
  warnings: number;
  warned_rows: number;
}

const SUMMARY_KEYS = ["staged", "rejected", "routed", "candidates", "inserted", "updated", "unchanged", "loaded", "duplicates", "warnings", "warned_rows"] as const;

/**
 * Story 2.3 — per staged file (DIALECTS order: kilele base, kilele delta, karoo, marrakech
 * for contacts) call `internal.import_<entity>(run_id)` with the file's staging run_id and
 * print the summary it returns. Nothing is interpreted here: the rules live in SQL.
 */
async function runImports(args: SeedArgs): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (Supavisor session pooler, port 5432; local: postgresql://postgres:postgres@127.0.0.1:54322/postgres)");
  const sql = postgres(url, { max: 1, ssl: /supabase\.co|pooler\.supabase\.com/.test(url) ? "require" : false });
  const entities = args.entity ? [args.entity] : ENTITIES.filter((e) => IMPORTERS[e]);
  const dialects = DIALECTS.filter((d) => entities.includes(d.entity) && (!args.file || d.file === args.file));
  const rows: (string | number)[][] = [];
  try {
    for (const d of dialects) {
      const fn = IMPORTERS[d.entity]!;
      const table = `stage_${d.entity}`;
      const staged = await sql.unsafe<{ run_id: string }[]>(`select distinct run_id from staging.${table} where source_file = $1`, [d.file]);
      if (staged.length !== 1) {
        console.log(`import ${pad(d.file, 38)} skipped — ${staged.length === 0 ? "not staged (run pnpm seed --only=stage first)" : `${staged.length} run_ids staged`}`);
        continue;
      }
      const t0 = Date.now();
      const [{ summary }] = await sql.unsafe<{ summary: ImportSummary }[]>(`select ${fn}($1::uuid) as summary`, [staged[0].run_id]);
      const ms = Date.now() - t0;
      console.log(`import ${pad(d.file, 38)} ${pad(summary.loaded, 7, true)} loaded via ${fn} (${ms} ms) run ${staged[0].run_id}`);
      rows.push([d.file, ...SUMMARY_KEYS.map((k) => Number(summary[k])), ms]);
    }
    if (rows.length > 0) {
      console.log("\nImport summary (internal.import_* → import_runs.summary)");
      printTable(["file", ...SUMMARY_KEYS, "ms"], rows);
    }
    if (entities.includes("contacts")) {
      console.log("\nVerification (select b.code, count(*) … from public.contacts group by 1 order by 1)");
      const res = await sql.unsafe<{ code: string; contacts: string; routed_in: string }[]>(
        `select b.code, count(*)::text as contacts, (count(*) filter (where c.routed_from is not null))::text as routed_in
           from public.contacts c join public.brands b on b.id = c.brand_id group by 1 order by 1`,
      );
      printTable(["brand", "contacts", "routed_in"], res.map((r) => [r.code, Number(r.contacts), Number(r.routed_in)]));
    }
  } finally {
    await sql.end();
  }
}

async function main() {
  dotenv.config({ path: ".env.local", quiet: true });
  const args = parseArgs(process.argv.slice(2));
  if (args.only === "users" || args.only === "all") await provisionUsers();
  if (args.only === "stage" || args.only === "all") await stage(args);
  if (args.only === "import" || args.only === "all") await runImports(args);
  console.log("seed: done");
}

// Run only as `pnpm seed` (tsx), not when `parseArgs` is imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("seed failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
