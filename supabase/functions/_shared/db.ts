/**
 * A direct Postgres connection for Edge Functions (Story 6.3). This is how a function reaches `internal.*`
 * (unexposed to PostgREST — D-2) and holds a transaction-scoped advisory lock ACROSS provider HTTP calls: over
 * PostgREST an xact lock lasts one statement, so `pg_try_advisory_xact_lock` + `ingest_provider_events` + the
 * compare-and-set cursor update must share one `sql.begin(...)` on one real connection.
 *
 * `SUPABASE_DB_URL` is injected by the platform — hosted (the project's direct connection) and by `supabase
 * functions serve` locally (`postgresql://postgres:postgres@supabase_db_<project>:5432/postgres`); names starting
 * with `SUPABASE_` cannot be set as secrets or through `--env-file`, so nothing is configured by hand.
 *
 * One client per invocation, `max: 1` (one connection = one lock holder), `prepare: false` (works through the
 * transaction pooler too); the caller MUST `await sql.end()` in `finally` — the runtime may reuse the isolate.
 */
import postgres from "npm:postgres@3.4.5";

export type Sql = ReturnType<typeof postgres>;

export function missingDbEnv(): string[] {
  return ["SUPABASE_DB_URL"].filter((name) => !Deno.env.get(name));
}

export function dbClient(): Sql {
  const url = Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new Error("missing env SUPABASE_DB_URL");
  return postgres(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10 });
}
