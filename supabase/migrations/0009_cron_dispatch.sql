-- 0009_cron_dispatch.sql — the dispatch sweep (Story 4.3 AC6; architecture D-7, D-14; Story-Time amendments S13, S20).
--
-- pg_cron job `dispatch-sweep` (every 5 min) → internal.dispatch_sweep():
--   (a) dispatched sends with no batch_id, an expired lease and 3 attempts → partial. The provider never answered
--       three times; the outcome is unknown (FR-19) and the send is NEVER re-POSTed. CAS: status = 'dispatched'
--       and batch_id is null.
--   (b) one net.http_post to the dispatch-send Edge Function per candidate: status in (confirmed, dispatched),
--       batch_id is null, lease null or expired, attempts < 3, confirmed more than 2 minutes ago (younger sends are
--       the app's own invoke in flight — D-12 returns after the lease). `confirmed` is included on purpose: it is
--       the recovery when the portal's invoke never reached the function. The function takes the lease and
--       bumps the attempts (the sweep never touches those columns), so an overlap between the sweep and a live
--       invocation is harmless — the CAS lease admits exactly one of them.
--   Both values come from Vault (`functions_url`, `cron_secret`), created per environment by hand with
--   vault.create_secret() (README) — never in a migration. Missing secrets: step (a) still runs, step (b) is
--   skipped with a warning (visible in the cron.job_run_details output), nothing is queued.
--
-- The job is created DISABLED: the probe (Story 6.1) must first confirm that a replayed Idempotency-Key returns
-- the same batch_id. Until then a crashed dispatch is capped by (a) → partial instead of being retried.
--
-- Runs as the job owner (postgres) in database `postgres`: security invoker, search_path pinned; no grants —
-- `internal` is not exposed and the function is not executable by anon / authenticated / service_role.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create function internal.dispatch_sweep() returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_url text;
  v_secret text;
  v_capped int;
  v_queued int := 0;
  s record;
begin
  -- (a) the cap: three attempts, no provider response, lease expired → partial (unknown outcome, never re-POSTed)
  update public.sends
     set status = 'partial'
   where status = 'dispatched'
     and batch_id is null
     and dispatch_lease_until is not null and dispatch_lease_until < now()
     and dispatch_attempts >= 3;
  get diagnostics v_capped = row_count;

  -- (b) re-invoke the Edge Function for every candidate, signed with the cron secret
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'functions_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_url is null or v_secret is null then
    raise warning 'dispatch_sweep: Vault secrets functions_url / cron_secret missing — capped %, re-invoke skipped', v_capped;
    return;
  end if;

  for s in
    select id from public.sends
     where status in ('confirmed', 'dispatched')
       and batch_id is null
       and (dispatch_lease_until is null or dispatch_lease_until < now())
       and dispatch_attempts < 3
       and confirmed_at < now() - interval '2 min'
     order by confirmed_at
  loop
    perform net.http_post(
      url := rtrim(v_url, '/') || '/dispatch-send',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body := jsonb_build_object('send_id', s.id),
      timeout_milliseconds := 30000);
    v_queued := v_queued + 1;
  end loop;

  raise notice 'dispatch_sweep: capped %, re-invoked %', v_capped, v_queued;
end $$;
comment on function internal.dispatch_sweep() is
  'pg_cron dispatch-sweep (every 5 min): (a) dispatched, no batch_id, lease expired, 3 attempts → partial; (b) net.http_post <functions_url>/dispatch-send with x-cron-secret from Vault for confirmed|dispatched sends with no batch_id, a null/expired lease, < 3 attempts, confirmed > 2 min ago. Vault secrets functions_url + cron_secret are created by hand per environment.';
revoke execute on function internal.dispatch_sweep() from public, anon, authenticated, service_role;

select cron.schedule('dispatch-sweep', '*/5 * * * *', $$select internal.dispatch_sweep()$$);
-- cron.job is owned by supabase_admin (postgres may not UPDATE it directly): alter_job is the supported way
select cron.alter_job(jobid, active := false) from cron.job where jobname = 'dispatch-sweep';
-- enable after the provider probe (Story 6.1) confirms replay returns the same batch_id:
--   select cron.alter_job(jobid, active := true) from cron.job where jobname = 'dispatch-sweep';
