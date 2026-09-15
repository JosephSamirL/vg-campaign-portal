-- 0015_ingest_fixes.test.sql — the Epic 6 review follow-ups (Stories 6.2 / 6.3; D-4, D-5, D-8, S10, S11).
--
-- Synthetic brand INGFIX (fresh code — the local seed load is never touched), one transaction, rolled back.
--   T  shape: the two send_recipients indexes, bounded_event_id, backfill_suppression, last_poll_status's third column,
--      nothing in internal is security definer, search_path pinned.
--   P  performance: 35,000 recipients × 5,000 events ingest in < 5 s (generated inside the transaction; clock_timestamp).
--   L  long ids: a 5 kB event_id is stored as its sha256 hex (raw verbatim), dedupes on replay, last_event_id bounded.
--   B  the batch must belong to the send → invalid_input.
--   R  recipient_state: unsubscribed > complained > bounced > delivered, same moment, any arrival order.
--   V  v_campaign_performance: a portal row only for sends with a batch_id; per-contact counts over contacts only.
--   S  dispatch_sweep: a never-leased confirmed send expires as failed / dispatch_expired (partial for a leased one).
--   K  backfill_suppression with the trigger disabled: the trigger's rule, set-based, idempotent.
--   Q  request_poll: an exception from net.http_post leaves the row failed / http_post: …, nothing queued.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ============================================================================
-- T: shape
-- ============================================================================
select has_index('public', 'send_recipients', 'idx_send_recipients_send_id_external_id', 'T1 send_recipients (send_id, external_id) index');
select has_index('public', 'send_recipients', 'idx_send_recipients_send_id_lower_address', 'T1 send_recipients (send_id, lower(address)) index');
select ok((select pg_get_indexdef(indexrelid) ~ 'lower\(address\)' from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'idx_send_recipients_send_id_lower_address'), 'T1 ... the address index is on lower(address)');
select has_function('internal', 'bounded_event_id', array['text'], 'T2 internal.bounded_event_id(text) exists');
select has_function('internal', 'backfill_suppression', array[]::text[], 'T2 internal.backfill_suppression() exists');
select function_returns('internal', 'backfill_suppression', array[]::text[], 'integer', 'T2 ... returns int');
select has_function('public', 'last_poll_status', array[]::text[], 'T3 public.last_poll_status() exists');
select is((select proargnames from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'last_poll_status'),
  array['status', 'finished_at', 'requested_at'], 'T3 ... returns (status, finished_at, requested_at) — requested_at is new');
select ok(has_function_privilege('authenticated', 'public.last_poll_status()', 'execute')
          and not has_function_privilege('anon', 'public.last_poll_status()', 'execute')
          and not has_function_privilege('public', 'public.last_poll_status()', 'execute'), 'T3 ... still authenticated only');
select ok((select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'last_poll_status'), 'T3 ... still security definer (over the unexposed internal.poll_log)');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.prosecdef), 'T4 nothing in internal is security definer');
select ok(bool_and(exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')), 'T4 every 0015 function pins search_path = ''''')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'internal' and p.proname in ('bounded_event_id', 'backfill_suppression', 'ingest_provider_events', 'recipient_state', 'dispatch_sweep', 'request_poll'))
   or (n.nspname = 'public' and p.proname = 'last_poll_status');
select is(internal.bounded_event_id('short'), 'short', 'T5 bounded_event_id keeps a short id verbatim');
select is(internal.bounded_event_id(repeat('x', 200)), repeat('x', 200), 'T5 ... 200 chars exactly is kept');
select is(internal.bounded_event_id(repeat('x', 201)), encode(sha256(convert_to(repeat('x', 201), 'UTF8')), 'hex'), 'T5 ... 201 chars → sha256 hex');
select is(length(internal.bounded_event_id(repeat('x', 5000))), 64, 'T5 ... a 5 kB id → 64 chars');
select is(internal.bounded_event_id(null), null, 'T5 ... null stays null');

-- ============================================================================
-- fixtures
-- ============================================================================
create function pg_temp.brand() returns uuid language sql stable as $$ select id from public.brands where code = 'INGFIX' $$;
insert into public.brands (code, name) values ('INGFIX', 'Ingest Fixes Test Brand');
insert into public.campaigns (id, brand_id, external_id, name, channel, sent_at) values
  ('00000000-0000-4000-8000-0000000015c1', pg_temp.brand(), 'FIX-K1', 'Fix 1', 'email', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000015c2', pg_temp.brand(), 'FIX-K2', 'Fix 2', 'email', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000015c3', pg_temp.brand(), 'FIX-K3', 'Fix 3', 'email', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000015c4', pg_temp.brand(), 'FIX-K4', 'Fix 4', 'email', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000015c5', pg_temp.brand(), 'FIX-K5', 'Fix 5', 'email', now() - interval '2 days');

-- ============================================================================
-- P: performance — 35,000 recipients, one page of 5,000 events, < 5 s (the review measured 14 s for 1,000 × 35,000
--    on the per-element scan; Kilele's KIL-0016 has 35,547 recipients and the provider ignores page_size)
-- ============================================================================
insert into public.contacts (brand_id, external_id, email, full_name, country, consent_marketing, status, signup_at)
select pg_temp.brand(), 'FIX-C' || i, 'fix-c' || i || '@ingfix.test', 'Fix ' || i, 'ZZ', true, 'active', now() from generate_series(1, 35000) i;
insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, dispatched_at, provider_responded_at, dispatch_attempts, batch_id, accepted_count, rejected_count) values
  ('00000000-0000-4000-8000-0000000015a1', pg_temp.brand(), '00000000-0000-4000-8000-0000000015c1', 'reporting', 'portal', 35000, 'o@x.test', now() - interval '3 min', now() - interval '2 min', now() - interval '2 min', 1, 'FIX-B1', 35000, 0);
insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
select '00000000-0000-4000-8000-0000000015a1', pg_temp.brand(), c.id, c.external_id, c.email from public.contacts c where c.brand_id = pg_temp.brand();
insert into public.provider_batches (send_id, brand_id, batch_id) values ('00000000-0000-4000-8000-0000000015a1', pg_temp.brand(), 'FIX-B1');
select is((select count(*) from public.send_recipients where send_id = '00000000-0000-4000-8000-0000000015a1'), 35000::bigint, 'P0 35,000 recipients on the send');

-- 5,000 events: every 7th keyed by the (upper-cased) address instead of the external_id, every 10th a bounce, 50 foreign
create temp table t_big as
select jsonb_agg(jsonb_build_object(
         'event_id', 'evt-' || i,
         'recipient_id', case when i % 100 = 0 then 'STRANGER-' || i
                              when i % 7 = 0 then upper('fix-c' || i || '@ingfix.test')
                              else 'FIX-C' || i end,
         'type', case when i % 10 = 0 then 'bounced' else 'delivered' end,
         'occurred_at', '2026-09-15T10:00:00Z', 'brand_code', 'account') order by i) as ev
from generate_series(1, 5000) i;
create temp table t_clock (t0 timestamptz);
insert into t_clock select clock_timestamp();
create temp table t_big_result as select * from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a1', 'FIX-B1', (select ev from t_big));
create temp table t_elapsed as select clock_timestamp() - (select t0 from t_clock) as d;
select cmp_ok((select d from t_elapsed), '<', interval '5 seconds', 'P1 5,000 events × 35,000 recipients ingest in < 5 s (was O(events × recipients))');
select is((select row(inserted, duplicates, foreign_recipient, unknown_type)::text from t_big_result), row(4950, 0, 50, 0)::text, 'P2 4,950 inserted, 50 strangers dropped, no duplicates');
select is((select count(*) from public.events e where e.send_id = '00000000-0000-4000-8000-0000000015a1' and e.contact_id is not null), 4950::bigint, 'P2 ... every stored event resolved to a recipient (external_id or case-insensitive address)');
select is((select count(*) from public.contacts c where c.brand_id = pg_temp.brand() and c.suppressed_at is not null), (select count(*) from public.events e where e.send_id = '00000000-0000-4000-8000-0000000015a1' and e.type = 'bounced'), 'P2 ... every bounce suppressed its contact');
select is((select contact_id from public.events where event_id = 'FIX-B1:evt-7'), (select id from public.contacts where brand_id = pg_temp.brand() and external_id = 'FIX-C7'), 'P3 an upper-cased address resolves through lower(address)');
-- a replay of the same page: 0 inserted, all duplicates — also inside the budget
insert into t_clock select clock_timestamp();
create temp table t_big_replay as select * from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a1', 'FIX-B1', (select ev from t_big));
select cmp_ok(clock_timestamp() - (select max(t0) from t_clock), '<', interval '5 seconds', 'P4 the replay is inside the budget too');
select is((select row(inserted, duplicates, foreign_recipient)::text from t_big_replay), row(0, 4950, 50)::text, 'P4 ... 0 inserted, 4,950 duplicates, 50 foreign');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname like 'pg_temp%' and c.relname in ('_ing', '_rk')), 0::bigint, 'P5 the temp tables are dropped after the call');

-- ============================================================================
-- L: a 5 kB event_id
-- ============================================================================
create temp table t_long as select repeat('L', 5000) as id;
select lives_ok($$ select * from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a1', 'FIX-B1',
  jsonb_build_array(jsonb_build_object('event_id', (select id from t_long), 'recipient_id', 'FIX-C1', 'type', 'opened', 'occurred_at', '2026-09-15T11:00:00Z'))) $$,
  'L1 a 5 kB event_id inserts without error (the btree row limit is never hit)');
select is((select count(*) from public.events where send_id = '00000000-0000-4000-8000-0000000015a1' and event_id = 'FIX-B1:' || encode(sha256(convert_to((select id from t_long), 'UTF8')), 'hex')), 1::bigint, 'L1 ... stored as <batch_id>:<sha256 hex>');
select is((select raw->>'event_id' from public.events where send_id = '00000000-0000-4000-8000-0000000015a1' and event_id = 'FIX-B1:' || encode(sha256(convert_to((select id from t_long), 'UTF8')), 'hex')), (select id from t_long), 'L1 ... the raw id is kept verbatim in raw');
select is((select row(inserted, duplicates, last_event_id)::text from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a1', 'FIX-B1',
  jsonb_build_array(jsonb_build_object('event_id', (select id from t_long), 'recipient_id', 'FIX-C1', 'type', 'opened', 'occurred_at', '2026-09-15T11:00:00Z')))),
  row(0, 1, encode(sha256(convert_to((select id from t_long), 'UTF8')), 'hex'))::text, 'L2 a replay of the long id dedupes; last_event_id is the bounded id');
select is((select row(inserted, last_event_id)::text from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a1', 'FIX-B1',
  jsonb_build_array(jsonb_build_object('event_id', repeat('m', 200), 'recipient_id', 'FIX-C1', 'type', 'opened')))),
  row(1, repeat('m', 200))::text, 'L3 a 200-char id is stored verbatim (the boundary)');

-- ============================================================================
-- B: the batch must belong to the send
-- ============================================================================
insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, dispatched_at, provider_responded_at, dispatch_attempts, batch_id, accepted_count, rejected_count) values
  ('00000000-0000-4000-8000-0000000015a2', pg_temp.brand(), '00000000-0000-4000-8000-0000000015c2', 'reporting', 'portal', 1, 'o@x.test', now() - interval '3 min', now() - interval '2 min', now() - interval '2 min', 1, 'FIX-B2', 1, 0);
insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
select '00000000-0000-4000-8000-0000000015a2', pg_temp.brand(), c.id, c.external_id, c.email from public.contacts c where c.brand_id = pg_temp.brand() and c.external_id = 'FIX-C2';
insert into public.provider_batches (send_id, brand_id, batch_id) values ('00000000-0000-4000-8000-0000000015a2', pg_temp.brand(), 'FIX-B2');
select throws_ok($$ select * from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a2', 'FIX-B1', '[{"event_id": "x", "recipient_id": "FIX-C2", "type": "delivered"}]'::jsonb) $$,
  'P0001', 'invalid_input', 'B1 batch FIX-B1 belongs to another send → invalid_input');
select throws_ok($$ select * from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a2', 'FIX-NOPE', '[]'::jsonb) $$,
  'P0001', 'invalid_input', 'B1 an unknown batch → invalid_input');
select is((select count(*) from public.events where send_id = '00000000-0000-4000-8000-0000000015a2'), 0::bigint, 'B1 ... nothing was filed under the send');
select is((select inserted from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a2', 'FIX-B2', '[{"event_id": "x", "recipient_id": "FIX-C2", "type": "delivered"}]'::jsonb)), 1, 'B2 the send''s own batch ingests');

-- ============================================================================
-- R: recipient_state — one rank per terminal type, same moment, any arrival order
-- ============================================================================
insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, dispatched_at, provider_responded_at, dispatch_attempts, batch_id, accepted_count, rejected_count) values
  ('00000000-0000-4000-8000-0000000015a3', pg_temp.brand(), '00000000-0000-4000-8000-0000000015c3', 'reporting', 'portal', 4, 'o@x.test', now() - interval '3 min', now() - interval '2 min', now() - interval '2 min', 1, 'FIX-B3', 4, 0);
insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
select '00000000-0000-4000-8000-0000000015a3', pg_temp.brand(), c.id, c.external_id, c.email from public.contacts c where c.brand_id = pg_temp.brand() and c.external_id in ('FIX-C11', 'FIX-C12', 'FIX-C13', 'FIX-C14');
insert into public.provider_batches (send_id, brand_id, batch_id) values ('00000000-0000-4000-8000-0000000015a3', pg_temp.brand(), 'FIX-B3');
create function pg_temp.state(p_ext text) returns text language sql stable as $$
  select internal.recipient_state('00000000-0000-4000-8000-0000000015a3', (select id from public.contacts where brand_id = pg_temp.brand() and external_id = p_ext))
$$;
-- C11: complained then unsubscribed, same moment; C12: unsubscribed then complained (the reverse arrival); C13: bounced then complained; C14: delivered only
select is((select inserted from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a3', 'FIX-B3', '[
  {"event_id": "r1", "recipient_id": "FIX-C11", "type": "complained",   "occurred_at": "2026-09-15T10:00:00Z"},
  {"event_id": "r2", "recipient_id": "FIX-C11", "type": "unsubscribed", "occurred_at": "2026-09-15T10:00:00Z"},
  {"event_id": "r3", "recipient_id": "FIX-C12", "type": "unsubscribed", "occurred_at": "2026-09-15T10:00:00Z"},
  {"event_id": "r4", "recipient_id": "FIX-C12", "type": "complained",   "occurred_at": "2026-09-15T10:00:00Z"},
  {"event_id": "r5", "recipient_id": "FIX-C13", "type": "bounced",      "occurred_at": "2026-09-15T10:00:00Z"},
  {"event_id": "r6", "recipient_id": "FIX-C13", "type": "complained",   "occurred_at": "2026-09-15T10:00:00Z"},
  {"event_id": "r7", "recipient_id": "FIX-C14", "type": "delivered",    "occurred_at": "2026-09-15T10:00:00Z"}
]'::jsonb)), 7, 'R0 seven events');
select is(pg_temp.state('FIX-C11'), 'unsubscribed', 'R1 complained then unsubscribed at one moment → unsubscribed');
select is(pg_temp.state('FIX-C12'), 'unsubscribed', 'R1 unsubscribed then complained at one moment → unsubscribed (arrival order never decides)');
select is(pg_temp.state('FIX-C13'), 'complained', 'R1 bounced + complained → complained');
select is(pg_temp.state('FIX-C14'), 'delivered', 'R1 delivered only → delivered');
select ok((select prosrc ~ $r$when 'unsubscribed' then 1 when 'complained' then 2 when 'bounced' then 3 else 4$r$ from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'recipient_state'), 'R2 the rank is 1 / 2 / 3 / 4 — the trigger''s order');

-- ============================================================================
-- V: v_campaign_performance — portal rows only with a batch_id; per-contact counts over contacts only
-- ============================================================================
insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, dispatched_at, provider_responded_at, dispatch_attempts, batch_id, accepted_count, rejected_count, failure_reason) values
  -- a 4xx after the lease: dispatched, then failed — no batch_id, nothing to report on
  ('00000000-0000-4000-8000-0000000015a4', pg_temp.brand(), '00000000-0000-4000-8000-0000000015c4', 'failed', 'portal', 1, 'o@x.test', now() - interval '3 min', now() - interval '2 min', now() - interval '2 min', 1, null, null, null, 'provider_422: nope'),
  -- an unknown outcome: partial with no batch_id and no accepted_count
  ('00000000-0000-4000-8000-0000000015a5', pg_temp.brand(), '00000000-0000-4000-8000-0000000015c5', 'partial', 'portal', 1, 'o@x.test', now() - interval '3 min', now() - interval '2 min', null, 3, null, null, null, 'dispatch_outcome_unknown_after_3_attempts');
select is((select count(*) from public.v_campaign_performance where send_id in ('00000000-0000-4000-8000-0000000015a4', '00000000-0000-4000-8000-0000000015a5')), 0::bigint, 'V1 a failed dispatch and an unknown-outcome partial (no batch_id) get NO portal row');
select is((select count(*) from public.v_campaign_performance where campaign_id in ('00000000-0000-4000-8000-0000000015c4', '00000000-0000-4000-8000-0000000015c5')), 2::bigint, 'V1 ... their campaigns keep the reported row only');
select is((select count(*) from public.v_campaign_performance where send_id = '00000000-0000-4000-8000-0000000015a2'), 1::bigint, 'V1 a dispatched send with a batch_id has its row');
-- key-less events never count as recipients: a key-less delivered + a key-less bounced on FIX-B2 (sent = 1)
select is((select inserted from internal.ingest_provider_events('00000000-0000-4000-8000-0000000015a2', 'FIX-B2', '[
  {"event_id": "k1", "type": "delivered", "occurred_at": "2026-09-15T10:00:00Z"},
  {"event_id": "k2", "type": "delivered", "occurred_at": "2026-09-15T10:00:01Z"},
  {"event_id": "k3", "type": "bounced",   "occurred_at": "2026-09-15T10:00:02Z"},
  {"event_id": "k4", "type": "opened",    "occurred_at": "2026-09-15T10:00:03Z"},
  {"event_id": "k5", "recipient_id": "FIX-C2", "type": "opened", "occurred_at": "2026-09-15T10:00:04Z"}
]'::jsonb)), 5, 'V2 five more events on FIX-B2, four of them key-less');
select is((select row(sent, delivered, bounced, opens, clicks, unsubscribes, delivered_rate, bounce_rate, open_rate)::text from public.v_campaign_performance where send_id = '00000000-0000-4000-8000-0000000015a2'),
  row(1, 1, 0, 2, 0, 0::bigint, 100.00::numeric, 0.00::numeric, 200.00::numeric)::text,
  'V2 delivered 1 (C2 only — the two key-less deliveries do not count), bounced 0 (key-less), opens 2 (totals still count every event), delivered_rate 100 not 300');
select is((select count(*) from public.events where send_id = '00000000-0000-4000-8000-0000000015a2' and contact_id is null), 4::bigint, 'V2 ... the key-less events are still stored (amendment #6)');

-- ============================================================================
-- S: dispatch_sweep — never leased + expired → failed; leased + expired → partial
-- ============================================================================
insert into public.campaigns (id, brand_id, external_id, name, channel, sent_at)
select ('00000000-0000-4000-8000-00000000d15' || i)::uuid, pg_temp.brand(), 'FIX-D' || i, 'Fix dispatch ' || i, 'email', now() from generate_series(1, 4) i;
insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, dispatched_at, dispatch_attempts, dispatch_lease_until, batch_id) values
  -- s1 confirmed 25 h ago, never leased                        → failed / dispatch_expired (nothing was POSTed)
  ('00000000-0000-4000-8000-00000000f151', pg_temp.brand(), '00000000-0000-4000-8000-00000000d151', 'confirmed',  'portal', 1, 'o@x.test', now() - interval '25 hours', null, 0, null, null),
  -- s2 dispatched 25 h ago, lease expired, 1 attempt, no batch → partial / dispatch_expired (a POST may have gone out)
  ('00000000-0000-4000-8000-00000000f152', pg_temp.brand(), '00000000-0000-4000-8000-00000000d152', 'dispatched', 'portal', 1, 'o@x.test', now() - interval '26 hours', now() - interval '25 hours', 1, now() - interval '24 hours', null),
  -- s3 confirmed 23 h ago, never leased                        → untouched (inside the ceiling)
  ('00000000-0000-4000-8000-00000000f153', pg_temp.brand(), '00000000-0000-4000-8000-00000000d153', 'confirmed',  'portal', 1, 'o@x.test', now() - interval '23 hours', null, 0, null, null),
  -- s4 confirmed 25 h ago, leased once (attempts 1), lease expired, never dispatched_at → partial (a lease means a POST may have gone out)
  ('00000000-0000-4000-8000-00000000f154', pg_temp.brand(), '00000000-0000-4000-8000-00000000d154', 'confirmed',  'portal', 1, 'o@x.test', now() - interval '25 hours', null, 1, now() - interval '24 hours', null);
delete from vault.secrets where name in ('functions_url', 'cron_secret');   -- this transaction only: step (b) skipped
select lives_ok($$ select internal.dispatch_sweep() $$, 'S0 the sweep runs');
select results_eq(
  $$ select id::text, status::text, failure_reason, provider_responded_at is null from public.sends where id::text like '00000000-0000-4000-8000-00000000f15%' order by id $$,
  $$ values ('00000000-0000-4000-8000-00000000f151', 'failed', 'dispatch_expired', true),
            ('00000000-0000-4000-8000-00000000f152', 'partial', 'dispatch_expired', true),
            ('00000000-0000-4000-8000-00000000f153', 'confirmed', null::text, true),
            ('00000000-0000-4000-8000-00000000f154', 'partial', 'dispatch_expired', true) $$,
  'S1 never leased + 25 h → failed / dispatch_expired; leased + expired → partial / dispatch_expired; 23 h untouched; nothing fabricated');
select lives_ok($$ insert into public.sends (brand_id, campaign_id, status, source, recipient_count) values ((select id from public.brands where code = 'INGFIX'), '00000000-0000-4000-8000-00000000d151', 'pending', 'portal', 1) $$,
  'S2 the failed send frees its campaign (the owner can send again)');

-- ============================================================================
-- K: backfill_suppression with the trigger disabled — the trigger's rule, set-based, idempotent
-- ============================================================================
alter table public.events disable trigger trg_events_insert_suppress;
insert into public.events (brand_id, source, event_id, type, contact_id, occurred_at)
select pg_temp.brand(), 'seed', 'K-' || x.n, x.t::public.event_type, (select id from public.contacts where brand_id = pg_temp.brand() and external_id = x.c), x.at::timestamptz
from (values
  (1, 'FIX-C21', 'bounced',      '2026-09-10T12:00:00Z'),
  (2, 'FIX-C21', 'unsubscribed', '2026-09-11T12:00:00Z'),   -- later: the earlier bounce wins
  (3, 'FIX-C22', 'complained',   '2026-09-09T12:00:00Z'),
  (4, 'FIX-C22', 'unsubscribed', '2026-09-09T12:00:00Z'),   -- same moment: unsubscribed outranks complained
  (5, 'FIX-C23', 'delivered',    '2026-09-09T12:00:00Z'),   -- never suppresses
  (6, 'FIX-C24', 'bounced',      null)                      -- no timestamp: now()
) as x(n, c, t, at);
select is((select count(*) from public.contacts where brand_id = pg_temp.brand() and external_id in ('FIX-C21', 'FIX-C22', 'FIX-C23', 'FIX-C24') and suppressed_at is not null), 0::bigint, 'K0 with the trigger disabled nothing is suppressed yet');
select is(internal.backfill_suppression(), 3, 'K1 backfill_suppression() changes exactly the three contacts with a terminal event');
select results_eq(
  $$ select external_id, suppressed_at, suppressed_reason from public.contacts where brand_id = (select id from public.brands where code = 'INGFIX') and external_id in ('FIX-C21', 'FIX-C22', 'FIX-C23', 'FIX-C24') order by external_id $$,
  $$ values ('FIX-C21', '2026-09-10T12:00:00Z'::timestamptz, 'bounced'), ('FIX-C22', '2026-09-09T12:00:00Z'::timestamptz, 'unsubscribed'), ('FIX-C23', null::timestamptz, null::text), ('FIX-C24', now(), 'bounced') $$,
  'K1 ... earliest terminal event wins; same moment → unsubscribed > complained; delivered never; no timestamp → now()');
select is(internal.backfill_suppression(), 0, 'K2 a second call changes nothing (idempotent)');
-- a later suppression already present is never moved later; an earlier one is moved earlier — the trigger's rule
update public.contacts set suppressed_at = '2026-09-01T00:00:00Z', suppressed_reason = 'complained' where brand_id = pg_temp.brand() and external_id = 'FIX-C21';
update public.contacts set suppressed_at = '2026-09-20T00:00:00Z', suppressed_reason = 'bounced' where brand_id = pg_temp.brand() and external_id = 'FIX-C22';
select is(internal.backfill_suppression(), 1, 'K3 only the contact whose stored suppression is LATER than its earliest event changes');
select results_eq(
  $$ select external_id, suppressed_at, suppressed_reason from public.contacts where brand_id = (select id from public.brands where code = 'INGFIX') and external_id in ('FIX-C21', 'FIX-C22') order by external_id $$,
  $$ values ('FIX-C21', '2026-09-01T00:00:00Z'::timestamptz, 'complained'), ('FIX-C22', '2026-09-09T12:00:00Z'::timestamptz, 'unsubscribed') $$,
  'K3 ... C21 keeps its earlier suppression, C22 moves earlier');
alter table public.events enable trigger trg_events_insert_suppress;
select ok((select tgenabled = 'O' from pg_trigger where tgname = 'trg_events_insert_suppress'), 'K4 the trigger is enabled again');
select ok(not has_function_privilege('authenticated', 'internal.backfill_suppression()', 'execute')
          and not has_function_privilege('anon', 'internal.backfill_suppression()', 'execute')
          and not has_function_privilege('service_role', 'internal.backfill_suppression()', 'execute'), 'K5 backfill_suppression is executable by no exposed role');

-- ============================================================================
-- Q: request_poll — an exception from net.http_post leaves the row failed / http_post: …
-- ============================================================================
select vault.create_secret('http://127.0.0.1:1/functions/v1/', 'functions_url', 'test only, rolled back');
select vault.create_secret('test-cron-secret', 'cron_secret', 'test only, rolled back');
create temp table t_queue_before as select id from net.http_request_queue;
create temp table t_log_before as select id from internal.poll_log;
-- postgres may CREATE a trigger on pg_net's queue but not DROP it (supabase_admin owns it): the fault is switched off by a setting
create function pg_temp.boom() returns trigger language plpgsql as $$
begin
  if current_setting('ingfix.boom', true) = 'on' then raise exception 'queue on fire'; end if;
  return new;
end $$;
create trigger t_boom before insert on net.http_request_queue for each row execute function pg_temp.boom();
select set_config('ingfix.boom', 'on', true);
create temp table t_q as select internal.request_poll(48) as id;
select is((select count(*) from internal.poll_log where id not in (select id from t_log_before)), 1::bigint, 'Q1 the poll_log row survives the failing request');
select is((select row(status::text, error, finished_at is not null, net_request_id)::text from internal.poll_log where id = (select id from t_q)),
  row('failed', 'http_post: queue on fire', true, null::bigint)::text, 'Q1 ... failed / http_post: <error>, finished_at set, no request id');
select is((select count(*) from net.http_request_queue where id not in (select id from t_queue_before)), 0::bigint, 'Q1 ... nothing queued');
select is((select row(status, requested_at is not null, finished_at is not null)::text from public.last_poll_status()), row('failed', true, true)::text, 'Q2 last_poll_status() reports it — with requested_at (the third column)');
select set_config('ingfix.boom', 'off', true);
create temp table t_q2 as select internal.request_poll(48) as id;
select is((select status::text from internal.poll_log where id = (select id from t_q2)), 'requested', 'Q3 without the fault the request queues as before');

select * from finish();
rollback;
