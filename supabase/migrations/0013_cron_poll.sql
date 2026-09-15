-- 0013_cron_poll.sql — the poll schedule (Story 6.3 AC4; architecture D-7, D-8, D-14; docs/provider-api.md
-- `## Probe 2026-09-15` row a).
--
-- internal.request_poll(p_window_hours) — one poll run:
--   1. insert internal.poll_log (status = 'requested')                        ← the row exists BEFORE the request
--   2. net.http_post(<functions_url>/poll-events, x-cron-secret from Vault,
--                    body { poll_log_id, window_hours }, timeout 60 s)         ← pg_net queues it; the Edge Function
--                                                                                flips the row running → ok | failed |
--                                                                                auth_error | rate_limited |
--                                                                                provider_error | deferred
--   3. store the returned request id in poll_log.net_request_id
--   A missing Vault secret (functions_url / cron_secret) marks the row failed / missing_secret and queues nothing —
--   visible through last_poll_status() on the campaigns page as "Report sync has not succeeded since …".
--
-- Jobs (cron.schedule is idempotent by name):
--   poll-events-5m      */5 * * * *   request_poll(48)   — the last two days, every five minutes
--   poll-events-hourly  0 * * * *     request_poll(168)  — the last week, hourly (late / re-appended items, probe c)
--   poll-log-reconcile  */5 * * * *   rows still requested | running after 10 minutes → failed / no_response
--                                     (a run the runtime killed, or a request pg_net never delivered)
-- The two windows overlap by design: the advisory lock per batch + idempotent ingest make the overlap harmless.
--
-- And the probe's enable step (row a — a replayed Idempotency-Key returns the same batch_id, so the sweep may re-POST):
--   dispatch-sweep (0009, created disabled) is enabled here, after 0012 landed the 24-h ceiling, dispatch_expired and
--   dispatch_mark_partial. The hosted secret DISPATCH_RETRY_ENABLED=on is set in the same step (supabase/mock.env
--   carries the same line for the local serve).
--
-- Both Vault secrets are created per environment by hand (README) — never in a migration. Runs as the job owner
-- (postgres) in database `postgres`, exactly like internal.dispatch_sweep() (0009): security INVOKER — pg_cron already
-- runs the job as postgres, so definer would add a privilege escalation surface for nothing (0003 / 0004 / 0012 pin
-- "nothing in internal is security definer") — search_path pinned, executable by nobody but the owner (internal is
-- unexposed; anon / authenticated / service_role revoked).

create extension if not exists pg_cron;
create extension if not exists pg_net;

create function internal.request_poll(p_window_hours int) returns bigint
language plpgsql volatile set search_path = '' as $$
declare
  v_id bigint;
  v_url text;
  v_secret text;
  v_request bigint;
begin
  if p_window_hours is null or p_window_hours <= 0 then
    raise exception 'invalid_input' using hint = 'window_hours must be a positive number of hours';
  end if;

  -- 1. the row first: a request that never comes back is still a run that was requested (D-8)
  insert into internal.poll_log (status) values ('requested') returning id into v_id;

  -- 2. the secrets: either missing → failed / missing_secret, nothing queued
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'functions_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_url is null or v_secret is null then
    update internal.poll_log set status = 'failed', finished_at = now(), error = 'missing_secret' where id = v_id;
    raise warning 'request_poll: Vault secrets functions_url / cron_secret missing — poll_log % failed (missing_secret)', v_id;
    return v_id;
  end if;

  -- 3. the request, signed with the cron secret; 60 s covers the function's own 50-s budget
  v_request := net.http_post(
    url := rtrim(v_url, '/') || '/poll-events',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := jsonb_build_object('poll_log_id', v_id, 'window_hours', p_window_hours),
    timeout_milliseconds := 60000);
  update internal.poll_log set net_request_id = v_request where id = v_id;
  return v_id;
end $$;
comment on function internal.request_poll(int) is
  'One poll run (Story 6.3): inserts internal.poll_log (requested), then net.http_post <functions_url>/poll-events with x-cron-secret from Vault and body { poll_log_id, window_hours } (timeout 60 s), storing net_request_id; a missing Vault secret marks the row failed / missing_secret. Returns the poll_log id. Cron only.';
revoke execute on function internal.request_poll(int) from public, anon, authenticated, service_role;

select cron.schedule('poll-events-5m', '*/5 * * * *', $$select internal.request_poll(48)$$);
select cron.schedule('poll-events-hourly', '0 * * * *', $$select internal.request_poll(168)$$);
select cron.schedule('poll-log-reconcile', '*/5 * * * *',
  $$update internal.poll_log set status = 'failed', finished_at = now(), error = 'no_response' where status in ('requested', 'running') and requested_at < now() - interval '10 minutes'$$);

-- The probe's enable step (docs/provider-api.md, Probe 2026-09-15, row a / decision 1): the sweep may replay.
-- cron.job is owned by supabase_admin (postgres may not UPDATE it directly): alter_job is the supported way.
select cron.alter_job(jobid, active := true) from cron.job where jobname = 'dispatch-sweep';
