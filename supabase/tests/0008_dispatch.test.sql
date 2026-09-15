-- 0008_dispatch.test.sql — dispatch through the provider, crash-safe (Story 4.3; D-7; Step-3 amendments #4, #6, #12; S20).
-- The four service-role-only functions behind the `dispatch-send` Edge Function: the lease (attempts cap + CAS from
-- confirmed|dispatched with a null batch_id), the one-row ordered recipient list, the 2xx outcome (accepted ∩
-- send_recipients, reporting|partial, provider_batches upsert, CAS) and the 4xx outcome (failed + reason, CAS).
--
-- Synthetic brand A with three contacts whose ids are deliberately NOT in external_id order (the canonical list is
-- ordered by contact_id), one confirmed send per campaign (the partial unique index allows one active send per
-- campaign), plus a `reporting` send and a `dispatched` send that already carries a batch_id — all under one
-- transaction, rolled back; the local seed data is never touched.

begin;
create extension if not exists pgtap with schema extensions;
select plan(107);

-- ============================================================================
-- F: the four functions — security INVOKER (they run as service_role, RLS bypassed by the role, not by secdef),
--    search_path pinned, the right volatility and return type.
-- ============================================================================
select has_function('public', 'dispatch_take_lease', array['uuid'], 'F1 public.dispatch_take_lease(uuid) exists');
select has_function('public', 'dispatch_recipients', array['uuid'], 'F1 public.dispatch_recipients(uuid) exists');
select has_function('public', 'dispatch_record_result', array['uuid', 'text', 'text[]', 'integer'], 'F1 public.dispatch_record_result(uuid, text, text[], int) exists');
select has_function('public', 'dispatch_mark_failed', array['uuid', 'text'], 'F1 public.dispatch_mark_failed(uuid, text) exists');
select function_returns('public', 'dispatch_take_lease', array['uuid'], 'setof sends', 'F2 dispatch_take_lease returns setof public.sends');
select function_returns('public', 'dispatch_recipients', array['uuid'], 'jsonb', 'F2 dispatch_recipients returns jsonb (one row: sidesteps PostgREST max_rows)');
select function_returns('public', 'dispatch_record_result', array['uuid', 'text', 'text[]', 'integer'], 'setof sends', 'F2 dispatch_record_result returns setof public.sends');
select function_returns('public', 'dispatch_mark_failed', array['uuid', 'text'], 'setof sends', 'F2 dispatch_mark_failed returns setof public.sends');
select is(bool_and(not p.prosecdef), true, 'F3 none of the dispatch_* functions is security definer')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'dispatch\_%';
select is(bool_and(exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=""')), true, 'F3 every dispatch_* function pins search_path = ''''')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'dispatch\_%';
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'dispatch\_%'), 5::bigint, 'F3 exactly five dispatch_* functions (the four of 4.3 + dispatch_mark_partial from Story 6.2)');
select is(p.provolatile, 'v', 'F4 dispatch_take_lease is volatile') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'dispatch_take_lease';
select is(p.provolatile, 's', 'F4 dispatch_recipients is stable') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'dispatch_recipients';
select is(p.provolatile, 'v', 'F4 dispatch_record_result is volatile') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'dispatch_record_result';
select is(p.provolatile, 'v', 'F4 dispatch_mark_failed is volatile') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'dispatch_mark_failed';

-- ============================================================================
-- G: grant surface — service_role only. Neither authenticated nor anon nor PUBLIC may execute any of them
--    (the tenancy suite's S5/S6 allow-lists stay unchanged; S7's secdef list too).
-- ============================================================================
select ok(has_function_privilege('service_role', 'public.dispatch_take_lease(uuid)', 'execute'), 'G1 service_role may execute dispatch_take_lease');
select ok(has_function_privilege('service_role', 'public.dispatch_recipients(uuid)', 'execute'), 'G1 service_role may execute dispatch_recipients');
select ok(has_function_privilege('service_role', 'public.dispatch_record_result(uuid, text, text[], integer)', 'execute'), 'G1 service_role may execute dispatch_record_result');
select ok(has_function_privilege('service_role', 'public.dispatch_mark_failed(uuid, text)', 'execute'), 'G1 service_role may execute dispatch_mark_failed');
select ok(not has_function_privilege('authenticated', 'public.dispatch_take_lease(uuid)', 'execute'), 'G2 authenticated may not execute dispatch_take_lease');
select ok(not has_function_privilege('authenticated', 'public.dispatch_recipients(uuid)', 'execute'), 'G2 authenticated may not execute dispatch_recipients');
select ok(not has_function_privilege('authenticated', 'public.dispatch_record_result(uuid, text, text[], integer)', 'execute'), 'G2 authenticated may not execute dispatch_record_result');
select ok(not has_function_privilege('authenticated', 'public.dispatch_mark_failed(uuid, text)', 'execute'), 'G2 authenticated may not execute dispatch_mark_failed');
select ok(not has_function_privilege('anon', 'public.dispatch_take_lease(uuid)', 'execute'), 'G3 anon may not execute dispatch_take_lease');
select ok(not has_function_privilege('anon', 'public.dispatch_recipients(uuid)', 'execute'), 'G3 anon may not execute dispatch_recipients');
select ok(not has_function_privilege('anon', 'public.dispatch_record_result(uuid, text, text[], integer)', 'execute'), 'G3 anon may not execute dispatch_record_result');
select ok(not has_function_privilege('anon', 'public.dispatch_mark_failed(uuid, text)', 'execute'), 'G3 anon may not execute dispatch_mark_failed');
select ok(not has_function_privilege('public', 'public.dispatch_take_lease(uuid)', 'execute'), 'G4 PUBLIC may not execute dispatch_take_lease');
select ok(not has_function_privilege('public', 'public.dispatch_recipients(uuid)', 'execute'), 'G4 PUBLIC may not execute dispatch_recipients');
select ok(not has_function_privilege('public', 'public.dispatch_record_result(uuid, text, text[], integer)', 'execute'), 'G4 PUBLIC may not execute dispatch_record_result');
select ok(not has_function_privilege('public', 'public.dispatch_mark_failed(uuid, text)', 'execute'), 'G4 PUBLIC may not execute dispatch_mark_failed');

-- ============================================================================
-- fixtures — brand A; contacts aa01..aa03 carry external_ids DT-c, DT-a, DT-b (contact_id order ≠ external_id
-- order); one campaign per send because of uq_sends_one_active_per_campaign:
--   s1 confirmed, 3 recipients (the happy path: lease → reporting)
--   s2 confirmed, 2 recipients (subset accepted → partial)
--   s3 reporting, batch_id B3 (a finished send: no lease, no failure)
--   s4 confirmed, 1 recipient (4xx → failed; record_result on a non-dispatched send is refused)
--   s5 dispatched, batch_id B5 (a batch_id already recorded: no lease, no second result)
-- ============================================================================
create function pg_temp.fx() returns void language plpgsql as $$
declare
  ba uuid;
begin
  insert into public.brands (code, name) values ('DISPATCHTEST-A', 'Dispatch Test Brand A') returning id into ba;
  perform set_config('dispatch.brand_a', ba::text, true);

  insert into public.contacts (id, brand_id, external_id, email, country, status, consent_marketing) values
    ('00000000-0000-4000-8000-00000000aa01', ba, 'DT-c', 'c@x.test', 'KE', 'active', true),
    ('00000000-0000-4000-8000-00000000aa02', ba, 'DT-a', 'a@x.test', 'KE', 'active', true),
    ('00000000-0000-4000-8000-00000000aa03', ba, 'DT-b', 'b@x.test', 'KE', 'active', true);

  insert into public.campaigns (id, brand_id, external_id, name, channel, target_country, sent_at) values
    ('00000000-0000-4000-8000-00000000c001', ba, 'CMP-D1', 'Dispatch 1', 'email', 'KE', now()),
    ('00000000-0000-4000-8000-00000000c002', ba, 'CMP-D2', 'Dispatch 2', 'email', 'KE', now()),
    ('00000000-0000-4000-8000-00000000c003', ba, 'CMP-D3', 'Dispatch 3', 'email', 'KE', now()),
    ('00000000-0000-4000-8000-00000000c004', ba, 'CMP-D4', 'Dispatch 4', 'email', 'KE', now()),
    ('00000000-0000-4000-8000-00000000c005', ba, 'CMP-D5', 'Dispatch 5', 'email', 'KE', now());

  insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, confirmed_by, confirmed_at, body_sha256, batch_id, dispatched_at) values
    ('00000000-0000-4000-8000-00000000d001', ba, '00000000-0000-4000-8000-00000000c001', 'confirmed',  'portal', 3, 'owner@x.test', now(), encode(sha256(convert_to(E'DT-c\nDT-a\nDT-b', 'UTF8')), 'hex'), null, null),
    ('00000000-0000-4000-8000-00000000d002', ba, '00000000-0000-4000-8000-00000000c002', 'confirmed',  'portal', 2, 'owner@x.test', now(), encode(sha256(convert_to(E'DT-c\nDT-a', 'UTF8')), 'hex'), null, null),
    ('00000000-0000-4000-8000-00000000d003', ba, '00000000-0000-4000-8000-00000000c003', 'reporting',  'portal', 1, 'owner@x.test', now(), encode(sha256(convert_to('DT-c', 'UTF8')), 'hex'), 'B3', now()),
    ('00000000-0000-4000-8000-00000000d004', ba, '00000000-0000-4000-8000-00000000c004', 'confirmed',  'portal', 1, 'owner@x.test', now(), encode(sha256(convert_to('DT-c', 'UTF8')), 'hex'), null, null),
    ('00000000-0000-4000-8000-00000000d005', ba, '00000000-0000-4000-8000-00000000c005', 'dispatched', 'portal', 1, 'owner@x.test', now(), encode(sha256(convert_to('DT-c', 'UTF8')), 'hex'), 'B5', now());
  insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address) values
    ('00000000-0000-4000-8000-00000000d001', ba, '00000000-0000-4000-8000-00000000aa01', 'DT-c', 'c@x.test'),
    ('00000000-0000-4000-8000-00000000d001', ba, '00000000-0000-4000-8000-00000000aa02', 'DT-a', 'a@x.test'),
    ('00000000-0000-4000-8000-00000000d001', ba, '00000000-0000-4000-8000-00000000aa03', 'DT-b', 'b@x.test'),
    ('00000000-0000-4000-8000-00000000d002', ba, '00000000-0000-4000-8000-00000000aa01', 'DT-c', 'c@x.test'),
    ('00000000-0000-4000-8000-00000000d002', ba, '00000000-0000-4000-8000-00000000aa02', 'DT-a', 'a@x.test'),
    ('00000000-0000-4000-8000-00000000d003', ba, '00000000-0000-4000-8000-00000000aa01', 'DT-c', 'c@x.test'),
    ('00000000-0000-4000-8000-00000000d004', ba, '00000000-0000-4000-8000-00000000aa01', 'DT-c', 'c@x.test'),
    ('00000000-0000-4000-8000-00000000d005', ba, '00000000-0000-4000-8000-00000000aa01', 'DT-c', 'c@x.test');
  insert into public.provider_batches (send_id, brand_id, batch_id, polling) values
    ('00000000-0000-4000-8000-00000000d003', ba, 'B3', 'active'),
    ('00000000-0000-4000-8000-00000000d005', ba, 'B5', 'active');
end $$;
select pg_temp.fx();

-- ============================================================================
-- R: dispatch_recipients — one jsonb array, ordered by contact_id, external_id + address; '[]' for an unknown send;
--    and the digest the Edge Function recomputes over it equals body_sha256 (the 4.2 contract).
-- ============================================================================
set local role service_role;
select is(current_user::text, 'service_role', 'R0 running as service_role');
select is(public.dispatch_recipients('00000000-0000-4000-8000-00000000d001'),
          '[{"address": "c@x.test", "external_id": "DT-c"}, {"address": "a@x.test", "external_id": "DT-a"}, {"address": "b@x.test", "external_id": "DT-b"}]'::jsonb,
          'R1 dispatch_recipients = the snapshot in contact_id order (DT-c, DT-a, DT-b), external_id + address');
select is(jsonb_typeof(public.dispatch_recipients('00000000-0000-4000-8000-00000000d001')), 'array', 'R1 ... as a jsonb array');
select is(public.dispatch_recipients('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e'), '[]'::jsonb, 'R2 unknown send → empty array, not null');
select is((select encode(sha256(convert_to(string_agg(r->>'external_id', E'\n'), 'UTF8')), 'hex')
             from jsonb_array_elements(public.dispatch_recipients('00000000-0000-4000-8000-00000000d001')) r),
          (select body_sha256 from public.sends where id = '00000000-0000-4000-8000-00000000d001'),
          'R3 sha256(external_ids joined by \n, in array order) = body_sha256 — the check the Edge Function makes before POSTing');
select is((select encode(sha256(convert_to(string_agg(r->>'external_id', E'\n'), 'UTF8')), 'hex')
             from jsonb_array_elements(public.dispatch_recipients('00000000-0000-4000-8000-00000000d002')) r),
          (select body_sha256 from public.sends where id = '00000000-0000-4000-8000-00000000d002'),
          'R3 ... for the two-recipient send as well');

-- ============================================================================
-- L: the lease — exactly the architecture's UPDATE: from confirmed|dispatched with a null batch_id, lease null or
--    expired, attempts < 3; attempts + 1, status dispatched, dispatched_at set once.
-- ============================================================================
create temp table t_l1 as select * from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d001');
select is((select count(*) from t_l1), 1::bigint, 'L1 first lease on a confirmed send → one row');
select is((select status::text from t_l1), 'dispatched', 'L1 status = dispatched');
select is((select dispatch_attempts from t_l1), 1, 'L1 dispatch_attempts = 1');
select ok((select dispatch_lease_until > now() + interval '9 min' and dispatch_lease_until <= now() + interval '10 min' from t_l1), 'L1 dispatch_lease_until = now() + 10 min');
select ok((select dispatched_at is not null from t_l1), 'L1 dispatched_at set');
select ok((select batch_id is null and accepted_count is null and provider_responded_at is null from t_l1), 'L1 nothing else touched (batch_id, accepted_count, provider_responded_at still null)');
select is((select row(status, dispatch_attempts, dispatch_lease_until, dispatched_at)::text from public.sends where id = '00000000-0000-4000-8000-00000000d001'),
          (select row(status, dispatch_attempts, dispatch_lease_until, dispatched_at)::text from t_l1), 'L1 the returned row is the stored row');
select is((select count(*) from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d001')), 0::bigint, 'L2 a second call while the lease is live → zero rows (the concurrent invocation is skipped)');
select is((select dispatch_attempts from public.sends where id = '00000000-0000-4000-8000-00000000d001'), 1, 'L2 ... and attempts stay 1');
-- the lease expires (a crash between CAS and POST, or a 5xx): the sweep's re-entry takes it again from `dispatched`
reset role;
update public.sends set dispatch_lease_until = now() - interval '1 second' where id = '00000000-0000-4000-8000-00000000d001';
set local role service_role;
create temp table t_l2 as select * from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d001');
select is((select count(*) from t_l2), 1::bigint, 'L3 expired lease on a dispatched send → one row (re-entry from dispatched)');
select is((select dispatch_attempts from t_l2), 2, 'L3 dispatch_attempts = 2');
select is((select dispatched_at from t_l2), (select dispatched_at from t_l1), 'L3 dispatched_at is set once (coalesce), not overwritten');
select ok((select dispatch_lease_until > now() + interval '9 min' from t_l2), 'L3 a fresh 10-min lease');
-- the cap: attempts 3 → never again, even with an expired lease
reset role;
update public.sends set dispatch_lease_until = now() - interval '1 second', dispatch_attempts = 3 where id = '00000000-0000-4000-8000-00000000d001';
set local role service_role;
select is((select count(*) from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d001')), 0::bigint, 'L4 dispatch_attempts = 3 with an expired lease → zero rows (the cap; the sweep turns it partial)');
select is((select dispatch_attempts from public.sends where id = '00000000-0000-4000-8000-00000000d001'), 3, 'L4 ... attempts untouched');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000d001'), 'dispatched', 'L4 ... status untouched');
-- back to a leasable state for the outcome tests below (attempts 2, lease expired)
reset role;
update public.sends set dispatch_lease_until = null, dispatch_attempts = 2 where id = '00000000-0000-4000-8000-00000000d001';
set local role service_role;
select is((select count(*) from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d001')), 1::bigint, 'L5 attempts back to 2 and lease null → leasable again (attempts 3 now)');
-- the other guards
select is((select count(*) from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d003')), 0::bigint, 'L6 a reporting send (batch_id set) → zero rows');
select is((select count(*) from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d005')), 0::bigint, 'L6 a dispatched send that already carries a batch_id → zero rows (batch_id is null is part of the CAS)');
select is((select count(*) from public.dispatch_take_lease('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e')), 0::bigint, 'L6 unknown send → zero rows');
select is((select count(*) from public.dispatch_take_lease(null)), 0::bigint, 'L6 null send → zero rows');
select is((select row(status, dispatch_attempts, batch_id)::text from public.sends where id = '00000000-0000-4000-8000-00000000d005'), '(dispatched,0,B5)', 'L6 s5 untouched');

-- ============================================================================
-- C: dispatch_record_result — the 2xx outcome. accepted_count = count(distinct accepted ∩ send_recipients.external_id)
--    (duplicates and foreign ids do not count); reporting when it equals recipient_count, else partial;
--    provider_batches upserted; CAS on status = dispatched and batch_id is null.
-- ============================================================================
-- s1 is dispatched, batch_id null: all three accepted (with a duplicate and a stranger in the array)
create temp table t_c1 as select * from public.dispatch_record_result('00000000-0000-4000-8000-00000000d001', 'mock-1', array['DT-a', 'DT-b', 'DT-c', 'DT-c', 'NOT-A-RECIPIENT'], 0);
select is((select count(*) from t_c1), 1::bigint, 'C1 record_result on a dispatched send → one row');
select is((select status::text from t_c1), 'reporting', 'C1 all recipients accepted → reporting');
select is((select batch_id from t_c1), 'mock-1', 'C1 sends.batch_id = the provider batch id');
select is((select accepted_count from t_c1), 3, 'C1 accepted_count = 3 (distinct ∩ recipients: the duplicate and the stranger do not count)');
select is((select rejected_count from t_c1), 0, 'C1 rejected_count = 0');
select ok((select provider_responded_at is not null from t_c1), 'C1 provider_responded_at set');
select is((select row(status, batch_id, accepted_count, rejected_count)::text from public.sends where id = '00000000-0000-4000-8000-00000000d001'), '(reporting,mock-1,3,0)', 'C1 the stored row matches');
select results_eq(
  $$ select send_id, brand_id, batch_id, polling, next_cursor, last_event_id from public.provider_batches where send_id = '00000000-0000-4000-8000-00000000d001' $$,
  $$ values ('00000000-0000-4000-8000-00000000d001'::uuid, current_setting('dispatch.brand_a')::uuid, 'mock-1', 'active', null::text, null::text) $$,
  'C2 provider_batches row: send_id, the send''s brand_id, batch_id, polling active, cursors null (Epic 6 writes those)');
-- CAS: a second result for the same send (a replayed provider response) changes nothing
select is((select count(*) from public.dispatch_record_result('00000000-0000-4000-8000-00000000d001', 'mock-1', array['DT-a'], 2)), 0::bigint, 'C3 a second record_result → zero rows (batch_id is no longer null)');
select is((select row(status, batch_id, accepted_count, rejected_count)::text from public.sends where id = '00000000-0000-4000-8000-00000000d001'), '(reporting,mock-1,3,0)', 'C3 ... the row is unchanged');
select is((select count(*) from public.provider_batches where send_id = '00000000-0000-4000-8000-00000000d001'), 1::bigint, 'C3 ... still one provider_batches row');
-- a subset accepted → partial (s2: two recipients, one accepted, one rejected)
select is((select count(*) from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d002')), 1::bigint, 'C4 lease s2');
create temp table t_c4 as select * from public.dispatch_record_result('00000000-0000-4000-8000-00000000d002', 'mock-2', array['DT-a'], 1);
select is((select status::text from t_c4), 'partial', 'C4 one of two accepted → partial');
select is((select row(batch_id, accepted_count, rejected_count)::text from t_c4), '(mock-2,1,1)', 'C4 batch_id, accepted_count 1, rejected_count 1');
select is((select batch_id from public.provider_batches where send_id = '00000000-0000-4000-8000-00000000d002'), 'mock-2', 'C4 provider_batches row for the partial send too (its reports are still polled)');
-- an empty accepted list → partial with accepted_count 0
select is((select count(*) from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d004')), 1::bigint, 'C5 lease s4');
create temp table t_c5 as select * from public.dispatch_record_result('00000000-0000-4000-8000-00000000d004', 'mock-4', array[]::text[], 1);
select is((select row(status, accepted_count, rejected_count)::text from t_c5), '(partial,0,1)', 'C5 nobody accepted → partial, accepted_count 0');
-- the guards: not dispatched, or batch_id already set, or unknown
reset role;
update public.sends set status = 'confirmed', batch_id = null, accepted_count = null, rejected_count = null, provider_responded_at = null, dispatch_lease_until = null where id = '00000000-0000-4000-8000-00000000d004';
delete from public.provider_batches where send_id = '00000000-0000-4000-8000-00000000d004';
set local role service_role;
select is((select count(*) from public.dispatch_record_result('00000000-0000-4000-8000-00000000d004', 'mock-4b', array['DT-c'], 0)), 0::bigint, 'C6 record_result on a confirmed (never leased) send → zero rows');
select is((select row(status, batch_id)::text from public.sends where id = '00000000-0000-4000-8000-00000000d004'), '(confirmed,)', 'C6 ... nothing written');
select is((select count(*) from public.provider_batches where send_id = '00000000-0000-4000-8000-00000000d004'), 0::bigint, 'C6 ... no provider_batches row');
select is((select count(*) from public.dispatch_record_result('00000000-0000-4000-8000-00000000d005', 'mock-5', array['DT-c'], 0)), 0::bigint, 'C6 record_result on a dispatched send with a batch_id → zero rows');
select is((select count(*) from public.dispatch_record_result('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e', 'mock-x', array['DT-c'], 0)), 0::bigint, 'C6 unknown send → zero rows');
select is((select count(*) from public.provider_batches), 4::bigint, 'C6 provider_batches: B3, B5, mock-1, mock-2 — nothing else');

-- ============================================================================
-- M: dispatch_mark_failed — the 4xx / body_hash_mismatch outcome. failed + failure_reason (≤ 500 chars) +
--    provider_responded_at; CAS on status = dispatched and batch_id is null.
-- ============================================================================
select is((select count(*) from public.dispatch_take_lease('00000000-0000-4000-8000-00000000d004')), 1::bigint, 'M0 lease s4 again (attempts 2)');
create temp table t_m1 as select * from public.dispatch_mark_failed('00000000-0000-4000-8000-00000000d004', 'provider_4xx: 422 recipients invalid');
select is((select count(*) from t_m1), 1::bigint, 'M1 mark_failed on a dispatched send → one row');
select is((select status::text from t_m1), 'failed', 'M1 status = failed');
select is((select failure_reason from t_m1), 'provider_4xx: 422 recipients invalid', 'M1 failure_reason stored');
select ok((select provider_responded_at is not null from t_m1), 'M1 provider_responded_at set');
select ok((select batch_id is null from t_m1), 'M1 batch_id stays null');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000d004'), 'failed', 'M1 the stored row is failed');
select is((select count(*) from public.dispatch_mark_failed('00000000-0000-4000-8000-00000000d004', 'again')), 0::bigint, 'M2 mark_failed on a failed send → zero rows');
select is((select failure_reason from public.sends where id = '00000000-0000-4000-8000-00000000d004'), 'provider_4xx: 422 recipients invalid', 'M2 ... the reason is not overwritten');
select is((select count(*) from public.dispatch_mark_failed('00000000-0000-4000-8000-00000000d003', 'nope')), 0::bigint, 'M3 mark_failed on a reporting send → zero rows');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000d003'), 'reporting', 'M3 ... still reporting');
select is((select count(*) from public.dispatch_mark_failed('00000000-0000-4000-8000-00000000d001', 'nope')), 0::bigint, 'M3 mark_failed on the send that reached reporting via record_result → zero rows');
select is((select count(*) from public.dispatch_mark_failed('00000000-0000-4000-8000-00000000d005', 'nope')), 0::bigint, 'M3 mark_failed on a dispatched send with a batch_id → zero rows');
select is((select count(*) from public.dispatch_mark_failed('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e', 'nope')), 0::bigint, 'M3 unknown send → zero rows');
-- the reason is capped at 500 characters (a provider body can be long)
reset role;
update public.sends set status = 'dispatched', batch_id = null, failure_reason = null where id = '00000000-0000-4000-8000-00000000d004';
set local role service_role;
select is((select length(failure_reason) from public.dispatch_mark_failed('00000000-0000-4000-8000-00000000d004', repeat('x', 800))), 500, 'M4 failure_reason is cut to 500 characters');
-- a failed send frees the campaign (the partial unique index ignores failed) — the owner can confirm again
select is((select count(*) from public.sends where campaign_id = '00000000-0000-4000-8000-00000000c004' and status not in ('complete', 'partial', 'failed')), 0::bigint, 'M5 a failed send is outside the one-active-send-per-campaign index');
reset role;

-- ============================================================================
-- N: authenticated and anon — permission denied on every function (the grant surface, behaviourally).
-- ============================================================================
set local role authenticated;
select throws_ok($$ select public.dispatch_take_lease('00000000-0000-4000-8000-00000000d002') $$, '42501', null, 'N1 authenticated: permission denied on dispatch_take_lease');
select throws_ok($$ select public.dispatch_recipients('00000000-0000-4000-8000-00000000d002') $$, '42501', null, 'N1 authenticated: permission denied on dispatch_recipients');
select throws_ok($$ select public.dispatch_record_result('00000000-0000-4000-8000-00000000d002', 'b', array['DT-a'], 0) $$, '42501', null, 'N1 authenticated: permission denied on dispatch_record_result');
select throws_ok($$ select public.dispatch_mark_failed('00000000-0000-4000-8000-00000000d002', 'r') $$, '42501', null, 'N1 authenticated: permission denied on dispatch_mark_failed');
reset role;
set local role anon;
select throws_ok($$ select public.dispatch_take_lease('00000000-0000-4000-8000-00000000d002') $$, '42501', null, 'N2 anon: permission denied on dispatch_take_lease');
select throws_ok($$ select public.dispatch_mark_failed('00000000-0000-4000-8000-00000000d002', 'r') $$, '42501', null, 'N2 anon: permission denied on dispatch_mark_failed');
reset role;

-- ============================================================================
-- Z: as postgres — the end state is exactly what the calls above wrote, and the role is restored.
-- ============================================================================
select results_eq(
  $$ select id::text, status::text, dispatch_attempts, batch_id from public.sends where brand_id = current_setting('dispatch.brand_a')::uuid order by id $$,
  $$ values ('00000000-0000-4000-8000-00000000d001', 'reporting', 3, 'mock-1'),
            ('00000000-0000-4000-8000-00000000d002', 'partial', 1, 'mock-2'),
            ('00000000-0000-4000-8000-00000000d003', 'reporting', 0, 'B3'),
            ('00000000-0000-4000-8000-00000000d004', 'failed', 2, null),
            ('00000000-0000-4000-8000-00000000d005', 'dispatched', 0, 'B5') $$,
  'Z1 end state: s1 reporting (3 attempts, mock-1), s2 partial (mock-2), s3 untouched, s4 failed (2 attempts), s5 untouched');
select is((select count(*) from public.provider_batches p join public.sends s on s.id = p.send_id where s.batch_id is distinct from p.batch_id), 0::bigint, 'Z2 every provider_batches.batch_id equals its send''s batch_id');
select is(current_user::text, 'postgres', 'Z3 role restored before finish');

select * from finish();
rollback;
