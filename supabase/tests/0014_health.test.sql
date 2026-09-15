-- 0014_health.test.sql — the keep-alive probe (Story 7.2 AC1; architecture D-14, amendment #16).
-- public.health_ping() returns text: `select 'ok'`, language sql, stable, security INVOKER, search_path pinned,
-- executable by anon ONLY — the deployed /api/health calls it with the publishable key (never the service role),
-- and 0001_tenancy.test.sql S5 asserts the exact anon set {get_shared_results, health_ping}. Nothing here touches
-- a table, so the probe proves "the database answers" and nothing else.

begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- ============================================================================
-- H: shape
-- ============================================================================
select has_function('public', 'health_ping', '{}'::name[], 'H1 public.health_ping() exists');
select function_returns('public', 'health_ping', '{}'::name[], 'text', 'H1 health_ping returns text');
select function_lang_is('public', 'health_ping', '{}'::name[], 'sql', 'H1 health_ping is language sql');
select is(p.provolatile, 'i'::"char", 'H2 health_ping is stable-or-immutable (no side effects)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'health_ping'
  and p.provolatile = 'i'
union all
select is(p.provolatile, 's'::"char", 'H2 health_ping is stable-or-immutable (no side effects)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'health_ping'
  and p.provolatile <> 'i';
select is(p.prosecdef, false, 'H3 health_ping is security invoker (never in the secdef allow-list)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'health_ping';
select ok(exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=""'), 'H3 health_ping pins search_path = ''''')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'health_ping';

-- ============================================================================
-- G: the grant surface — anon only
-- ============================================================================
select ok(has_function_privilege('anon', 'public.health_ping()', 'execute'), 'G1 anon may execute health_ping (the /api/health probe)');
select ok(not has_function_privilege('authenticated', 'public.health_ping()', 'execute'), 'G2 authenticated may NOT execute health_ping');
select ok(not has_function_privilege('public', 'public.health_ping()', 'execute'), 'G2 PUBLIC may NOT execute health_ping (0000/0002 default revoked, explicit here too)');

-- ============================================================================
-- R: the answer, as anon (the role PostgREST uses for a publishable-key request without a session)
-- ============================================================================
select is(public.health_ping(), 'ok', 'R1 health_ping() answers ''ok'' as postgres');
set local role anon;
select is(current_user::text, 'anon', 'R2 running as anon');
select is(public.health_ping(), 'ok', 'R2 health_ping() answers ''ok'' as anon');
reset role;
set local role authenticated;
select throws_ok($$ select public.health_ping() $$, '42501', null, 'R3 authenticated is refused (permission denied)');
reset role;

select * from finish();
rollback;
