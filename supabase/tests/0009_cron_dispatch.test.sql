-- 0009_cron_dispatch.test.sql — the dispatch sweep (Story 4.3 AC6; architecture D-7; Story-Time amendments S13, S20).
-- pg_cron job `dispatch-sweep` (every 5 min, created DISABLED until the provider probe of Story 6.1) calls
-- internal.dispatch_sweep(): (a) dispatched sends with no batch_id, an expired lease and 3 attempts → partial
-- (FR-19: unknown outcome, never re-POSTed); (b) net.http_post to the dispatch-send Edge Function, with the Vault
-- `cron_secret`, for confirmed|dispatched sends with no batch_id, a null/expired lease, < 3 attempts and confirmed
-- more than 2 minutes ago.
--
-- Synthetic brand A with seven sends in every relevant state; the Vault secrets are created INSIDE this transaction
-- (so the sweep can queue requests) and the whole thing is rolled back — pg_net's worker only sees committed queue
-- rows, so nothing is ever sent, and the local seed data is never touched.

begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- ============================================================================
-- E: extensions + the function + the job
-- ============================================================================
select has_extension('pg_cron', 'E1 pg_cron is installed');
select has_extension('pg_net', 'E1 pg_net is installed');
select has_function('internal', 'dispatch_sweep', array[]::text[], 'E2 internal.dispatch_sweep() exists');
select is(p.prosecdef, false, 'E2 dispatch_sweep is security invoker (runs as the cron owner, postgres)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'dispatch_sweep';
select ok(exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=""'), 'E2 dispatch_sweep pins search_path = ''''')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'dispatch_sweep';
select ok(not has_function_privilege('authenticated', 'internal.dispatch_sweep()', 'execute'), 'E3 authenticated may not execute dispatch_sweep');
select ok(not has_function_privilege('anon', 'internal.dispatch_sweep()', 'execute'), 'E3 anon may not execute dispatch_sweep');
select ok(not has_function_privilege('service_role', 'internal.dispatch_sweep()', 'execute'), 'E3 service_role may not execute dispatch_sweep (cron only)');
select is((select count(*) from cron.job where jobname = 'dispatch-sweep'), 1::bigint, 'E4 exactly one cron job named dispatch-sweep');
select is((select schedule from cron.job where jobname = 'dispatch-sweep'), '*/5 * * * *', 'E4 dispatch-sweep runs every 5 minutes');
select ok((select command like '%internal.dispatch_sweep()%' from cron.job where jobname = 'dispatch-sweep'), 'E4 dispatch-sweep calls internal.dispatch_sweep()');
select is((select active from cron.job where jobname = 'dispatch-sweep'), false, 'E5 dispatch-sweep is created DISABLED (enable after the Story 6.1 probe confirms replay returns the same batch_id)');

-- ============================================================================
-- fixtures — brand A, one campaign per send (uq_sends_one_active_per_campaign):
--   s1 dispatched, attempts 3, lease expired, no batch_id      → (a) partial
--   s2 dispatched, attempts 3, lease LIVE, no batch_id         → untouched (an invocation may still be POSTing)
--   s3 dispatched, attempts 2, lease expired, no batch_id      → (b) re-invoked
--   s4 confirmed,  attempts 0, confirmed 5 min ago              → (b) invoked (the app's invoke never arrived)
--   s5 confirmed,  attempts 0, confirmed just now               → untouched (younger than 2 min: the app's own invoke is in flight)
--   s6 reporting,  batch_id B6                                  → untouched
--   s7 dispatched, attempts 1, lease expired, batch_id B7       → untouched (a batch_id means the provider answered)
-- ============================================================================
create function pg_temp.fx() returns void language plpgsql as $$
declare
  ba uuid;
begin
  insert into public.brands (code, name) values ('SWEEPTEST-A', 'Sweep Test Brand A') returning id into ba;
  perform set_config('sweep.brand_a', ba::text, true);
  insert into public.campaigns (id, brand_id, external_id, name, channel, target_country, sent_at)
  select ('00000000-0000-4000-8000-00000000c00' || i)::uuid, ba, 'CMP-S' || i, 'Sweep ' || i, 'email', 'KE', now() from generate_series(1, 7) i;
  insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, dispatched_at, dispatch_attempts, dispatch_lease_until, batch_id) values
    ('00000000-0000-4000-8000-00000000d001', ba, '00000000-0000-4000-8000-00000000c001', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '40 min', now() - interval '39 min', 3, now() - interval '1 min', null),
    ('00000000-0000-4000-8000-00000000d002', ba, '00000000-0000-4000-8000-00000000c002', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '40 min', now() - interval '39 min', 3, now() + interval '5 min', null),
    ('00000000-0000-4000-8000-00000000d003', ba, '00000000-0000-4000-8000-00000000c003', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '40 min', now() - interval '39 min', 2, now() - interval '1 min', null),
    ('00000000-0000-4000-8000-00000000d004', ba, '00000000-0000-4000-8000-00000000c004', 'confirmed',  'portal', 1, 'o@x.test', now() - interval '5 min',  null,                     0, null,                    null),
    ('00000000-0000-4000-8000-00000000d005', ba, '00000000-0000-4000-8000-00000000c005', 'confirmed',  'portal', 1, 'o@x.test', now(),                     null,                     0, null,                    null),
    ('00000000-0000-4000-8000-00000000d006', ba, '00000000-0000-4000-8000-00000000c006', 'reporting',  'portal', 1, 'o@x.test', now() - interval '40 min', now() - interval '39 min', 1, now() - interval '29 min', 'B6'),
    ('00000000-0000-4000-8000-00000000d007', ba, '00000000-0000-4000-8000-00000000c007', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '40 min', now() - interval '39 min', 1, now() - interval '29 min', 'B7');
  insert into public.provider_batches (send_id, brand_id, batch_id) values
    ('00000000-0000-4000-8000-00000000d006', ba, 'B6'),
    ('00000000-0000-4000-8000-00000000d007', ba, 'B7');
end $$;
select pg_temp.fx();

-- the queue as it stands before any sweep (other requests may be queued by other jobs; count relatively)
create temp table t_queue_before as select id from net.http_request_queue;

-- ============================================================================
-- W: without Vault secrets — step (a) runs, step (b) is skipped with a warning, nothing is queued.
-- ============================================================================
-- a developer may have created the secrets locally to exercise the sweep end to end: remove them for this
-- transaction only (rolled back with everything else) so the "missing secrets" path is what runs here
delete from vault.secrets where name in ('functions_url', 'cron_secret');
select is((select count(*) from vault.decrypted_secrets where name in ('functions_url', 'cron_secret')), 0::bigint, 'W0 no functions_url / cron_secret in Vault for this transaction');
select lives_ok($$ select internal.dispatch_sweep() $$, 'W1 dispatch_sweep() runs without the Vault secrets (no exception)');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000d001'), 'partial', 'W2 (a) s1: dispatched, 3 attempts, lease expired → partial');
select ok((select provider_responded_at is null and batch_id is null from public.sends where id = '00000000-0000-4000-8000-00000000d001'), 'W2 ... no provider response invented: batch_id and provider_responded_at stay null');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000d002'), 'dispatched', 'W3 s2: 3 attempts but the lease is live → untouched');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000d003'), 'dispatched', 'W3 s3: 2 attempts → not capped');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000d007'), 'dispatched', 'W3 s7: a batch_id → untouched even with an expired lease');
select is((select count(*) from net.http_request_queue where id not in (select id from t_queue_before)), 0::bigint, 'W4 nothing queued for pg_net without the secrets');

-- ============================================================================
-- V: with Vault secrets (created here, rolled back with everything else) — step (b) queues one POST per candidate.
-- ============================================================================
select vault.create_secret('http://127.0.0.1:1/functions/v1', 'functions_url', 'test only, rolled back');
select vault.create_secret('test-cron-secret', 'cron_secret', 'test only, rolled back');
select is((select count(*) from vault.decrypted_secrets where name in ('functions_url', 'cron_secret')), 2::bigint, 'V0 the two Vault secrets exist inside this transaction');
select lives_ok($$ select internal.dispatch_sweep() $$, 'V1 dispatch_sweep() runs with the secrets');
create temp table t_queued as
  select q.url, q.headers, convert_from(q.body, 'UTF8')::jsonb as body, q.timeout_milliseconds
    from net.http_request_queue q where q.id not in (select id from t_queue_before);
select is((select count(*) from t_queued), 2::bigint, 'V2 exactly two requests queued: s3 (dispatched, expired lease, 2 attempts) and s4 (confirmed 5 min ago)');
select set_eq(
  $$ select body->>'send_id' from t_queued $$,
  $$ values ('00000000-0000-4000-8000-00000000d003'), ('00000000-0000-4000-8000-00000000d004') $$,
  'V2 ... the bodies name exactly s3 and s4');
select is((select count(*) from t_queued where url = 'http://127.0.0.1:1/functions/v1/dispatch-send'), 2::bigint, 'V3 url = functions_url || /dispatch-send');
select is((select count(*) from t_queued where headers->>'x-cron-secret' = 'test-cron-secret'), 2::bigint, 'V3 header x-cron-secret = the Vault cron_secret');
select is((select count(*) from t_queued where headers->>'Content-Type' = 'application/json'), 2::bigint, 'V3 header Content-Type = application/json');
select is((select count(*) from t_queued where timeout_milliseconds = 30000), 2::bigint, 'V3 timeout 30 s');
select is((select count(*) from t_queued where (body - 'send_id') = '{}'::jsonb), 2::bigint, 'V3 body = { send_id } and nothing else');
-- the states are unchanged by (b): the Edge Function takes the lease, not the sweep
select results_eq(
  $$ select id::text, status::text, dispatch_attempts from public.sends where brand_id = current_setting('sweep.brand_a')::uuid order by id $$,
  $$ values ('00000000-0000-4000-8000-00000000d001', 'partial', 3),
            ('00000000-0000-4000-8000-00000000d002', 'dispatched', 3),
            ('00000000-0000-4000-8000-00000000d003', 'dispatched', 2),
            ('00000000-0000-4000-8000-00000000d004', 'confirmed', 0),
            ('00000000-0000-4000-8000-00000000d005', 'confirmed', 0),
            ('00000000-0000-4000-8000-00000000d006', 'reporting', 1),
            ('00000000-0000-4000-8000-00000000d007', 'dispatched', 1) $$,
  'V4 the sweep never takes a lease or bumps attempts itself: only s1 changed (→ partial)');
-- a second sweep in the same state queues the same two again (the Edge Function's lease is what makes it idempotent)
select lives_ok($$ select internal.dispatch_sweep() $$, 'V5 a second sweep runs');
select is((select count(*) from net.http_request_queue where id not in (select id from t_queue_before)), 4::bigint, 'V5 ... and queues the same two candidates again (their lease is still null/expired)');
-- once s3's lease is taken (what the Edge Function does on arrival) it is no longer a candidate
update public.sends set dispatch_lease_until = now() + interval '10 min', dispatch_attempts = 3 where id = '00000000-0000-4000-8000-00000000d003';
update public.sends set dispatch_lease_until = now() + interval '10 min', dispatch_attempts = 1, status = 'dispatched', dispatched_at = now() where id = '00000000-0000-4000-8000-00000000d004';
select lives_ok($$ select internal.dispatch_sweep() $$, 'V6 a third sweep runs');
select is((select count(*) from net.http_request_queue where id not in (select id from t_queue_before)), 4::bigint, 'V6 ... queues nothing: both candidates now hold a live lease');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000d003'), 'dispatched', 'V6 s3 at 3 attempts with a LIVE lease is not capped yet');

select is(current_user::text, 'postgres', 'Z1 role is postgres throughout (the cron owner)');

select * from finish();
rollback;
