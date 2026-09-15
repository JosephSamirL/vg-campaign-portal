-- 0013_cron_poll.test.sql — the poll schedule (Story 6.3 AC4; architecture D-7, D-8, D-14; probe row a).
-- internal.request_poll(window_hours): insert internal.poll_log(status = 'requested'), then net.http_post to
-- <functions_url>/poll-events with the Vault cron_secret and body { poll_log_id, window_hours }, timeout 60 s,
-- net_request_id stored; without the Vault secrets the row is `failed` / `missing_secret` and nothing is queued.
-- Jobs: poll-events-5m (*/5, 48 h), poll-events-hourly (0 *, 168 h), poll-log-reconcile (*/5: requested|running
-- older than 10 min → failed / no_response). And the probe's enable step: dispatch-sweep is ACTIVE from 0013 on.
--
-- Vault secrets are created INSIDE this transaction and rolled back; pg_net's worker only sees committed queue rows,
-- so nothing is ever sent. poll_log rows inserted here roll back too.

begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- ============================================================================
-- E: extensions + the function
-- ============================================================================
select has_extension('pg_cron', 'E1 pg_cron is installed');
select has_extension('pg_net', 'E1 pg_net is installed');
select has_function('internal', 'request_poll', array['integer'], 'E2 internal.request_poll(int) exists');
select is(p.prosecdef, false, 'E2 request_poll is security invoker (pg_cron runs it as the job owner, postgres — like dispatch_sweep; nothing in internal is definer)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'request_poll';
select ok(exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=""'), 'E2 request_poll pins search_path = ''''')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'request_poll';
select ok(not has_function_privilege('authenticated', 'internal.request_poll(int)', 'execute'), 'E3 authenticated may not execute request_poll');
select ok(not has_function_privilege('anon', 'internal.request_poll(int)', 'execute'), 'E3 anon may not execute request_poll');
select ok(not has_function_privilege('service_role', 'internal.request_poll(int)', 'execute'), 'E3 service_role may not execute request_poll (cron only)');
select ok(not has_function_privilege('public', 'internal.request_poll(int)', 'execute'), 'E3 PUBLIC may not execute request_poll');

-- ============================================================================
-- J: the jobs
-- ============================================================================
select is((select count(*) from cron.job where jobname = 'poll-events-5m'), 1::bigint, 'J1 exactly one cron job poll-events-5m');
select is((select schedule from cron.job where jobname = 'poll-events-5m'), '*/5 * * * *', 'J1 poll-events-5m runs every 5 minutes');
select ok((select command ~ 'internal\.request_poll\(\s*48\s*\)' from cron.job where jobname = 'poll-events-5m'), 'J1 poll-events-5m calls internal.request_poll(48)');
select is((select active from cron.job where jobname = 'poll-events-5m'), true, 'J1 poll-events-5m is active');
select is((select count(*) from cron.job where jobname = 'poll-events-hourly'), 1::bigint, 'J2 exactly one cron job poll-events-hourly');
select is((select schedule from cron.job where jobname = 'poll-events-hourly'), '0 * * * *', 'J2 poll-events-hourly runs at the top of every hour');
select ok((select command ~ 'internal\.request_poll\(\s*168\s*\)' from cron.job where jobname = 'poll-events-hourly'), 'J2 poll-events-hourly calls internal.request_poll(168)');
select is((select active from cron.job where jobname = 'poll-events-hourly'), true, 'J2 poll-events-hourly is active');
select is((select count(*) from cron.job where jobname = 'poll-log-reconcile'), 1::bigint, 'J3 exactly one cron job poll-log-reconcile');
select is((select schedule from cron.job where jobname = 'poll-log-reconcile'), '*/5 * * * *', 'J3 poll-log-reconcile runs every 5 minutes');
select ok((select command ~ 'update\s+internal\.poll_log' and command ~ 'no_response' and command ~ '10 minutes' from cron.job where jobname = 'poll-log-reconcile'), 'J3 poll-log-reconcile marks stale rows failed / no_response after 10 minutes');
select is((select active from cron.job where jobname = 'poll-log-reconcile'), true, 'J3 poll-log-reconcile is active');
-- the probe's enable step (docs/provider-api.md row a): replay returns the same batch_id, so the sweep may run
select is((select active from cron.job where jobname = 'dispatch-sweep'), true, 'J4 dispatch-sweep is ENABLED by 0013 (probe row a: a replayed Idempotency-Key returns the same batch_id)');
select is((select count(*) from cron.job where jobname = 'dispatch-sweep'), 1::bigint, 'J4 ... and there is still exactly one of it');

-- the queue as it stands before any request (other jobs may queue rows; count relatively)
create temp table t_queue_before as select id from net.http_request_queue;
create temp table t_log_before as select id from internal.poll_log;

-- ============================================================================
-- W: without Vault secrets — the row is failed / missing_secret, nothing is queued, the id is returned.
-- ============================================================================
delete from vault.secrets where name in ('functions_url', 'cron_secret');
select is((select count(*) from vault.decrypted_secrets where name in ('functions_url', 'cron_secret')), 0::bigint, 'W0 no functions_url / cron_secret in Vault for this transaction');
select lives_ok($$ select internal.request_poll(48) $$, 'W1 request_poll(48) runs without the Vault secrets (no exception)');
select is((select count(*) from internal.poll_log where id not in (select id from t_log_before)), 1::bigint, 'W2 one poll_log row inserted');
select is((select status::text from internal.poll_log where id not in (select id from t_log_before)), 'failed', 'W2 ... status failed');
select is((select error from internal.poll_log where id not in (select id from t_log_before)), 'missing_secret', 'W2 ... error = missing_secret');
select ok((select finished_at is not null and net_request_id is null from internal.poll_log where id not in (select id from t_log_before)), 'W2 ... finished_at set, no net_request_id');
select is((select count(*) from net.http_request_queue where id not in (select id from t_queue_before)), 0::bigint, 'W3 nothing queued for pg_net without the secrets');
-- last_poll_status() sees it (the campaigns page warns on `failed`)
select is((select status from public.last_poll_status()), 'failed', 'W4 last_poll_status() reports the newest row: failed');

-- ============================================================================
-- V: with Vault secrets (rolled back with everything else) — requested + exactly one POST queued.
-- ============================================================================
select vault.create_secret('http://127.0.0.1:1/functions/v1/', 'functions_url', 'test only, rolled back');
select vault.create_secret('test-cron-secret', 'cron_secret', 'test only, rolled back');
create temp table t_log_w as select id from internal.poll_log;
create temp table t_ret as select internal.request_poll(48) as id;
select is((select count(*) from internal.poll_log where id not in (select id from t_log_w)), 1::bigint, 'V1 one poll_log row inserted');
select is((select id from t_ret), (select max(id) from internal.poll_log), 'V1 ... request_poll returns its id');
select is((select status::text from internal.poll_log where id = (select id from t_ret)), 'requested', 'V1 ... status requested (the function flips it to running → ok | …)');
select ok((select finished_at is null and error is null from internal.poll_log where id = (select id from t_ret)), 'V1 ... finished_at and error null');
create temp table t_queued as
  select q.id, q.url, q.headers, convert_from(q.body, 'UTF8')::jsonb as body, q.timeout_milliseconds
    from net.http_request_queue q where q.id not in (select id from t_queue_before);
select is((select count(*) from t_queued), 1::bigint, 'V2 exactly one request queued');
select is((select net_request_id from internal.poll_log where id = (select id from t_ret)), (select id from t_queued), 'V2 ... net_request_id = the queued request''s id');
select is((select url from t_queued), 'http://127.0.0.1:1/functions/v1/poll-events', 'V3 url = rtrim(functions_url, ''/'') || /poll-events');
select is((select headers->>'x-cron-secret' from t_queued), 'test-cron-secret', 'V3 header x-cron-secret = the Vault cron_secret');
select is((select headers->>'Content-Type' from t_queued), 'application/json', 'V3 header Content-Type = application/json');
select is((select timeout_milliseconds from t_queued), 60000, 'V3 timeout 60 s (the function''s own budget is 50 s)');
select is((select body from t_queued), jsonb_build_object('poll_log_id', (select id from t_ret), 'window_hours', 48), 'V3 body = { poll_log_id, window_hours } and nothing else');
select is((select (internal.request_poll(168) is not null)), true, 'V4 the hourly window (168) also queues');
select is((select convert_from(q.body, 'UTF8')::jsonb->>'window_hours' from net.http_request_queue q where q.id not in (select id from t_queue_before) order by q.id desc limit 1), '168', 'V4 ... with window_hours 168');

-- ============================================================================
-- R: the reconcile statement (the job's own command text, executed here) — 10 minutes, requested|running only.
-- ============================================================================
insert into internal.poll_log (requested_at, status) values
  (now() - interval '11 minutes', 'requested'),
  (now() - interval '11 minutes', 'running'),
  (now() - interval '9 minutes',  'requested'),
  (now() - interval '11 minutes', 'ok'),
  (now() - interval '11 minutes', 'deferred');
create temp table t_recon as select id, status::text as status from internal.poll_log where requested_at < now() - interval '8 minutes' and id not in (select id from t_log_before);
do $$
declare v_cmd text;
begin
  select command into v_cmd from cron.job where jobname = 'poll-log-reconcile';
  execute v_cmd;
end $$;
select results_eq(
  $$ select l.status::text, l.error, (l.finished_at is not null) from internal.poll_log l join t_recon r on r.id = l.id order by l.id $$,
  $$ values ('failed', 'no_response', true), ('failed', 'no_response', true), ('requested', null::text, false), ('ok', null::text, false), ('deferred', null::text, false) $$,
  'R1 requested / running older than 10 min → failed / no_response with finished_at; a 9-min requested, ok and deferred untouched');
select is((select count(*) from internal.poll_log where status = 'failed' and error = 'no_response' and id not in (select id from t_log_before)), 2::bigint, 'R2 exactly two rows reconciled');

select * from finish();
rollback;
