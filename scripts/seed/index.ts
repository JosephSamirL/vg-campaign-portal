// Seed loader entry point (local machine only — needs the service-role key
// for the users step and `DATABASE_URL` for staging; neither reaches Vercel).
//
//   pnpm seed                         users → stage all eleven files → import contacts ×4, campaigns ×3, events ×3
//   pnpm seed --only=users            Story 1.4 provisioning only
//   pnpm seed --only=stage            Story 2.2 staging only
//   pnpm seed --only=stage --sample=10 --file=kilele-contacts.csv
//   pnpm seed --only=import                      every importer, in load order (2.3 / 2.4)
//   pnpm seed --only=import --entity=campaigns   one entity (contacts | campaigns | events)
//
// Step 1 (Story 1.4): provision the allow-listed logins. Step 2 (Story 2.2):
// COPY every seed file into `staging.stage_*`. Step 3 (Stories 2.3 / 2.4): call
// `internal.import_<entity>(run_id)` per staged file in the fixed D-3 order —
// every contacts file of every brand (base before delta), then campaigns per
// brand, then events per brand (the send log is staged only; Story 4.5 imports
// it). Every keep/reject rule is SQL; this script only calls it, prints one
// summary line per file and exits non-zero if any importer raises.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { DIALECTS, type Entity } from "./dialects";
import { stageFile, type StageResult } from "./stage";
import { provisionUsers } from "./users";

type Only = "users" | "stage" | "import" | "all";

const ENTITIES: readonly Entity[] = ["contacts", "campaigns", "events", "send_log"];

/** Importers, in load order (Story 2.3: contacts; 2.4: campaigns, events; 4.5 adds send_log). */
const IMPORTERS: Partial<Record<Entity, string>> = {
  contacts: "internal.import_contacts",
  campaigns: "internal.import_campaigns",
  events: "internal.import_events",
};

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
        if (!IMPORTERS[entity]) throw new Error(`--entity=${entity}: no importer yet (Story 4.5 adds send_log)`);
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
  /** events only: candidates − inserted (seed rows already in the table) */
  already_present?: number;
}

const SUMMARY_KEYS = ["staged", "loaded", "rejected", "routed", "warnings", "inserted", "updated", "unchanged", "duplicates", "warned_rows"] as const;

/**
 * Stories 2.3 / 2.4 — the fixed load order (D-3): for each entity that has an importer
 * (contacts → campaigns → events), for each staged file in DIALECTS order (Kilele base,
 * Kilele delta, Karoo, Marrakech), call `internal.import_<entity>(run_id)` with the file's
 * staging run_id and print the summary it returns. Nothing is interpreted here: the rules
 * live in SQL. Any raise propagates → `main` exits non-zero.
 */
async function runImports(args: SeedArgs): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (Supavisor session pooler, port 5432; local: postgresql://postgres:postgres@127.0.0.1:54322/postgres)");
  const sql = postgres(url, { max: 1, ssl: /supabase\.co|pooler\.supabase\.com/.test(url) ? "require" : false });
  const entities = args.entity ? [args.entity] : ENTITIES.filter((e) => IMPORTERS[e]);
  const rows: (string | number)[][] = [];
  try {
    for (const entity of entities) {
      const fn = IMPORTERS[entity]!;
      const table = `stage_${entity}`;
      for (const d of DIALECTS.filter((d) => d.entity === entity && (!args.file || d.file === args.file))) {
        const staged = await sql.unsafe<{ run_id: string }[]>(`select distinct run_id from staging.${table} where source_file = $1`, [d.file]);
        if (staged.length !== 1) {
          console.log(`import ${pad(d.file, 38)} skipped — ${staged.length === 0 ? "not staged (run pnpm seed --only=stage first)" : `${staged.length} run_ids staged`}`);
          continue;
        }
        const t0 = Date.now();
        const [{ summary }] = await sql.unsafe<{ summary: ImportSummary }[]>(`select ${fn}($1::uuid) as summary`, [staged[0].run_id]);
        const ms = Date.now() - t0;
        console.log(
          `import ${pad(d.file, 38)} staged ${pad(summary.staged, 6, true)} loaded ${pad(summary.loaded, 6, true)} rejected ${pad(summary.rejected, 4, true)} routed ${pad(summary.routed, 4, true)} warnings ${pad(summary.warnings, 6, true)}  via ${fn} (${ms} ms) run ${staged[0].run_id}`,
        );
        rows.push([d.file, ...SUMMARY_KEYS.map((k) => Number(summary[k] ?? 0)), Number(summary.already_present ?? 0), ms]);
      }
    }
    if (rows.length > 0) {
      console.log("\nImport summary (internal.import_* → import_runs.summary)");
      printTable(["file", ...SUMMARY_KEYS, "already_present", "ms"], rows);
    }
    console.log("\nVerification (count(*) per brand from public.contacts / campaigns / events)");
    const res = await sql.unsafe<{ code: string; contacts: string; routed_in: string; campaigns: string; parents: string; events: string; orphan_events: string }[]>(
      `select b.code,
              (select count(*) from public.contacts c where c.brand_id = b.id)::text as contacts,
              (select count(*) from public.contacts c where c.brand_id = b.id and c.routed_from is not null)::text as routed_in,
              (select count(*) from public.campaigns k where k.brand_id = b.id)::text as campaigns,
              (select count(*) from public.campaigns k where k.brand_id = b.id and k.parent_campaign_id is not null)::text as parents,
              (select count(*) from public.events e where e.brand_id = b.id and e.source = 'seed')::text as events,
              (select count(*) from public.events e where e.brand_id = b.id and e.source = 'seed' and e.campaign_id is null)::text as orphan_events
         from public.brands b order by b.code`,
    );
    printTable(
      ["brand", "contacts", "routed_in", "campaigns", "with_parent", "seed_events", "unknown_campaign"],
      res.map((r) => [r.code, Number(r.contacts), Number(r.routed_in), Number(r.campaigns), Number(r.parents), Number(r.events), Number(r.orphan_events)]),
    );
  } finally {
    await sql.end();
  }
}

async function main() {
  dotenv.config({ path: ".env.local", quiet: true });
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  // Fixed order (D-3): users → stage every file → import (contacts ×4 → campaigns ×3 → events ×3).
  if (args.only === "users" || args.only === "all") await provisionUsers();
  if (args.only === "stage" || args.only === "all") await stage(args);
  if (args.only === "import" || args.only === "all") await runImports(args);
  console.log(`seed: done (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// Run only as `pnpm seed` (tsx), not when `parseArgs` is imported by a test.
// Any importer raise (or a staging / users failure) reaches the catch → exit code 1.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("seed failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
      process.exit(1);
    });
}
