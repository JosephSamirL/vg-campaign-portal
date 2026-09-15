-- 0014_health.sql — the keep-alive probe (Story 7.2 AC1; architecture D-14, Step-3 amendment #16).
--
-- public.health_ping() returns text — `select 'ok'`. The deployed /api/health (app/api/health/route.ts) calls it
-- through PostgREST with the PUBLISHABLE key and no session, so the request runs as role `anon`; a Vercel cron hits
-- the route daily (vercel.json) and the answer proves "the database is reachable and answering" — nothing more.
-- Trivial, security INVOKER (no table is touched, so nothing to escalate), stable, search_path pinned, and executable
-- by `anon` ONLY: revoked from PUBLIC (0002's schema-less default revoke already covers it; explicit here per D-2 —
-- every function carries its own revoke + grant), never granted to `authenticated` (0001_tenancy.test.sql S5/S6
-- assert the exact anon / authenticated sets; anon = {get_shared_results, health_ping} from here on).
--
-- pg_cron activity is NOT documented to prevent free-tier pausing; "project not paused" on the morning of the call is
-- the real control (README, "Call-day checklist"). This probe is the API-side keep-alive (D-14).
create or replace function public.health_ping()
returns text
language sql
stable
security invoker
set search_path = ''
as $$ select 'ok'::text $$;

revoke execute on function public.health_ping() from public;
grant execute on function public.health_ping() to anon;
