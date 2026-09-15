-- 0012_events_ingest.test.sql — ingest events in any order, any number of times (Story 6.2; D-4, D-5, D-8, S4, S10, S11,
-- S19; docs/provider-api.md `## Probe 2026-09-15`).
--
-- Synthetic brands INGEST-A / INGEST-B (fresh codes — the local seed load is never touched), one transaction, rolled back.
--   T  shape + grant surface of everything the migration adds (trigger, functions, enum, table, view, RPC).
--   I  the same 20 provider events ingested in order, reversed, shuffled and each array doubled → byte-identical
--      contacts.suppressed_at / suppressed_reason, identical events, identical v_campaign_performance rows (AC6);
--      bounced-then-delivered stays suppressed; the forged recipients (a stranger, a real contact of the brand who was
--      not in the batch, a real contact of ANOTHER brand) are dropped and counted; a future occurred_at is stored
--      verbatim; an unknown type and a key-less element insert; a poison element never aborts the call.
--   S  the trigger's monotonic rule on direct inserts (earlier wins, later never moves it, same moment → stronger reason,
--      never cleared) + the backfill shape.
--   R  recipient_state by precedence; C complete_sends.
--   P  poll_log / v_last_sync / last_poll_status.
--   V  v_campaign_performance portal rows.
--   D  Epic-4 carry-ins: dispatch_mark_partial CAS, the sweep's cap reason + 24 h ceiling, the batch_id collision.
--   M  Epic-2 carry-ins (S19): source-qualified followed event colliding with a native id, [0-9] normalisers,
--      self-pointer, clock_timestamp, blank / followed campaign pointers.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ============================================================================
-- T: shape
-- ============================================================================
select has_function('internal', 'trg_events_suppress', array[]::text[], 'T1 internal.trg_events_suppress() exists');
select has_trigger('public', 'events', 'trg_events_insert_suppress', 'T1 trigger trg_events_insert_suppress on events');
select is((select tgtype::int & 2 from pg_trigger where tgname = 'trg_events_insert_suppress'), 0, 'T1 ... AFTER (not BEFORE)');
select is((select tgtype::int & 1 from pg_trigger where tgname = 'trg_events_insert_suppress'), 1, 'T1 ... FOR EACH ROW');
select ok((select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_events_insert_suppress')
          ~ $r$ AFTER INSERT ON public\.events FOR EACH ROW WHEN \(.*new\.contact_id IS NOT NULL.*new\.type = ANY .*'bounced'.*'unsubscribed'.*'complained'.*\) EXECUTE FUNCTION internal\.trg_events_suppress\(\)$r$,
  'T1 ... WHEN (contact_id not null and type in bounced/unsubscribed/complained) — never fires for the seed load');
select has_function('internal', 'try_timestamptz', array['text'], 'T2 internal.try_timestamptz(text) exists');
select has_function('internal', 'ingest_provider_events', array['uuid', 'text', 'jsonb'], 'T3 internal.ingest_provider_events(uuid, text, jsonb) exists');
select has_function('internal', 'recipient_state', array['uuid', 'uuid'], 'T4 internal.recipient_state(uuid, uuid) exists');
select function_returns('internal', 'recipient_state', array['uuid', 'uuid'], 'text', 'T4 ... returns text');
select has_function('internal', 'complete_sends', array[]::text[], 'T5 internal.complete_sends() exists');
select function_returns('internal', 'complete_sends', array[]::text[], 'integer', 'T5 ... returns int');
select has_type('internal', 'poll_status', 'T6 internal.poll_status exists');
select enum_has_labels('internal', 'poll_status', array['requested', 'running', 'ok', 'failed', 'auth_error', 'rate_limited', 'provider_error', 'deferred'], 'T6 poll_status labels (S11 + deferred)');
select has_table('internal', 'poll_log', 'T7 internal.poll_log exists');
select columns_are('internal', 'poll_log', array['id', 'requested_at', 'net_request_id', 'status', 'finished_at', 'batches', 'pages', 'inserted', 'duplicates', 'error'], 'T7 poll_log columns');
select has_index('internal', 'poll_log', 'idx_poll_log_requested_at', 'T7 poll_log index on requested_at');
select ok(not has_table_privilege('authenticated', 'internal.poll_log', 'SELECT') and not has_table_privilege('anon', 'internal.poll_log', 'SELECT'), 'T7 poll_log has no grant to exposed roles');
select has_view('public', 'v_last_sync', 'T8 public.v_last_sync exists');
select columns_are('public', 'v_last_sync', array['brand_id', 'last_ok_at'], 'T8 v_last_sync columns');
select ok(exists (select 1 from pg_options_to_table((select reloptions from pg_class where oid = 'public.v_last_sync'::regclass)) o
                  where o.option_name = 'security_invoker' and o.option_value in ('true', 'on', '1')), 'T8 v_last_sync is security_invoker');
select ok(has_table_privilege('authenticated', 'public.v_last_sync', 'SELECT') and not has_table_privilege('anon', 'public.v_last_sync', 'SELECT'), 'T8 v_last_sync SELECT to authenticated only');
select has_function('public', 'last_poll_status', array[]::text[], 'T9 public.last_poll_status() exists');
select ok(p.prosecdef and p.provolatile = 's' and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'), 'T9 last_poll_status is stable security definer with search_path pinned')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'last_poll_status';
select ok(has_function_privilege('authenticated', 'public.last_poll_status()', 'execute') and not has_function_privilege('anon', 'public.last_poll_status()', 'execute'), 'T9 last_poll_status: authenticated yes, anon no');
select columns_are('public', 'v_campaign_performance',
  array['brand_id', 'campaign_id', 'external_id', 'name', 'channel', 'sent_at', 'spend', 'target_country', 'source', 'send_id',
        'sent', 'delivered', 'bounced', 'opens', 'clicks', 'unsubscribes',
        'delivered_rate', 'bounce_rate', 'open_rate', 'click_rate', 'unsubscribe_rate', 'dispatched_at'],
  'T10 v_campaign_performance: Story 3.1''s columns in order + dispatched_at appended');
select ok(has_table_privilege('authenticated', 'public.v_campaign_performance', 'SELECT') and not has_table_privilege('anon', 'public.v_campaign_performance', 'SELECT'), 'T10 ... re-granted to authenticated only');
select has_function('public', 'dispatch_mark_partial', array['uuid', 'text'], 'T11 public.dispatch_mark_partial(uuid, text) exists');
select ok(has_function_privilege('service_role', 'public.dispatch_mark_partial(uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.dispatch_mark_partial(uuid, text)', 'execute')
          and not has_function_privilege('anon', 'public.dispatch_mark_partial(uuid, text)', 'execute')
          and not has_function_privilege('public', 'public.dispatch_mark_partial(uuid, text)', 'execute'), 'T11 ... service_role only');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.prosecdef), 'T12 nothing in internal is security definer');
select ok(bool_and(exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')), 'T12 every 6.2 function pins search_path = ''''')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'internal' and p.proname in ('trg_events_suppress', 'try_timestamptz', 'ingest_provider_events', 'recipient_state', 'complete_sends', 'dispatch_sweep', 'import_events', 'import_campaigns', 'import_contacts', 'import_send_log'))
   or (n.nspname = 'public' and p.proname in ('last_poll_status', 'dispatch_mark_partial', 'dispatch_record_result'));
select has_index('public', 'events', 'idx_events_send_id_type', 'T13 events (send_id, type) partial index for the portal rows');

-- try_timestamptz
select is(internal.try_timestamptz('2026-09-15T18:18:42Z'), '2026-09-15 18:18:42+00'::timestamptz, 'T14 ISO-8601 Z');
select is(internal.try_timestamptz('2026-09-15 18:18:42'), '2026-09-15 18:18:42+00'::timestamptz, 'T14 zone-less reads as UTC');
select is(internal.try_timestamptz('2099-01-01T00:00:00Z'), '2099-01-01 00:00:00+00'::timestamptz, 'T14 a future stamp is accepted');
select is(internal.try_timestamptz(v), null, format('T14 %L → null, no error', v))
from unnest(array['', '  ', 'yesterday', 'now', 'infinity', '2026-13-45T00:00:00Z', 'abc', null]) v;

-- ============================================================================
-- fixtures
-- ============================================================================
create function pg_temp.brand(p_code text) returns uuid language sql stable as $$ select id from public.brands where code = p_code $$;
create function pg_temp.contact(p_ext text) returns public.contacts language sql stable as $$
  select c from public.contacts c where c.external_id = p_ext and c.brand_id in (pg_temp.brand('INGEST-A'), pg_temp.brand('INGEST-B'))
$$;

insert into public.brands (code, name) values ('INGEST-A', 'Ingest Test Brand A'), ('INGEST-B', 'Ingest Test Brand B');
insert into public.campaigns (id, brand_id, external_id, name, channel, sent_at) values
  ('00000000-0000-4000-8000-0000000000ca', pg_temp.brand('INGEST-A'), 'ING-KA', 'Ingest A', 'email', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000cc', pg_temp.brand('INGEST-A'), 'ING-KC', 'Ingest C', 'email', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000cd', pg_temp.brand('INGEST-A'), 'ING-KD', 'Ingest D', 'email', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000cb', pg_temp.brand('INGEST-B'), 'ING-KB', 'Ingest B', 'email', now() - interval '2 days');
-- six recipients C1..C6 + C7 (a real contact of A who is NOT in the batch) in A; CB1 in B (the forged target)
insert into public.contacts (brand_id, external_id, full_name, email, consent_marketing, status, signup_at)
select pg_temp.brand('INGEST-A'), 'ING-C' || i, 'Contact ' || i, 'ing-c' || i || '@ingest.test', true, 'active', now() from generate_series(1, 7) i;
insert into public.contacts (brand_id, external_id, full_name, email, consent_marketing, status, signup_at)
values (pg_temp.brand('INGEST-B'), 'ING-CB1', 'Contact B1', 'ing-cb1@ingest.test', true, 'active', now());
-- the polled send SA (reporting, batch B1, 6 accepted); SC / SD for complete_sends
insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, dispatched_at, provider_responded_at, dispatch_attempts, batch_id, accepted_count, rejected_count) values
  ('00000000-0000-4000-8000-0000000000aa', pg_temp.brand('INGEST-A'), '00000000-0000-4000-8000-0000000000ca', 'reporting', 'portal', 6, 'o@x.test', now() - interval '61 min', now() - interval '60 min', now() - interval '60 min', 1, 'B1', 6, 0),
  ('00000000-0000-4000-8000-0000000000ac', pg_temp.brand('INGEST-A'), '00000000-0000-4000-8000-0000000000cc', 'reporting', 'portal', 1, 'o@x.test', now() - interval '26 hours', now() - interval '25 hours', now() - interval '25 hours', 1, 'B-C', 1, 0),
  ('00000000-0000-4000-8000-0000000000ad', pg_temp.brand('INGEST-A'), '00000000-0000-4000-8000-0000000000cd', 'partial',   'portal', 1, 'o@x.test', now() - interval '26 hours', now() - interval '25 hours', now() - interval '25 hours', 1, 'B-D', 0, 1);
insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
select '00000000-0000-4000-8000-0000000000aa', pg_temp.brand('INGEST-A'), (pg_temp.contact('ING-C' || i)).id, 'ING-C' || i, 'ing-c' || i || '@ingest.test' from generate_series(1, 6) i;
insert into public.provider_batches (send_id, brand_id, batch_id) values
  ('00000000-0000-4000-8000-0000000000aa', pg_temp.brand('INGEST-A'), 'B1'),
  ('00000000-0000-4000-8000-0000000000ac', pg_temp.brand('INGEST-A'), 'B-C'),
  ('00000000-0000-4000-8000-0000000000ad', pg_temp.brand('INGEST-A'), 'B-D');

-- The 20 events (probe row d field names: event_id / recipient_id / type / occurred_at / brand_code). T1 < T2 < … < T7.
--   e01 C1 delivered T1 · e02 C1 opened T2 · e03 C2 delivered T1 · e04 C2 bounced T2 · e05 C2 delivered T3 (later — must NOT clear)
--   e06 C3 delivered T1 · e07 C3 unsubscribed T4 · e08 C4 delivered T1 · e09 C4 clicked T5 · e10 C4 opened T2 · e11 C4 opened T6
--   e12 C5 complained T3 · e13 C5 bounced T2 (earlier than the complaint → wins) · e14 C6 type weird T1 (→ unknown)
--   e15 recipient NOPE (a stranger) · e16 C7 (real A contact, not in the batch) · e17 CB1 (real contact of brand B, brand_code KAROO-style forgery)
--   e18 C6 delivered, occurred_at in the future · e19 no recipient key at all · e20 C6 bounced, no timestamp
create temp table t_events as
select jsonb_build_array(
  jsonb_build_object('event_id', 'evt-B1-01', 'recipient_id', 'ING-C1', 'brand_code', 'account', 'type', 'delivered',    'occurred_at', '2026-09-15T10:00:01Z'),
  jsonb_build_object('event_id', 'evt-B1-02', 'recipient_id', 'ING-C1', 'brand_code', 'account', 'type', 'opened',       'occurred_at', '2026-09-15T10:00:02Z'),
  jsonb_build_object('event_id', 'evt-B1-03', 'recipient_id', 'ING-C2', 'brand_code', 'account', 'type', 'delivered',    'occurred_at', '2026-09-15T10:00:01Z'),
  jsonb_build_object('event_id', 'evt-B1-04', 'recipient_id', 'ING-C2', 'brand_code', 'account', 'type', 'bounced',      'occurred_at', '2026-09-15T10:00:02Z'),
  jsonb_build_object('event_id', 'evt-B1-05', 'recipient_id', 'ING-C2', 'brand_code', 'account', 'type', 'delivered',    'occurred_at', '2026-09-15T10:00:03Z'),
  jsonb_build_object('event_id', 'evt-B1-06', 'recipient_id', 'ING-C3', 'brand_code', 'account', 'type', 'delivered',    'occurred_at', '2026-09-15T10:00:01Z'),
  jsonb_build_object('event_id', 'evt-B1-07', 'recipient_id', 'ING-C3', 'brand_code', 'account', 'type', 'unsubscribed', 'occurred_at', '2026-09-15T10:00:04Z'),
  jsonb_build_object('event_id', 'evt-B1-08', 'recipient_id', 'ING-C4', 'brand_code', 'account', 'type', 'delivered',    'occurred_at', '2026-09-15T10:00:01Z'),
  jsonb_build_object('event_id', 'evt-B1-09', 'recipient_id', 'ING-C4', 'brand_code', 'account', 'type', 'clicked',      'occurred_at', '2026-09-15T10:00:05Z'),
  jsonb_build_object('event_id', 'evt-B1-10', 'recipient_id', 'ING-C4', 'brand_code', 'account', 'type', 'opened',       'occurred_at', '2026-09-15T10:00:02Z'),
  jsonb_build_object('event_id', 'evt-B1-11', 'recipient_id', 'ING-C4', 'brand_code', 'account', 'type', 'opened',       'occurred_at', '2026-09-15T10:00:06Z'),
  jsonb_build_object('event_id', 'evt-B1-12', 'recipient_id', 'ING-C5', 'brand_code', 'account', 'type', 'complained',   'occurred_at', '2026-09-15T10:00:03Z'),
  jsonb_build_object('event_id', 'evt-B1-13', 'recipient_id', 'ING-C5', 'brand_code', 'account', 'type', 'bounced',      'occurred_at', '2026-09-15T10:00:02Z'),
  jsonb_build_object('event_id', 'evt-B1-14', 'recipient_id', 'ING-C6', 'brand_code', 'account', 'type', 'weird',        'occurred_at', '2026-09-15T10:00:01Z'),
  jsonb_build_object('event_id', 'evt-B1-15', 'recipient_id', 'NOPE',   'brand_code', 'account', 'type', 'delivered',    'occurred_at', '2026-09-15T10:00:01Z'),
  jsonb_build_object('event_id', 'evt-B1-16', 'recipient_id', 'ING-C7', 'brand_code', 'account', 'type', 'delivered',    'occurred_at', '2026-09-15T10:00:01Z'),
  jsonb_build_object('event_id', 'evt-B1-forged', 'recipient_id', 'ING-CB1', 'brand_code', 'KAROO', 'type', 'bounced',   'occurred_at', '2026-09-15T10:00:01Z'),
  jsonb_build_object('event_id', 'evt-B1-18', 'recipient_id', 'ING-C6', 'brand_code', 'account', 'type', 'delivered',    'occurred_at', to_char(now() + interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  jsonb_build_object('event_id', 'evt-B1-19', 'brand_code', 'account', 'type', 'delivered', 'occurred_at', '2026-09-15T10:00:01Z'),
  jsonb_build_object('event_id', 'evt-B1-20', 'recipient_id', 'ING-C6', 'brand_code', 'account', 'type', 'bounced')
) as ev;

-- orders: in order / reversed / a fixed shuffle / the array doubled (every event twice, probe d2 duplicates)
create function pg_temp.reorder(p jsonb, p_order int[]) returns jsonb language sql immutable as $$
  select jsonb_agg(p -> (i - 1) order by o) from unnest(p_order) with ordinality as t(i, o)
$$;
create temp table t_orders (run int, label text, ev jsonb);
insert into t_orders
select 1, 'in order', ev from t_events union all
select 2, 'reversed', pg_temp.reorder(ev, array[20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]) from t_events union all
select 3, 'shuffled', pg_temp.reorder(ev, array[5,13,18,2,20,9,1,17,12,7,4,15,10,19,3,14,8,11,6,16]) from t_events union all
select 4, 'doubled', ev || pg_temp.reorder(ev, array[20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]) from t_events;

-- snapshots per run
create temp table t_snap_contacts (run int, external_id text, suppressed_at timestamptz, suppressed_reason text);
create temp table t_snap_events (run int, event_id text, type text, contact text, occurred_at timestamptz);
create temp table t_snap_perf (run int, r text);
create temp table t_snap_result (run int, inserted int, duplicates int, foreign_recipient int, unknown_type int, last_event_id text);
create temp table t_snap_state (run int, external_id text, state text);

create function pg_temp.run(p_run int) returns void language plpgsql as $$
declare
  v_ev jsonb;
begin
  -- reset the world between runs (one transaction: no savepoint would keep the temp snapshots)
  delete from public.events where send_id = '00000000-0000-4000-8000-0000000000aa';
  update public.contacts set suppressed_at = null, suppressed_reason = null
   where brand_id in (pg_temp.brand('INGEST-A'), pg_temp.brand('INGEST-B'));
  select ev into v_ev from t_orders where run = p_run;
  insert into t_snap_result select p_run, * from internal.ingest_provider_events('00000000-0000-4000-8000-0000000000aa', 'B1', v_ev);
  insert into t_snap_contacts
    select p_run, c.external_id, c.suppressed_at, c.suppressed_reason from public.contacts c
     where c.brand_id in (pg_temp.brand('INGEST-A'), pg_temp.brand('INGEST-B'));
  insert into t_snap_events
    select p_run, e.event_id, e.type::text, c.external_id, e.occurred_at from public.events e left join public.contacts c on c.id = e.contact_id
     where e.send_id = '00000000-0000-4000-8000-0000000000aa';
  insert into t_snap_perf
    select p_run, row(p.source, p.send_id, p.sent, p.delivered, p.bounced, p.opens, p.clicks, p.unsubscribes,
                      p.delivered_rate, p.bounce_rate, p.open_rate, p.click_rate, p.unsubscribe_rate, p.dispatched_at)::text
      from public.v_campaign_performance p where p.campaign_id = '00000000-0000-4000-8000-0000000000ca';
  insert into t_snap_state
    select p_run, 'ING-C' || i, internal.recipient_state('00000000-0000-4000-8000-0000000000aa', (pg_temp.contact('ING-C' || i)).id) from generate_series(1, 7) i;
end $$;

-- ============================================================================
-- I: the invariance
-- ============================================================================
select pg_temp.run(1);
select pg_temp.run(2);
select pg_temp.run(3);
select pg_temp.run(4);

select is((select row(inserted, duplicates, foreign_recipient, unknown_type, last_event_id)::text from t_snap_result where run = 1),
  row(17, 0, 3, 1, 'evt-B1-20')::text, 'I1 in order: 17 inserted, 0 duplicates, 3 foreign (NOPE, C7 not in the batch, brand B''s CB1), 1 unknown type, last id = the positional last');
select is((select row(inserted, duplicates, foreign_recipient, unknown_type, last_event_id)::text from t_snap_result where run = 2),
  row(17, 0, 3, 1, 'evt-B1-01')::text, 'I1 reversed: same counts, last id = evt-B1-01');
select is((select row(inserted, duplicates, foreign_recipient, unknown_type)::text from t_snap_result where run = 3),
  row(17, 0, 3, 1)::text, 'I1 shuffled: same counts');
select is((select row(inserted, duplicates, foreign_recipient, unknown_type, last_event_id)::text from t_snap_result where run = 4),
  row(17, 17, 6, 1, 'evt-B1-01')::text, 'I1 doubled (40 elements): 17 inserted, 17 duplicates, 6 foreign — every event landed once');

select results_eq($$ select external_id, suppressed_at, suppressed_reason from t_snap_contacts where run = 1 order by external_id $$,
                  $$ select external_id, suppressed_at, suppressed_reason from t_snap_contacts where run = 2 order by external_id $$, 'I2 suppression identical: in order = reversed');
select results_eq($$ select external_id, suppressed_at, suppressed_reason from t_snap_contacts where run = 1 order by external_id $$,
                  $$ select external_id, suppressed_at, suppressed_reason from t_snap_contacts where run = 3 order by external_id $$, 'I2 suppression identical: in order = shuffled');
select results_eq($$ select external_id, suppressed_at, suppressed_reason from t_snap_contacts where run = 1 order by external_id $$,
                  $$ select external_id, suppressed_at, suppressed_reason from t_snap_contacts where run = 4 order by external_id $$, 'I2 suppression identical: in order = doubled');
select results_eq($$ select event_id, type, contact, occurred_at from t_snap_events where run = 1 order by event_id $$,
                  $$ select event_id, type, contact, occurred_at from t_snap_events where run = 2 order by event_id $$, 'I3 events identical: in order = reversed');
select results_eq($$ select event_id, type, contact, occurred_at from t_snap_events where run = 1 order by event_id $$,
                  $$ select event_id, type, contact, occurred_at from t_snap_events where run = 3 order by event_id $$, 'I3 events identical: in order = shuffled');
select results_eq($$ select event_id, type, contact, occurred_at from t_snap_events where run = 1 order by event_id $$,
                  $$ select event_id, type, contact, occurred_at from t_snap_events where run = 4 order by event_id $$, 'I3 events identical: in order = doubled');
select is((select count(*) from t_snap_events where run = 1), 17::bigint, 'I3 ... 17 events per run');
select results_eq($$ select r from t_snap_perf where run = 1 order by r $$, $$ select r from t_snap_perf where run = 2 order by r $$, 'I4 v_campaign_performance identical: in order = reversed');
select results_eq($$ select r from t_snap_perf where run = 1 order by r $$, $$ select r from t_snap_perf where run = 3 order by r $$, 'I4 v_campaign_performance identical: in order = shuffled');
select results_eq($$ select r from t_snap_perf where run = 1 order by r $$, $$ select r from t_snap_perf where run = 4 order by r $$, 'I4 v_campaign_performance identical: in order = doubled');
select results_eq($$ select external_id, state from t_snap_state where run = 1 order by 1 $$, $$ select external_id, state from t_snap_state where run = 2 order by 1 $$, 'I5 recipient_state identical: in order = reversed');
select results_eq($$ select external_id, state from t_snap_state where run = 1 order by 1 $$, $$ select external_id, state from t_snap_state where run = 3 order by 1 $$, 'I5 recipient_state identical: in order = shuffled');
select results_eq($$ select external_id, state from t_snap_state where run = 1 order by 1 $$, $$ select external_id, state from t_snap_state where run = 4 order by 1 $$, 'I5 recipient_state identical: in order = doubled');

-- the end state itself (run 4 is what is in the tables now)
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-C2')), row('2026-09-15 10:00:02+00'::timestamptz, 'bounced')::text,
  'I6 C2: bounced at T2 then delivered at T3 → STAYS suppressed at T2 (never cleared, never later)');
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-C3')), row('2026-09-15 10:00:04+00'::timestamptz, 'unsubscribed')::text, 'I6 C3: unsubscribed at T4');
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-C5')), row('2026-09-15 10:00:02+00'::timestamptz, 'bounced')::text,
  'I6 C5: complained at T3 and bounced at T2 → the EARLIER moment wins whatever arrived first');
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-C6')), row(now(), 'bounced')::text, 'I6 C6: bounced with no timestamp → suppressed at now() (constant in the transaction)');
select is((select count(*) from public.contacts c where c.external_id in ('ING-C1', 'ING-C4', 'ING-C7', 'ING-CB1') and c.suppressed_at is not null), 0::bigint,
  'I6 C1 / C4 (no terminal event), C7 (not in the batch) and brand B''s CB1 (forged) are untouched');
select is((select public.is_contactable(c) from public.contacts c where c.external_id = 'ING-C2'), false, 'I6 a suppressed contact is not contactable (is_contactable untouched, D-4)');
select is((select public.is_contactable(c) from public.contacts c where c.external_id = 'ING-CB1'), true, 'I6 the forged target stays contactable');
select is((select count(*) from public.events where batch_id = 'B1' and (raw->>'recipient_id') in ('NOPE', 'ING-C7', 'ING-CB1')), 0::bigint, 'I7 the three forged / foreign events were not stored');
select is((select count(*) from public.events where brand_id = pg_temp.brand('INGEST-B')), 0::bigint, 'I7 nothing landed in brand B (tenancy from the send''s snapshot only, never brand_code)');
select is((select row(type::text, contact_id is null, occurred_at)::text from public.events where event_id = 'B1:evt-B1-14'),
  row('unknown', false, '2026-09-15 10:00:01+00'::timestamptz)::text, 'I8 type weird → unknown, stored with its contact');
select is((select row(type::text, contact_id is null)::text from public.events where event_id = 'B1:evt-B1-19'), row('delivered', true)::text, 'I8 a key-less element is kept with contact_id null');
select cmp_ok((select occurred_at from public.events where event_id = 'B1:evt-B1-18'), '>', now(), 'I9 a future occurred_at is stored verbatim');
select is((select occurred_at from public.events where event_id = 'B1:evt-B1-20'), null::timestamptz, 'I9 an absent timestamp is null');
select is((select row(brand_id, campaign_id, send_id, batch_id, source::text)::text from public.events where event_id = 'B1:evt-B1-01'),
  row(pg_temp.brand('INGEST-A'), '00000000-0000-4000-8000-0000000000ca'::uuid, '00000000-0000-4000-8000-0000000000aa'::uuid, 'B1', 'provider')::text,
  'I10 brand / campaign / send / batch from the send, source provider');
select is((select raw from public.events where event_id = 'B1:evt-B1-01'), (select ev -> 0 from t_events), 'I10 raw = the element verbatim');
select is((select count(*) from public.events where batch_id = 'B1' and event_id not like 'B1:evt-B1-%'), 0::bigint, 'I10 stored event_id = <batch_id>:<provider event_id>');

-- a fifth ingest of the same page changes nothing; a page for the same batch with poison elements never aborts
select is((select row(inserted, duplicates, foreign_recipient)::text from internal.ingest_provider_events('00000000-0000-4000-8000-0000000000aa', 'B1', (select ev from t_events))),
  row(0, 17, 3)::text, 'I11 replaying the page: 0 inserted, 17 duplicates, 3 foreign');
select is((select row(inserted, duplicates, foreign_recipient, unknown_type, last_event_id)::text
           from internal.ingest_provider_events('00000000-0000-4000-8000-0000000000aa', 'B1',
             '["garbage", 42, {"type": "delivered"}, {"id": "legacy-1", "event": "open", "recipient": {"external_id": "ING-C1"}, "timestamp": "not a date"}, {"event_id": "evt-B1-21", "recipient_id": "ING-C1", "type": null}]'::jsonb)),
  row(5, 0, 0, 3, 'evt-B1-21')::text, 'I12 poison elements (a string, a number, no ids, legacy field names, a null type) all insert; nothing aborts');
select is((select row(type::text, contact_id = (pg_temp.contact('ING-C1')).id, occurred_at)::text from public.events where event_id = 'B1:legacy-1'),
  row('opened', true, null::timestamptz)::text, 'I12 legacy names: id / event / recipient.external_id / timestamp (unparseable → null)');
select is((select count(*) from public.events where send_id = '00000000-0000-4000-8000-0000000000aa'), 22::bigint, 'I12 22 events after the poison page');
select throws_ok($$ select * from internal.ingest_provider_events('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e', 'B1', '[]'::jsonb) $$, 'P0001', 'invalid_input', 'I13 unknown send → invalid_input');
select throws_ok($$ select * from internal.ingest_provider_events('00000000-0000-4000-8000-0000000000aa', 'B1', '{"events": []}'::jsonb) $$, 'P0001', 'invalid_input', 'I13 not an array → invalid_input');
select throws_ok($$ select * from internal.ingest_provider_events('00000000-0000-4000-8000-0000000000aa', '', '[]'::jsonb) $$, 'P0001', 'invalid_input', 'I13 blank batch → invalid_input');
select is((select row(inserted, duplicates, foreign_recipient, unknown_type, last_event_id)::text from internal.ingest_provider_events('00000000-0000-4000-8000-0000000000aa', 'B1', '[]'::jsonb)),
  row(0, 0, 0, 0, null::text)::text, 'I13 an empty page → zeros, last_event_id null');
select ok(not has_function_privilege('authenticated', 'internal.ingest_provider_events(uuid, text, jsonb)', 'execute')
          and not has_function_privilege('anon', 'internal.ingest_provider_events(uuid, text, jsonb)', 'execute')
          and not has_function_privilege('service_role', 'internal.ingest_provider_events(uuid, text, jsonb)', 'execute'), 'I14 ingest is executable by no exposed role');

-- ============================================================================
-- S: the trigger on direct inserts — monotonic on presence and value
-- ============================================================================
insert into public.events (brand_id, source, event_id, type, contact_id, occurred_at)
values (pg_temp.brand('INGEST-A'), 'seed', 'S-1', 'bounced', (pg_temp.contact('ING-C1')).id, '2026-09-10T12:00:00Z');
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-C1')), row('2026-09-10 12:00:00+00'::timestamptz, 'bounced')::text, 'S1 a seed bounce sets suppressed_at / reason');
insert into public.events (brand_id, source, event_id, type, contact_id, occurred_at)
values (pg_temp.brand('INGEST-A'), 'seed', 'S-2', 'unsubscribed', (pg_temp.contact('ING-C1')).id, '2026-09-11T12:00:00Z');
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-C1')), row('2026-09-10 12:00:00+00'::timestamptz, 'bounced')::text, 'S2 a LATER unsubscribe never moves it later');
insert into public.events (brand_id, source, event_id, type, contact_id, occurred_at)
values (pg_temp.brand('INGEST-A'), 'seed', 'S-3', 'complained', (pg_temp.contact('ING-C1')).id, '2026-09-09T12:00:00Z');
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-C1')), row('2026-09-09 12:00:00+00'::timestamptz, 'complained')::text, 'S3 an EARLIER complaint moves it earlier');
insert into public.events (brand_id, source, event_id, type, contact_id, occurred_at)
values (pg_temp.brand('INGEST-A'), 'seed', 'S-4', 'unsubscribed', (pg_temp.contact('ING-C1')).id, '2026-09-09T12:00:00Z');
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-C1')), row('2026-09-09 12:00:00+00'::timestamptz, 'unsubscribed')::text, 'S4 same moment: unsubscribed outranks complained (order-invariant reason)');
insert into public.events (brand_id, source, event_id, type, contact_id, occurred_at)
values (pg_temp.brand('INGEST-A'), 'seed', 'S-5', 'bounced', (pg_temp.contact('ING-C1')).id, '2026-09-09T12:00:00Z');
select is((select suppressed_reason from pg_temp.contact('ING-C1')), 'unsubscribed', 'S4 same moment: a bounce does not outrank it');
insert into public.events (brand_id, source, event_id, type, contact_id, occurred_at)
values (pg_temp.brand('INGEST-A'), 'seed', 'S-6', 'delivered', (pg_temp.contact('ING-C1')).id, '2026-09-12T12:00:00Z'),
       (pg_temp.brand('INGEST-A'), 'seed', 'S-7', 'opened', (pg_temp.contact('ING-C1')).id, '2026-09-12T12:00:00Z');
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-C1')), row('2026-09-09 12:00:00+00'::timestamptz, 'unsubscribed')::text, 'S5 delivered / opened never clear it');
insert into public.events (brand_id, source, event_id, type, contact_id, occurred_at)
values (pg_temp.brand('INGEST-A'), 'seed', 'S-8', 'bounced', null, '2026-09-01T12:00:00Z');
select lives_ok($$ insert into public.events (brand_id, source, event_id, type, contact_id, occurred_at) values ((select id from public.brands where code = 'INGEST-A'), 'seed', 'S-9', 'bounced', null, '2026-09-01T12:00:00Z') $$, 'S6 a contact-less bounce inserts (the WHEN clause skips the trigger)');
select is((select count(*) from public.contacts where brand_id = pg_temp.brand('INGEST-A') and suppressed_at = '2026-09-01T12:00:00Z'), 0::bigint, 'S6 ... and suppresses nobody');
-- a re-import cannot un-suppress: the contacts upsert never writes the two columns (Story 2.3) — pinned on the function source
select ok((select prosrc !~ 'suppressed_at\s*=' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'import_contacts'), 'S7 import_contacts never sets suppressed_at (the 6.2 copy too)');

-- ============================================================================
-- R: recipient_state — precedence, not time (probe d2)
-- ============================================================================
select is(internal.recipient_state('00000000-0000-4000-8000-0000000000aa', (pg_temp.contact('ING-C2')).id), 'bounced', 'R1 C2: bounced at T2, delivered at T3 → bounced (precedence over the later delivery)');
select is(internal.recipient_state('00000000-0000-4000-8000-0000000000aa', (pg_temp.contact('ING-C3')).id), 'unsubscribed', 'R1 C3: unsubscribed');
select is(internal.recipient_state('00000000-0000-4000-8000-0000000000aa', (pg_temp.contact('ING-C5')).id), 'complained', 'R1 C5: complained outranks bounced');
select is(internal.recipient_state('00000000-0000-4000-8000-0000000000aa', (pg_temp.contact('ING-C1')).id), 'delivered', 'R1 C1: delivered (opens / clicks are not terminal states)');
select is(internal.recipient_state('00000000-0000-4000-8000-0000000000aa', (pg_temp.contact('ING-C4')).id), 'delivered', 'R1 C4: delivered');
select is(internal.recipient_state('00000000-0000-4000-8000-0000000000aa', (pg_temp.contact('ING-C7')).id), null, 'R1 C7: no event for this send → null');
select is(internal.recipient_state('00000000-0000-4000-8000-0000000000ac', (pg_temp.contact('ING-C2')).id), null, 'R1 scoped by send: C2 has nothing on send SC');

-- ============================================================================
-- C: complete_sends — reporting → complete 24 h after dispatched_at
-- ============================================================================
select is(internal.complete_sends(), 1, 'C1 complete_sends() flips exactly one send (SC: reporting, dispatched 25 h ago)');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-0000000000ac'), 'complete', 'C1 SC is complete');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-0000000000aa'), 'reporting', 'C2 SA (dispatched 60 min ago) stays reporting');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-0000000000ad'), 'partial', 'C2 SD (partial, 25 h) is left alone');
select is(internal.complete_sends(), 0, 'C3 a second call flips nothing (compare-and-set)');

-- ============================================================================
-- P: poll_log / v_last_sync / last_poll_status
-- ============================================================================
select is((select count(*) from public.last_poll_status()), (select least(count(*), 1) from internal.poll_log), 'P1 last_poll_status: one row when a run exists, none otherwise');
-- Dated AHEAD of the clock: last_poll_status() orders by requested_at, and the live pg_cron jobs from 0013 (poll-events-5m
-- fires at every */5 tick and commits a real `failed / missing_secret` row while the Vault is empty) would otherwise be
-- newer than a past-dated fixture whenever the suite runs across a tick (seen on CI, Story 7.2). Rolled back with the rest.
insert into internal.poll_log (status, requested_at) values ('ok', now() + interval '50 min');
insert into internal.poll_log (status, requested_at, finished_at, batches, pages, inserted, duplicates, error) values ('deferred', now() + interval '59 min', now(), 1, 2, 3, 4, 'retry_after');
select is((select row(status, finished_at)::text from public.last_poll_status()), row('deferred', now())::text, 'P2 last_poll_status returns the newest row''s status + finished_at only');
select is((select count(*) from public.last_poll_status() l), 1::bigint, 'P2 ... exactly one row');
select is((select status::text from internal.poll_log where id = (select max(id) from internal.poll_log)), 'deferred', 'P3 poll_log stores the deferred status');
update public.provider_batches set last_ok_at = now() - interval '5 min' where send_id = '00000000-0000-4000-8000-0000000000aa';
update public.provider_batches set last_ok_at = now() - interval '2 min' where send_id = '00000000-0000-4000-8000-0000000000ac';
select is((select last_ok_at from public.v_last_sync where brand_id = pg_temp.brand('INGEST-A')), now() - interval '2 min', 'P4 v_last_sync = max(last_ok_at) per brand');
select is((select count(*) from public.v_last_sync where brand_id = pg_temp.brand('INGEST-B')), 0::bigint, 'P4 a brand with no batch has no row');

-- ============================================================================
-- V: v_campaign_performance portal rows (after the poison page: 22 provider events on SA)
-- ============================================================================
select is((select count(*) from public.v_campaign_performance where campaign_id = '00000000-0000-4000-8000-0000000000ca'), 2::bigint, 'V1 campaign KA: the reported row + one portal row for SA');
select is((select row(source, send_id, sent, delivered, bounced, opens, clicks, unsubscribes, delivered_rate, bounce_rate, open_rate, click_rate, unsubscribe_rate, dispatched_at)::text
           from public.v_campaign_performance where campaign_id = '00000000-0000-4000-8000-0000000000ca' and source = 'portal'),
  row('portal', '00000000-0000-4000-8000-0000000000aa'::uuid, 6, 7, 3, 4, 1, 1::bigint, 116.67::numeric, 50.00::numeric, 66.67::numeric, 16.67::numeric, 16.67::numeric, (select dispatched_at from public.sends where id = '00000000-0000-4000-8000-0000000000aa'))::text,
  'V2 SA: sent = accepted_count 6; delivered 7 distinct (C1 C2 C3 C4 C6 + 2 key-less by id — C2 delivered twice counts once), bounced 3 (C2 C5 C6), opens 4 total, clicks 1, unsubscribes 1; rates over sent, > 100 never clamped');
select is((select row(source, send_id, sent, delivered, unsubscribes, unsubscribe_rate, dispatched_at)::text from public.v_campaign_performance where campaign_id = '00000000-0000-4000-8000-0000000000ca' and source = 'reported'),
  row('reported', null::uuid, null::int, null::int, null::bigint, null::numeric, null::timestamptz)::text, 'V3 the reported row is unchanged: send_id / dispatched_at null');
select is((select row(sent, delivered, bounced, opens, clicks, unsubscribes, delivered_rate)::text from public.v_campaign_performance where send_id = '00000000-0000-4000-8000-0000000000ad'),
  row(0, 0, 0, 0, 0, 0::bigint, null::numeric)::text, 'V4 a portal send with no events: zeros, rates null (sent 0 → nullif)');
insert into public.sends (brand_id, campaign_id, status, source, batch_key, recipient_count, confirmed_at, dispatched_at)
values (pg_temp.brand('INGEST-A'), '00000000-0000-4000-8000-0000000000cd', 'complete', 'seed_send_log', 'ING-BATCH-SEED', 9800, now() - interval '30 days', now() - interval '30 days');
select is((select count(*) from public.v_campaign_performance where campaign_id = '00000000-0000-4000-8000-0000000000cd'), 2::bigint, 'V5 a seed send-log send gets no row (reported + SD only)');
insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_at)
values ('00000000-0000-4000-8000-0000000000ae', pg_temp.brand('INGEST-B'), '00000000-0000-4000-8000-0000000000cb', 'confirmed', 'portal', 1, now());
select is((select count(*) from public.v_campaign_performance where send_id = '00000000-0000-4000-8000-0000000000ae'), 0::bigint, 'V5 a confirmed (not yet dispatched) portal send gets no row');
select is((select count(*) from public.v_campaign_performance where source not in ('reported', 'portal')), 0::bigint, 'V6 source is reported or portal');

-- as a signed-in analyst of brand A the portal row is visible and brand B's is not (security_invoker)
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-4000-8000-00000000ee01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-ingest-analyst-a@tenancy.test', '{}', '{}', now(), now());
insert into public.app_users (email, brand_id, role, auth_user_id)
values ('fixture-ingest-analyst-a@tenancy.test', pg_temp.brand('INGEST-A'), 'analyst', '00000000-0000-4000-8000-00000000ee01');
select set_config('ingest.brand_a', pg_temp.brand('INGEST-A')::text, true);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-00000000ee01', 'role', 'authenticated')::text, true);
select is((select count(*) from public.v_campaign_performance where source = 'portal'), 3::bigint, 'V7 the analyst sees brand A''s three portal rows (SA, SC, SD) and none of brand B''s');
select is((select string_agg(brand_id::text, ',') from public.v_last_sync), current_setting('ingest.brand_a'), 'V7 v_last_sync: own brand only');
select is((select status from public.last_poll_status()), 'deferred', 'V7 last_poll_status works as authenticated');
select throws_ok($$ select * from internal.poll_log $$, '42501', null, 'V8 authenticated cannot read internal.poll_log');
select throws_ok($$ select internal.complete_sends() $$, '42501', null, 'V8 authenticated cannot call complete_sends');
select throws_ok($$ select public.dispatch_mark_partial('00000000-0000-4000-8000-0000000000aa', 'x') $$, '42501', null, 'V8 authenticated cannot call dispatch_mark_partial');
reset role;

-- ============================================================================
-- D: Epic-4 carry-ins — dispatch_mark_partial, the sweep's reasons + ceiling, the batch_id collision
-- ============================================================================
insert into public.campaigns (id, brand_id, external_id, name, channel, sent_at)
select ('00000000-0000-4000-8000-00000000d10' || i)::uuid, pg_temp.brand('INGEST-B'), 'ING-D' || i, 'Dispatch ' || i, 'email', now() from generate_series(1, 7) i;
insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, dispatched_at, dispatch_attempts, dispatch_lease_until, batch_id) values
  -- d1 dispatched, 1 attempt, lease live                          → mark_partial CAS hits
  ('00000000-0000-4000-8000-00000000e001', pg_temp.brand('INGEST-B'), '00000000-0000-4000-8000-00000000d101', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '3 min', now() - interval '2 min', 1, now() + interval '8 min', null),
  -- d2 dispatched 25 h ago, lease expired, 1 attempt, no batch    → sweep: dispatch_expired
  ('00000000-0000-4000-8000-00000000e002', pg_temp.brand('INGEST-B'), '00000000-0000-4000-8000-00000000d102', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '26 hours', now() - interval '25 hours', 1, now() - interval '24 hours', null),
  -- d3 confirmed 25 h ago, never leased                           → sweep: dispatch_expired (never POSTed a day later)
  ('00000000-0000-4000-8000-00000000e003', pg_temp.brand('INGEST-B'), '00000000-0000-4000-8000-00000000d103', 'confirmed',  'portal', 1, 'o@x.test', now() - interval '25 hours', null, 0, null, null),
  -- d4 dispatched 40 min ago, 3 attempts, lease expired           → sweep: dispatch_outcome_unknown_after_3_attempts
  ('00000000-0000-4000-8000-00000000e004', pg_temp.brand('INGEST-B'), '00000000-0000-4000-8000-00000000d104', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '40 min', now() - interval '39 min', 3, now() - interval '1 min', null),
  -- d5 dispatched 25 h ago but the lease is LIVE                  → untouched (someone is POSTing)
  ('00000000-0000-4000-8000-00000000e005', pg_temp.brand('INGEST-B'), '00000000-0000-4000-8000-00000000d105', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '26 hours', now() - interval '25 hours', 2, now() + interval '5 min', null),
  -- d6 / d7 for the collision: d6 records batch DUP first, d7 dispatched
  ('00000000-0000-4000-8000-00000000e006', pg_temp.brand('INGEST-B'), '00000000-0000-4000-8000-00000000d106', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '3 min', now() - interval '2 min', 1, now() + interval '8 min', null),
  ('00000000-0000-4000-8000-00000000e007', pg_temp.brand('INGEST-B'), '00000000-0000-4000-8000-00000000d107', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '3 min', now() - interval '2 min', 1, now() + interval '8 min', null);
insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
select s, pg_temp.brand('INGEST-B'), (pg_temp.contact('ING-CB1')).id, 'ING-CB1', 'ing-cb1@ingest.test'
from unnest(array['00000000-0000-4000-8000-00000000e006', '00000000-0000-4000-8000-00000000e007']::uuid[]) s;

select is((select count(*) from public.dispatch_mark_partial('00000000-0000-4000-8000-00000000e001', 'provider_503_outcome_unknown')), 1::bigint, 'D1 dispatch_mark_partial: dispatched, no batch_id → one row');
select is((select row(status::text, failure_reason, accepted_count, provider_responded_at)::text from public.sends where id = '00000000-0000-4000-8000-00000000e001'),
  row('partial', 'provider_503_outcome_unknown', null::int, null::timestamptz)::text, 'D1 ... partial with the reason; accepted_count / provider_responded_at stay null (nothing fabricated)');
select is((select count(*) from public.dispatch_mark_partial('00000000-0000-4000-8000-00000000e001', 'again')), 0::bigint, 'D2 CAS: a partial send → zero rows');
select is((select failure_reason from public.sends where id = '00000000-0000-4000-8000-00000000e001'), 'provider_503_outcome_unknown', 'D2 ... reason unchanged');
select is((select count(*) from public.dispatch_mark_partial('00000000-0000-4000-8000-0000000000aa', 'x')), 0::bigint, 'D2 CAS: a send with a batch_id (reporting) → zero rows');
select is((select count(*) from public.dispatch_mark_partial('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e', 'x')), 0::bigint, 'D2 CAS: unknown send → zero rows');
select is((select length(failure_reason) from public.dispatch_mark_partial('00000000-0000-4000-8000-00000000e004', repeat('r', 600))), 500, 'D3 reason cut to 500 chars');
update public.sends set status = 'dispatched', failure_reason = null where id = '00000000-0000-4000-8000-00000000e004';   -- restore d4 for the sweep

delete from vault.secrets where name in ('functions_url', 'cron_secret');   -- this transaction only: step (b) skipped, (a)/(a2) run
select lives_ok($$ select internal.dispatch_sweep() $$, 'D4 the sweep runs');
select results_eq(
  $$ select id::text, status::text, failure_reason, dispatch_attempts from public.sends where brand_id = (select id from public.brands where code = 'INGEST-B') and id::text like '00000000-0000-4000-8000-00000000e00%' order by id $$,
  $$ values ('00000000-0000-4000-8000-00000000e001', 'partial', 'provider_503_outcome_unknown', 1),
            ('00000000-0000-4000-8000-00000000e002', 'partial', 'dispatch_expired', 1),
            ('00000000-0000-4000-8000-00000000e003', 'partial', 'dispatch_expired', 0),
            ('00000000-0000-4000-8000-00000000e004', 'partial', 'dispatch_outcome_unknown_after_3_attempts', 3),
            ('00000000-0000-4000-8000-00000000e005', 'dispatched', null, 2),
            ('00000000-0000-4000-8000-00000000e006', 'dispatched', null, 1),
            ('00000000-0000-4000-8000-00000000e007', 'dispatched', null, 1) $$,
  'D5 the sweep: d2 / d3 expired (24 h ceiling, confirmed_at when never leased), d4 capped with its reason, d5 (live lease) and the young sends untouched');
select ok((select bool_and(provider_responded_at is null and batch_id is null) from public.sends where id in ('00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000e003', '00000000-0000-4000-8000-00000000e004')), 'D5 ... nothing invented: batch_id / provider_responded_at null');

-- the batch_id collision inside dispatch_record_result
select is((select status::text from public.dispatch_record_result('00000000-0000-4000-8000-00000000e006', 'DUP', array['ING-CB1'], 0)), 'reporting', 'D6 d6 records batch DUP → reporting');
select is((select row(status::text, failure_reason, batch_id, accepted_count)::text from public.dispatch_record_result('00000000-0000-4000-8000-00000000e007', 'DUP', array['ING-CB1'], 0)),
  row('failed', 'duplicate_batch_id: DUP', null::text, null::int)::text, 'D7 d7 answers the SAME batch_id → failed / duplicate_batch_id, no rolled-back 2xx, batch_id stays null');
select is((select count(*) from public.provider_batches where batch_id = 'DUP'), 1::bigint, 'D7 ... one provider_batches row (d6''s)');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000e007'), 'failed', 'D7 ... persisted');
select is((select count(*) from public.dispatch_record_result('00000000-0000-4000-8000-00000000e007', 'DUP-2', array['ING-CB1'], 0)), 0::bigint, 'D7 ... and a later 2xx changes nothing (CAS from dispatched only)');
select lives_ok($$ insert into public.sends (brand_id, campaign_id, status, source, recipient_count) values ((select id from public.brands where code = 'INGEST-B'), '00000000-0000-4000-8000-00000000d107', 'pending', 'portal', 1) $$,
  'D8 a failed send frees its campaign (partial unique index)');

-- ============================================================================
-- M: Epic-2 carry-ins (S19)
-- ============================================================================
select is(internal.normalize_int('١٢'), null, 'M1 normalize_int: Arabic-Indic digits → null (no cast, no exception)');
select is(internal.normalize_int('12'), 12, 'M1 normalize_int: ASCII digits still parse');
select is(internal.normalize_spend('١,٥'), null, 'M1 normalize_spend: Unicode digits → null');
select is(internal.normalize_spend('221,09'), 221.09, 'M1 normalize_spend: 221,09 still parses');

-- staging helpers (Story 2.2 layout)
create function pg_temp.kstage(p_run uuid, p_row int, p_cols text[], p_brand text) returns void language sql as $$
  insert into staging.stage_campaigns (run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank)
  values (p_run, 'm-campaigns.csv', p_brand, p_row, coalesce(array_length(p_cols, 1), 0), p_cols, false, '2026-08-01', 10)
$$;
create function pg_temp.estage(p_run uuid, p_row int, p_cols text[], p_brand text) returns void language sql as $$
  insert into staging.stage_events (run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank)
  values (p_run, 'm-events.csv', p_brand, p_row, coalesce(array_length(p_cols, 1), 0), p_cols, false, '2026-08-01', 10)
$$;
create function pg_temp.reasons(p_run uuid, p_sev public.issue_severity, p_row int) returns text language sql stable as $$
  select string_agg(reason, ',' order by reason) from public.import_issues where run_id = p_run and severity = p_sev and row_no is not distinct from p_row
$$;

-- self-pointer + clock_timestamp
select pg_temp.kstage('00000000-0000-4000-8000-00000000f001', 2, array['SELF', 'self', 'email', 'KE', '1', '1', '0', '0', '0', '1', '2026-03-01T10:00:00Z', '', 'SELF'], 'INGEST-B');
select pg_temp.kstage('00000000-0000-4000-8000-00000000f001', 3, array['CHILD', 'child', 'email', 'KE', '1', '1', '0', '0', '0', '1', '2026-03-01T10:00:00Z', '', 'SELF'], 'INGEST-B');
select lives_ok($$ select internal.import_campaigns('00000000-0000-4000-8000-00000000f001') $$, 'M2 a campaigns file with a self-pointer imports');
select is((select parent_campaign_id from public.campaigns where brand_id = pg_temp.brand('INGEST-B') and external_id = 'SELF'), null::uuid, 'M2 SELF → SELF: parent_campaign_id null (never itself)');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000f001', 'warn', 2), 'parent_unknown', 'M2 ... warned parent_unknown');
select is((select parent_campaign_id from public.campaigns where brand_id = pg_temp.brand('INGEST-B') and external_id = 'CHILD'),
  (select id from public.campaigns where brand_id = pg_temp.brand('INGEST-B') and external_id = 'SELF'), 'M2 CHILD → SELF resolves normally');
select cmp_ok((select finished_at from public.import_runs where id = '00000000-0000-4000-8000-00000000f001'), '>', (select started_at from public.import_runs where id = '00000000-0000-4000-8000-00000000f001'),
  'M3 finished_at = clock_timestamp() > started_at (was always equal: both now())');

-- followed event with an id that collides with the target brand's native event
insert into public.contacts (brand_id, external_id, full_name, status, as_of, file_rank, routed_from)
values (pg_temp.brand('INGEST-B'), 'ING-CR', 'routed', 'active', '2026-08-01', 9, 'INGEST-A');   -- routed A → B
select pg_temp.estage('00000000-0000-4000-8000-00000000f002', 2, array['EV-1', 'ING-CB1', 'ING-KB', 'open', 'email', '2026-03-02T08:00:00Z'], 'INGEST-B');   -- B's native EV-1
select lives_ok($$ select internal.import_events('00000000-0000-4000-8000-00000000f002') $$, 'M4 brand B loads its native EV-1');
select pg_temp.estage('00000000-0000-4000-8000-00000000f003', 2, array['EV-1', 'ING-CR', 'ING-KA', 'bounce', 'email', '2026-03-03T08:00:00Z'], 'INGEST-A');   -- follows CR into B, same id
select pg_temp.estage('00000000-0000-4000-8000-00000000f003', 3, array['EV-2', 'ING-C1', '', 'open', 'email', '2026-03-03T08:00:00Z'], 'INGEST-A');          -- blank campaign pointer
select pg_temp.estage('00000000-0000-4000-8000-00000000f003', 4, array['EV-3', 'ING-C1', 'ING-NOPE', 'open', 'email', '2026-03-03T08:00:00Z'], 'INGEST-A');  -- unknown pointer
create temp table t_m as select internal.import_events('00000000-0000-4000-8000-00000000f003') as s;
select is((select row(s->'inserted', s->'routed', s->'already_present')::text from t_m), row('3'::jsonb, '1'::jsonb, '0'::jsonb)::text, 'M5 all three insert; the followed one is routed, not already_present');
select is((select row(brand_id, event_id, type::text, contact_id, campaign_id)::text from public.events where source = 'seed' and event_id = 'INGEST-A:EV-1'),
  row(pg_temp.brand('INGEST-B'), 'INGEST-A:EV-1', 'bounced', (pg_temp.contact('ING-CR')).id, null::uuid)::text,
  'M5 the followed event is stored under INGEST-A:EV-1 in brand B with the routed contact, no cross-brand campaign');
select is((select row(brand_id, type::text)::text from public.events where source = 'seed' and event_id = 'EV-1' and brand_id = pg_temp.brand('INGEST-B')),
  row(pg_temp.brand('INGEST-B'), 'opened')::text, 'M5 brand B''s own EV-1 is intact (no collision, nothing dropped)');
select is((select row(suppressed_at, suppressed_reason)::text from pg_temp.contact('ING-CR')), row('2026-03-03 08:00:00+00'::timestamptz, 'bounced')::text, 'M5 ... and the followed bounce suppressed the routed contact (trigger fires on seed inserts too)');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000f003', 'warn', 2), 'campaign_not_followed,event_follows_routed_contact', 'M6 followed row with a pointer: event_follows_routed_contact + campaign_not_followed (not unknown_campaign)');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000f003', 'warn', 3), null, 'M6 a BLANK campaign pointer is not warned');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000f003', 'warn', 4), 'unknown_campaign', 'M6 a non-blank unresolved pointer → unknown_campaign');
select is((select raw from public.events where source = 'seed' and event_id = 'INGEST-A:EV-1'), jsonb_build_object('cols', array['EV-1', 'ING-CR', 'ING-KA', 'bounce', 'email', '2026-03-03T08:00:00Z']), 'M7 raw keeps the file''s own id');
create temp table t_m2 as select internal.import_events('00000000-0000-4000-8000-00000000f003') as s;
select is((select row(s->'inserted', s->'already_present')::text from t_m2), row('0'::jsonb, '3'::jsonb)::text, 'M8 re-run: inserted 0, already_present 3 (idempotent under the new id)');

select is(current_user::text, 'postgres', 'Z1 role restored before finish');
select * from finish();
rollback;
