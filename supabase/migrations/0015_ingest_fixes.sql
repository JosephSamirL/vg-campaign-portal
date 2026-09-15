-- 0015_ingest_fixes.sql — the Epic 6 review follow-ups for Stories 6.2 / 6.3 (D-4, D-5, D-8, S10, S11; the
-- 2026-09-15 code reviews). Every function `create or replace`d here keeps its 0012 / 0013 signature except
-- `last_poll_status()`, which gains `requested_at` (dropped + recreated + re-granted, same grant surface).
--
--   6.2 [H]  ingest_provider_events resolved every element with a correlated scan of the send's send_recipients
--            (O(events × recipients): 14 s for 1,000 × 35,000; the real provider ignores page_size, so a Kilele-scale
--            first page is 35k × 35k). Now the send's recipients are materialised ONCE per call into a keyed temp
--            table (external_id, lower(address)) and the page is hash-joined against it; two supporting indexes on
--            send_recipients (send_id, external_id) / (send_id, lower(address)). pgTAP pins 5,000 × 35,000 < 5 s.
--   6.2 [M]  a provider event_id longer than 200 chars is stored as its sha256 hex (the raw id stays in `raw`), so
--            `<batch_id>:<id>` can never exceed the btree row limit and poison the page forever.
--   6.2 [L]  recipient_state ranks unsubscribed (1) > complained (2) > bounced (3) > delivered (4) — the same order
--            the trigger uses, so a same-moment tie never falls to arrival order.
--   6.2 [L]  p_batch_id must belong to p_send_id (provider_batches) → invalid_input otherwise.
--   6.2 [L]  v_campaign_performance emits a portal row only for sends that carry a batch_id (the provider answered);
--            a failed / expired dispatch renders "provider outcome unknown", never "No reports yet".
--   6.2 [L]  delivered / bounced / unsubscribes are counted per contact over contact_id is not null only — key-less
--            events no longer inflate them past `sent` (rates > 100 % from them are gone).
--   6.2 [L]  dispatch_sweep (a2): a never-leased `confirmed` send (dispatch_attempts = 0) that expires is `failed` /
--            dispatch_expired — nothing was ever POSTed, so "partially sent — outcome unknown" would be a lie.
--   6.2 [L]  the seed backfill is factored into internal.backfill_suppression() returns int (the trigger's rule,
--            set-based) — called here once (a no-op where 0012 already ran) and pinned by pgTAP with the trigger disabled.
--   6.3 [M]  last_poll_status() also returns requested_at so the campaigns page can see a poller that stopped
--            running (the newest row older than 20 minutes) — not only one that failed.
--   6.3 [L]  request_poll: an exception from net.http_post marks the row failed / http_post: <error> instead of
--            rolling the row back (the insert lives outside the guarded block).

-- ===========================================================================
-- Part 1 — the recipient lookup indexes (6.2 [H])
-- ===========================================================================
create index idx_send_recipients_send_id_external_id on public.send_recipients (send_id, external_id);
create index idx_send_recipients_send_id_lower_address on public.send_recipients (send_id, lower(address));

-- ===========================================================================
-- Part 2 — the bounded provider id (6.2 [M])
-- ===========================================================================
-- A provider id is stored verbatim up to 200 chars; anything longer becomes its sha256 hex (64 chars) so the stored
-- `<batch_id>:<id>` always fits the unique index. Deterministic, so a replay of the same long id still dedupes.
create function internal.bounded_event_id(p text) returns text
language sql immutable set search_path = '' as $$
  select case when length(p) > 200 then encode(sha256(convert_to(p, 'UTF8')), 'hex') else p end
$$;
comment on function internal.bounded_event_id(text) is
  'A provider event id as stored: verbatim up to 200 chars, else its sha256 hex — keeps <batch_id>:<id> inside the btree row limit (6.2 review [M]).';

-- ===========================================================================
-- Part 3 — internal.ingest_provider_events: recipients materialised once, hash-joined (6.2 [H], [M], [L])
-- ===========================================================================
create or replace function internal.ingest_provider_events(p_send_id uuid, p_batch_id text, p_events jsonb)
returns table (inserted int, duplicates int, foreign_recipient int, unknown_type int, last_event_id text)
language plpgsql volatile set search_path = '' as $$
declare
  v_brand uuid;
  v_campaign uuid;
  v_total int;
  v_foreign int;
  v_inserted int;
  v_unknown int;
begin
  if p_send_id is null or nullif(btrim(coalesce(p_batch_id, '')), '') is null then
    raise exception 'invalid_input' using hint = 'send_id and batch_id are required';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'invalid_input' using hint = 'events must be a JSON array';
  end if;
  -- one ingester per batch at a time (the poller and a manual run must not interleave pages of one stream)
  if not pg_try_advisory_xact_lock(hashtext(p_batch_id)) then
    raise exception 'send_in_progress';
  end if;
  -- tenancy comes from the send's snapshot only — the payload's brand_code is never read (probe row d)
  select s.brand_id, s.campaign_id into v_brand, v_campaign from public.sends s where s.id = p_send_id;
  if not found then
    raise exception 'invalid_input' using hint = 'unknown send ' || p_send_id;
  end if;
  -- the batch must be this send's (6.2 review [L]): a mis-paired call would file batch X's events under send Y
  if not exists (select 1 from public.provider_batches b where b.send_id = p_send_id and b.batch_id = p_batch_id) then
    raise exception 'invalid_input' using hint = 'batch ' || p_batch_id || ' does not belong to send ' || p_send_id;
  end if;
  v_total := jsonb_array_length(p_events);

  -- The send's recipients, ONCE per call, keyed on external_id (pri 0) and lower(address) (pri 1): the page is joined
  -- against this table (hash join / index probe — never a per-element scan of send_recipients; 6.2 review [H]).
  if to_regclass('pg_temp._rk') is not null then drop table pg_temp._rk; end if;
  create temp table _rk on commit drop as
    select 0 as pri, sr.external_id as key, sr.contact_id
      from public.send_recipients sr where sr.send_id = p_send_id
    union all
    select 1, lower(sr.address), sr.contact_id
      from public.send_recipients sr where sr.send_id = p_send_id;
  create index on pg_temp._rk (pri, key);
  analyze pg_temp._rk;

  -- Field names: probe row d first (event_id / recipient_id / occurred_at / type), the v1.4.0 spellings as fallbacks.
  -- The recipient key is resolved ONLY through the polled send's send_recipients (external_id, else the posted
  -- address); anyone else — a real contact of this or another brand who was not in the batch — is a forged event
  -- and is dropped (probe d2). A key-less element cannot be attributed and is kept with contact_id null (amendment #6).
  if to_regclass('pg_temp._ing') is not null then drop table pg_temp._ing; end if;
  create temp table _ing on commit drop as
  with e as (
    select x.ord, x.e,
           internal.bounded_event_id(coalesce(nullif(btrim(x.e->>'event_id'), ''), nullif(btrim(x.e->>'id'), ''), md5(x.e::text))) as raw_id,
           coalesce(public.normalize_event_type(coalesce(x.e->>'type', x.e->>'event', x.e->>'status')), 'unknown') as type,
           internal.try_timestamptz(coalesce(x.e->>'occurred_at', x.e->>'timestamp', x.e->>'created_at')) as occurred_at,
           nullif(btrim(coalesce(x.e->>'recipient_id', x.e->>'external_id',
                                 case when jsonb_typeof(x.e->'recipient') = 'string' then x.e->>'recipient' end,
                                 x.e->'recipient'->>'external_id', x.e->'recipient'->>'id',
                                 x.e->>'contact_id', x.e->>'email')), '') as rk
      from jsonb_array_elements(p_events) with ordinality as x(e, ord)
  ),
  m as (
    select i.ord, r.contact_id, r.pri from e i join pg_temp._rk r on r.pri = 0 and r.key = i.rk
    union all
    select i.ord, r.contact_id, r.pri from e i join pg_temp._rk r on r.pri = 1 and r.key = lower(i.rk)
  ),
  best as (
    -- external_id beats the address; a shared address resolves to one deterministic contact
    select distinct on (m.ord) m.ord, m.contact_id from m order by m.ord, m.pri, m.contact_id
  )
  select e.ord, e.e, e.raw_id, e.type, e.occurred_at, e.rk, b.contact_id
    from e left join best b on b.ord = e.ord;

  select count(*) into v_foreign from pg_temp._ing i where i.rk is not null and i.contact_id is null;

  -- Dedupe on (batch_id, event_id): the stored id is batch-qualified, so the natural key (brand_id, source, event_id)
  -- is exactly that; an exact duplicate — in this page or a replayed stream — does nothing. Duplicates inside one
  -- statement are tolerated by DO NOTHING (only the first is inserted).
  with ins as (
    insert into public.events (brand_id, campaign_id, contact_id, send_id, batch_id, source, event_id, type, occurred_at, raw)
    select v_brand, v_campaign, i.contact_id, p_send_id, p_batch_id, 'provider', p_batch_id || ':' || i.raw_id, i.type, i.occurred_at, i.e
      from pg_temp._ing i
     where i.rk is null or i.contact_id is not null
     order by i.ord
    on conflict (brand_id, source, event_id) do nothing
    returning type
  )
  select count(*), count(*) filter (where ins.type = 'unknown') into v_inserted, v_unknown from ins;

  drop table pg_temp._ing;
  drop table pg_temp._rk;
  return query
    select v_inserted::int,
           (v_total - v_foreign - v_inserted)::int,
           v_foreign::int,
           v_unknown::int,
           internal.bounded_event_id(coalesce(nullif(btrim(p_events->-1->>'event_id'), ''), nullif(btrim(p_events->-1->>'id'), '')));
end $$;
comment on function internal.ingest_provider_events(uuid, text, jsonb) is
  'One page of a provider batch''s events into public.events (source provider): advisory lock per batch (send_in_progress), brand/campaign from the send, the batch must be the send''s (invalid_input), recipients materialised once per call and hash-joined (external_id, else lower(address); anyone else is dropped and counted as foreign_recipient), type via normalize_event_type (unknown kept), occurred_at verbatim (future allowed), stored event_id = <batch_id>:<provider event_id> (ids over 200 chars as sha256 hex), on conflict do nothing. Returns inserted, duplicates, foreign_recipient, unknown_type, last_event_id (the page''s positional last provider id, bounded the same way). Not exposed.';

-- ===========================================================================
-- Part 4 — internal.recipient_state: one rank per terminal type (6.2 [L])
-- ===========================================================================
create or replace function internal.recipient_state(p_send_id uuid, p_contact_id uuid) returns text
language sql stable set search_path = '' as $$
  select e.type::text
    from public.events e
   where e.send_id = p_send_id
     and e.contact_id = p_contact_id
     and e.type in ('delivered', 'bounced', 'unsubscribed', 'complained')
   order by case e.type when 'unsubscribed' then 1 when 'complained' then 2 when 'bounced' then 3 else 4 end,
            e.occurred_at desc nulls last,
            e.id desc
   limit 1
$$;
comment on function internal.recipient_state(uuid, uuid) is
  'The visible terminal state of one recipient of one send, by precedence (unsubscribed > complained > bounced > delivered — the trigger''s order), then latest occurred_at — arrival order and provider timestamps never decide it (probe d2). Null when no terminal event exists.';

-- ===========================================================================
-- Part 5 — internal.backfill_suppression(): the trigger's rule, set-based, on demand (6.2 [L])
-- ===========================================================================
-- Same rule as internal.trg_events_suppress(): the earliest terminal event per contact (same moment → the stronger
-- reason), set when null, moved only earlier, never cleared. Returns the number of contacts changed. Idempotent:
-- a second call changes nothing. 0012's one-off DO block did exactly this for the seed load; this is the reusable copy.
create function internal.backfill_suppression() returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_rows int;
begin
  update public.contacts c
     set suppressed_at = s.at,
         suppressed_reason = s.reason
    from (select distinct on (e.contact_id) e.contact_id,
                 coalesce(e.occurred_at, now()) as at,
                 e.type::text as reason,
                 case e.type when 'unsubscribed' then 1 when 'complained' then 2 else 3 end as rank
            from public.events e
           where e.contact_id is not null
             and e.type in ('bounced', 'unsubscribed', 'complained')
           order by e.contact_id, coalesce(e.occurred_at, now()), case e.type when 'unsubscribed' then 1 when 'complained' then 2 else 3 end) s
   where c.id = s.contact_id
     and (c.suppressed_at is null
          or s.at < c.suppressed_at
          or (s.at = c.suppressed_at
              and s.rank < case c.suppressed_reason when 'unsubscribed' then 1 when 'complained' then 2 when 'bounced' then 3 else 4 end));
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;
comment on function internal.backfill_suppression() is
  'Applies the suppression trigger''s rule set-based over every terminal event (earliest per contact; same moment → unsubscribed > complained > bounced; never cleared, never later). Returns the contacts changed; idempotent. Not exposed.';

-- a no-op wherever 0012's backfill already ran; on a fresh stack (CI) there is nothing to do yet
do $$
declare
  v int;
begin
  select internal.backfill_suppression() into v;
  raise notice 'backfill_suppression: % contact(s) changed', v;
end $$;

-- ===========================================================================
-- Part 6 — dispatch_sweep (a2): a never-leased confirmed send expires as failed, not partial (6.2 [L])
-- ===========================================================================
-- Decision (recorded): `partial` renders as "Partially sent — provider outcome unknown", which is honest only when a
-- POST may have reached the provider. A `confirmed` send with dispatch_attempts = 0 was never leased, so nothing was
-- ever sent: it becomes `failed` / dispatch_expired (the failed status frees the campaign the same way; the owner
-- sees "Failed (dispatch_expired)" and can send again). dispatch_mark_failed() is not used — its CAS admits
-- `dispatched` only and stamps provider_responded_at, which would fabricate a response that never came.
create or replace function internal.dispatch_sweep() returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_url text;
  v_secret text;
  v_capped int := 0;
  v_expired int := 0;
  v_never int := 0;
  v_queued int := 0;
  s record;
begin
  -- (a) the cap: three attempts, no provider response, lease expired → partial (unknown outcome, never re-POSTed)
  for s in
    select id from public.sends
     where status = 'dispatched'
       and batch_id is null
       and dispatch_lease_until is not null and dispatch_lease_until < now()
       and dispatch_attempts >= 3
  loop
    perform public.dispatch_mark_partial(s.id, 'dispatch_outcome_unknown_after_3_attempts');
    v_capped := v_capped + 1;
  end loop;

  -- (a1) never leased (confirmed, 0 attempts) and older than 24 h → failed / dispatch_expired: nothing was ever POSTed
  update public.sends
     set status = 'failed',
         failure_reason = 'dispatch_expired'
   where status = 'confirmed'
     and batch_id is null
     and dispatch_attempts = 0
     and (dispatch_lease_until is null or dispatch_lease_until < now())
     and confirmed_at < now() - interval '24 hours';
  get diagnostics v_never = row_count;

  -- (a2) the age ceiling: older than 24 h (dispatched_at, or confirmed_at when the lease was taken but never
  -- recorded a dispatch), no batch_id, no live lease → partial / dispatch_expired (a POST may have gone out)
  for s in
    select id from public.sends
     where status in ('confirmed', 'dispatched')
       and batch_id is null
       and (dispatch_lease_until is null or dispatch_lease_until < now())
       and coalesce(dispatched_at, confirmed_at) < now() - interval '24 hours'
  loop
    perform public.dispatch_mark_partial(s.id, 'dispatch_expired');
    v_expired := v_expired + 1;
  end loop;

  -- (b) re-invoke the Edge Function for every candidate, signed with the cron secret
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'functions_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_url is null or v_secret is null then
    raise warning 'dispatch_sweep: Vault secrets functions_url / cron_secret missing — capped %, never-leased expired %, expired %, re-invoke skipped', v_capped, v_never, v_expired;
    return;
  end if;

  for s in
    select id from public.sends
     where status in ('confirmed', 'dispatched')
       and batch_id is null
       and (dispatch_lease_until is null or dispatch_lease_until < now())
       and dispatch_attempts < 3
       and confirmed_at < now() - interval '2 min'
       and coalesce(dispatched_at, confirmed_at) > now() - interval '24 hours'
     order by confirmed_at
  loop
    perform net.http_post(
      url := rtrim(v_url, '/') || '/dispatch-send',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body := jsonb_build_object('send_id', s.id),
      timeout_milliseconds := 30000);
    v_queued := v_queued + 1;
  end loop;

  raise notice 'dispatch_sweep: capped %, never-leased expired %, expired %, re-invoked %', v_capped, v_never, v_expired, v_queued;
end $$;
comment on function internal.dispatch_sweep() is
  'pg_cron dispatch-sweep (every 5 min): (a) dispatched, no batch_id, lease expired, 3 attempts → partial dispatch_outcome_unknown_after_3_attempts; (a1) confirmed, never leased (0 attempts), older than 24 h → failed dispatch_expired (nothing was ever POSTed); (a2) confirmed|dispatched, no batch_id, no live lease, older than 24 h → partial dispatch_expired; (b) net.http_post <functions_url>/dispatch-send with x-cron-secret from Vault for confirmed|dispatched sends with no batch_id, a null/expired lease, < 3 attempts, confirmed > 2 min and < 24 h ago. Vault secrets functions_url + cron_secret are created by hand per environment.';

-- ===========================================================================
-- Part 7 — v_campaign_performance: portal rows for answered sends only; per-contact counts over contacts (6.2 [L])
-- ===========================================================================
-- Same column list, names and types as 0012 (create or replace keeps the grant). Changes: the portal row exists only
-- when the send carries a batch_id (the provider answered — a failed / expired dispatch has no row and the send
-- history says "provider outcome unknown"); delivered / bounced / unsubscribes are distinct contacts, so a key-less
-- event (contact_id null) never counts as a recipient — `delivered <= sent` holds and rates over sent stay <= 100 %
-- for per-contact metrics (opens / clicks remain totals and may exceed 100 %).
create or replace view public.v_campaign_performance with (security_invoker = true) as
select c.brand_id, c.id as campaign_id, c.external_id, c.name, c.channel, c.sent_at, c.spend,
       c.target_country, 'reported'::text as source, null::uuid as send_id,
       c.reported_sent as sent, c.reported_delivered as delivered, c.reported_bounced as bounced,
       c.reported_opens as opens, c.reported_clicks as clicks, null::bigint as unsubscribes,
       round(100.0 * c.reported_delivered / nullif(c.reported_sent, 0), 2) as delivered_rate,
       round(100.0 * c.reported_bounced   / nullif(c.reported_sent, 0), 2) as bounce_rate,
       round(100.0 * c.reported_opens     / nullif(c.reported_sent, 0), 2) as open_rate,
       round(100.0 * c.reported_clicks    / nullif(c.reported_sent, 0), 2) as click_rate,
       null::numeric as unsubscribe_rate,
       null::timestamptz as dispatched_at
from public.campaigns c
union all
select c.brand_id, c.id as campaign_id, c.external_id, c.name, c.channel, c.sent_at, c.spend,
       c.target_country, 'portal'::text as source, s.id as send_id,
       s.accepted_count as sent,
       (count(distinct e.contact_id) filter (where e.type = 'delivered'))::int    as delivered,
       (count(distinct e.contact_id) filter (where e.type = 'bounced'))::int      as bounced,
       (count(*) filter (where e.type = 'opened'))::int                            as opens,
       (count(*) filter (where e.type = 'clicked'))::int                           as clicks,
       count(distinct e.contact_id) filter (where e.type = 'unsubscribed')         as unsubscribes,
       round(100.0 * (count(distinct e.contact_id) filter (where e.type = 'delivered'))    / nullif(s.accepted_count, 0), 2) as delivered_rate,
       round(100.0 * (count(distinct e.contact_id) filter (where e.type = 'bounced'))      / nullif(s.accepted_count, 0), 2) as bounce_rate,
       round(100.0 * (count(*) filter (where e.type = 'opened'))                           / nullif(s.accepted_count, 0), 2) as open_rate,
       round(100.0 * (count(*) filter (where e.type = 'clicked'))                          / nullif(s.accepted_count, 0), 2) as click_rate,
       round(100.0 * (count(distinct e.contact_id) filter (where e.type = 'unsubscribed')) / nullif(s.accepted_count, 0), 2) as unsubscribe_rate,
       s.dispatched_at
from public.sends s
join public.campaigns c on c.id = s.campaign_id
left join public.events e on e.send_id = s.id and e.source = 'provider'
where s.source = 'portal' and s.dispatched_at is not null and s.batch_id is not null
group by c.brand_id, c.id, c.external_id, c.name, c.channel, c.sent_at, c.spend, c.target_country, s.id, s.accepted_count, s.dispatched_at;

-- ===========================================================================
-- Part 8 — last_poll_status(): + requested_at, so a poller that STOPPED is visible (6.3 [M])
-- ===========================================================================
-- Return-type change → drop + create + the same grant surface (authenticated only; secdef over internal.poll_log).
-- Still brand-agnostic and timestamps only: status, when the run finished, when it was requested.
drop function public.last_poll_status();
create function public.last_poll_status() returns table (status text, finished_at timestamptz, requested_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.status::text, l.finished_at, l.requested_at
    from internal.poll_log l
   order by l.requested_at desc, l.id desc
   limit 1
$$;
comment on function public.last_poll_status() is
  'Status, finished_at and requested_at of the newest poll run (brand-agnostic — poller health is global; requested_at lets the page see a poller that stopped running). Security definer over the unexposed internal.poll_log; authenticated only.';
revoke all on function public.last_poll_status() from public, anon;
grant execute on function public.last_poll_status() to authenticated;

-- ===========================================================================
-- Part 9 — request_poll: a failing net.http_post leaves a failed row behind (6.3 [L])
-- ===========================================================================
create or replace function internal.request_poll(p_window_hours int) returns bigint
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

  begin
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
  exception when others then
    -- the sub-block rolled back (nothing queued); the row from step 1 survives and says why (6.3 review [L])
    update internal.poll_log set status = 'failed', finished_at = now(), error = left('http_post: ' || sqlerrm, 1000) where id = v_id;
    raise warning 'request_poll: % — poll_log % failed', sqlerrm, v_id;
  end;
  return v_id;
end $$;
comment on function internal.request_poll(int) is
  'One poll run (Story 6.3): inserts internal.poll_log (requested), then net.http_post <functions_url>/poll-events with x-cron-secret from Vault and body { poll_log_id, window_hours } (timeout 60 s), storing net_request_id; a missing Vault secret marks the row failed / missing_secret, an exception from the request marks it failed / http_post: <error> (the row is never rolled back). Returns the poll_log id. Cron only.';
revoke execute on function internal.request_poll(int) from public, anon, authenticated, service_role;
