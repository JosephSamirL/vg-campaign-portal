-- 0007_confirm_send.test.sql — confirm exactly once (Story 4.2; D-2, D-6; Step-3 amendments #4, #9, #11; S20).
-- Story 4.3 (dispatch) gets its own numbered file; this one stays the confirm_send contract.
--
-- Synthetic brands A and B (an owner + an analyst in A, an owner in B), the Story 4.1 contacts with FIXED ids
-- so the snapshot order (by contact_id) is literal, and the 4.1 campaigns plus one that classifies nobody —
-- all under one transaction, rolled back; the local seed data is never touched.
-- Pins: the function's shape and grant surface; the error contract in order (not_owner → not_in_brand →
-- invalid_input → count_mismatch with hint = the new count); the sends row it writes; the send_recipients
-- snapshot (exactly the recipients, external_id + address for the channel, ordered by contact_id);
-- recipient_count = count(send_recipients); body_sha256 = sha256 of the external_ids joined by '\n' in
-- contact_id order; and a second confirm returning the same send (one row, not an error).

begin;
create extension if not exists pgtap with schema extensions;
select plan(77);

-- the hint of the error a statement raises (null when it does not raise): pgTAP's throws_ok never sees hints.
create function pg_temp.hint_of(p_sql text) returns text language plpgsql as $$
declare v_hint text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return v_hint;
end $$;

-- ============================================================================
-- F: the function — secdef, search_path pinned, volatile, returns public.sends, authenticated only.
-- ============================================================================
select has_function('public', 'confirm_send', array['uuid', 'integer'], 'F1 public.confirm_send(uuid, int) exists');
select function_returns('public', 'confirm_send', array['uuid', 'integer'], 'sends', 'F1 confirm_send returns public.sends');
select is(p.prosecdef, true, 'F1 confirm_send is security definer')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'confirm_send';
select ok(exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=""'), 'F1 confirm_send pins search_path = ''''')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'confirm_send';
select is(p.provolatile, 'v', 'F1 confirm_send is volatile (it writes)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'confirm_send';
select ok(has_function_privilege('authenticated', 'public.confirm_send(uuid, integer)', 'execute'), 'F2 authenticated may execute confirm_send');
select ok(not has_function_privilege('anon', 'public.confirm_send(uuid, integer)', 'execute'), 'F2 anon may not execute confirm_send');
select ok(not has_function_privilege('public', 'public.confirm_send(uuid, integer)', 'execute'), 'F2 PUBLIC may not execute confirm_send');

-- ============================================================================
-- fixtures — brands A (owner + analyst) and B (owner); Story 4.1's contacts with fixed ids; the 4.1 campaigns
-- plus CMP-sms-TZ (nobody qualifies) and a finished send on CMP-email-KE (a complete send must not block).
-- Contact ids are deliberately NOT in external_id order: the snapshot order is by contact_id, nothing else.
-- ============================================================================
create function pg_temp.fx() returns void language plpgsql as $$
declare
  ba uuid; bb uuid;
  owner_a uuid := '00000000-0000-4000-8000-0000000000e1';
  analyst_a uuid := '00000000-0000-4000-8000-0000000000e2';
  owner_b uuid := '00000000-0000-4000-8000-0000000000e3';
begin
  insert into public.brands (code, name) values ('CONFIRMTEST-A', 'Confirm Test Brand A') returning id into ba;
  insert into public.brands (code, name) values ('CONFIRMTEST-B', 'Confirm Test Brand B') returning id into bb;
  perform set_config('confirm.brand_a', ba::text, true);
  perform set_config('confirm.brand_b', bb::text, true);
  perform set_config('confirm.owner_a', owner_a::text, true);
  perform set_config('confirm.analyst_a', analyst_a::text, true);
  perform set_config('confirm.owner_b', owner_b::text, true);

  insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (owner_a,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-confirm-owner-a@tenancy.test',   '{}', '{}', now(), now()),
         (analyst_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-confirm-analyst-a@tenancy.test', '{}', '{}', now(), now()),
         (owner_b,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-confirm-owner-b@tenancy.test',   '{}', '{}', now(), now());
  insert into public.app_users (email, brand_id, role, auth_user_id)
  values ('fixture-confirm-owner-a@tenancy.test',   ba, 'owner',   owner_a),
         ('fixture-confirm-analyst-a@tenancy.test', ba, 'analyst', analyst_a),
         ('fixture-confirm-owner-b@tenancy.test',   bb, 'owner',   owner_b);

  insert into public.contacts (id, brand_id, external_id, email, phone, country, status, consent_marketing, deleted_at) values
    ('00000000-0000-4000-8000-00000000aa01', ba, 'RC-country-ug',    'ug@x.test',       '+256700000004', 'UG', 'active', true,  null),
    ('00000000-0000-4000-8000-00000000aa02', ba, 'RC-country-null',  'nowhere@x.test',  null,            null, 'active', true,  null),
    ('00000000-0000-4000-8000-00000000aa03', ba, 'RC-recipient',     'ok@x.test',       '+254700000001', 'KE', 'active', true,  null),
    ('00000000-0000-4000-8000-00000000aa04', ba, 'RC-no-email',      null,              '+254700000003', 'KE', 'active', true,  null),
    ('00000000-0000-4000-8000-00000000aa05', ba, 'RC-consent-false', 'noconsent@x.test','+254700000002', 'KE', 'active', false, null),
    ('00000000-0000-4000-8000-00000000aa06', ba, 'RC-deleted',       'gone@x.test',     '+254700000006', 'KE', 'active', true,  now());
  insert into public.contacts (id, brand_id, external_id, email, country, status, consent_marketing)
  values ('00000000-0000-4000-8000-00000000bb01', bb, 'RC-B1', 'b1@x.test', 'KE', 'active', true);

  insert into public.campaigns (id, brand_id, external_id, name, channel, target_country, sent_at) values
    ('00000000-0000-4000-8000-00000000c001', ba, 'CMP-email-KE',  'Email to Kenya',     'email', 'KE', now()),
    ('00000000-0000-4000-8000-00000000c002', ba, 'CMP-sms-KE',    'SMS to Kenya',       'sms',   'KE', now()),
    ('00000000-0000-4000-8000-00000000c003', ba, 'CMP-email-any', 'Email, untargeted',  'email', null, now()),
    ('00000000-0000-4000-8000-00000000c004', ba, 'CMP-push',      'Push (unsupported)', 'push',  'KE', now()),
    ('00000000-0000-4000-8000-00000000c005', ba, 'CMP-nochannel', 'No channel',         null,    'KE', now()),
    ('00000000-0000-4000-8000-00000000c006', ba, 'CMP-sms-TZ',    'SMS to Tanzania',    'sms',   'TZ', now()),
    ('00000000-0000-4000-8000-00000000c0b1', bb, 'CMP-B-email',   'Brand B email',      'email', 'KE', now());

  -- a finished send on CMP-email-KE: outside the partial unique index, so it must not block a new confirm
  insert into public.sends (id, brand_id, campaign_id, status, source, batch_key, recipient_count, batch_id)
  values ('00000000-0000-4000-8000-00000000d001', ba, '00000000-0000-4000-8000-00000000c001', 'complete', 'seed_send_log', 'SL-A1', 1, 'BATCH-A1');
end $$;
select pg_temp.fx();

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- called while the role is authenticated: default privileges (0000) leave temp functions to postgres only
grant execute on function pg_temp.as_postgres(), pg_temp.hint_of(text) to public;

-- ============================================================================
-- R: role check first — an analyst and a user with no app_users row both get not_owner, nothing is written.
-- ============================================================================
select pg_temp.as_user(current_setting('confirm.analyst_a'));
select is(current_user::text, 'authenticated', 'R0 running as authenticated (analyst of brand A)');
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', 1) $$, 'P0001', 'not_owner', 'R1 analyst → not_owner');
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c0b1', 1) $$, 'P0001', 'not_owner', 'R2 analyst → not_owner even for another brand''s campaign (role check comes first)');
select throws_ok($$ select public.confirm_send('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e', 1) $$, 'P0001', 'not_owner', 'R3 analyst → not_owner for an unknown campaign (learns nothing)');
select pg_temp.as_postgres();
select pg_temp.as_user('00000000-0000-4000-8000-0000000000fe');
select is(public.current_app_role(), null, 'R4 a user with no app_users row has a null role');
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', 1) $$, 'P0001', 'not_owner', 'R5 null role → not_owner (is distinct from, never a silent pass)');
select pg_temp.as_postgres();
select is((select count(*) from public.sends), 1::bigint, 'R6 nothing was written: still only the fixture send');

-- ============================================================================
-- O: as the owner of brand A — the error contract, then the writes.
-- ============================================================================
select pg_temp.as_user(current_setting('confirm.owner_a'));
select is(public.current_app_role(), 'owner'::public.app_role, 'O0 running as the owner of brand A');
select is(public.current_brand_id(), current_setting('confirm.brand_a')::uuid, 'O0 current_brand_id() is brand A');

-- not_in_brand: brand B's campaign, an unknown id, null — indistinguishable by design
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c0b1', 1) $$, 'P0001', 'not_in_brand', 'O1 brand B''s campaign → not_in_brand');
select throws_ok($$ select public.confirm_send('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e', 1) $$, 'P0001', 'not_in_brand', 'O2 unknown campaign → not_in_brand');
select throws_ok($$ select public.confirm_send(null, 1) $$, 'P0001', 'not_in_brand', 'O3 null campaign → not_in_brand');
-- invalid_input: unsupported channel, no channel, nobody qualifies
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c004', 1) $$, 'P0001', 'invalid_input', 'O4 channel push → invalid_input');
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c005', 1) $$, 'P0001', 'invalid_input', 'O5 null channel → invalid_input');
select is((select total_count from public.recipient_preview('00000000-0000-4000-8000-00000000c006')), 0::bigint, 'O6 CMP-sms-TZ previews zero recipients');
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c006', 0) $$, 'P0001', 'invalid_input', 'O6 zero recipients → invalid_input (even with the matching count 0)');
-- count_mismatch carries the recount as the hint
select is((select total_count from public.recipient_preview('00000000-0000-4000-8000-00000000c001')), 1::bigint, 'O7 CMP-email-KE previews exactly one recipient');
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', 5) $$, 'P0001', 'count_mismatch', 'O7 wrong count → count_mismatch');
select is(pg_temp.hint_of($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', 5) $$), '1', 'O7 count_mismatch hint = the new count (1)');
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', null) $$, 'P0001', 'count_mismatch', 'O8 null expected count → count_mismatch');
select is(pg_temp.hint_of($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', null) $$), '1', 'O8 null expected count: hint still = the new count');
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c003', 2) $$, 'P0001', 'count_mismatch', 'O9 untargeted email: wrong count → count_mismatch');
select is(pg_temp.hint_of($$ select public.confirm_send('00000000-0000-4000-8000-00000000c003', 2) $$), '3', 'O9 hint = 3 (the three recipients of the untargeted email)');
select is((select count(*) from public.sends), 1::bigint, 'O10 every refusal wrote nothing: still only the fixture send');

-- the confirm: CMP-email-KE with the count on screen
create temp table t_send1 as select * from public.confirm_send('00000000-0000-4000-8000-00000000c001', 1);
select is((select count(*) from t_send1), 1::bigint, 'O11 confirm_send returns exactly one sends row');
select is((select status::text from t_send1), 'confirmed', 'O11 status = confirmed');
select is((select source::text from t_send1), 'portal', 'O11 source = portal');
select is((select recipient_count from t_send1), 1, 'O11 recipient_count = 1');
select is((select confirmed_by from t_send1), 'fixture-confirm-owner-a@tenancy.test', 'O11 confirmed_by = the caller''s app_users.email');
select ok((select confirmed_at is not null from t_send1), 'O11 confirmed_at is set');
select is((select brand_id from t_send1), current_setting('confirm.brand_a')::uuid, 'O11 brand_id = the caller''s brand');
select is((select campaign_id from t_send1), '00000000-0000-4000-8000-00000000c001'::uuid, 'O11 campaign_id = the campaign');
select ok((select batch_key is null and batch_id is null and dispatched_at is null and dispatch_attempts = 0 from t_send1), 'O11 nothing dispatch-related is set yet (4.3)');
select isnt((select id from t_send1), '00000000-0000-4000-8000-00000000d001'::uuid, 'O11 the complete fixture send did not block: a new row was created');
-- the returned row is what the table holds (RLS lets the owner read it)
select is((select count(*) from public.sends s join t_send1 t on t.id = s.id and t.status = s.status and t.body_sha256 = s.body_sha256), 1::bigint, 'O12 the returned row matches the stored row (incl. body_sha256)');
select is((select count(*) from public.sends where campaign_id = '00000000-0000-4000-8000-00000000c001' and status not in ('complete', 'partial', 'failed')), 1::bigint, 'O12 exactly one active send on the campaign');

-- the snapshot
select results_eq(
  $$ select r.brand_id, r.contact_id, r.external_id, r.address from public.send_recipients r join t_send1 t on t.id = r.send_id order by r.contact_id $$,
  $$ values (current_setting('confirm.brand_a')::uuid, '00000000-0000-4000-8000-00000000aa03'::uuid, 'RC-recipient', 'ok@x.test') $$,
  'O13 send_recipients = exactly the one recipient, with external_id + email address and the brand_id');
select is((select count(*) from public.send_recipients r join t_send1 t on t.id = r.send_id), (select recipient_count::bigint from t_send1), 'O14 recipient_count = count(send_recipients)');
select is((select body_sha256 from t_send1), encode(sha256(convert_to('RC-recipient', 'UTF8')), 'hex'), 'O15 body_sha256 = sha256 of the canonical list (one external_id)');

-- second confirm → the same send, not an error and not a second row
create temp table t_send1b as select * from public.confirm_send('00000000-0000-4000-8000-00000000c001', 1);
select is((select id from t_send1b), (select id from t_send1), 'O16 a second confirm returns the same send id');
select is((select row(status, recipient_count, body_sha256, confirmed_at)::text from t_send1b), (select row(status, recipient_count, body_sha256, confirmed_at)::text from t_send1), 'O16 ... and the same row (nothing re-written)');
select is((select count(*) from public.sends where campaign_id = '00000000-0000-4000-8000-00000000c001'), 2::bigint, 'O16 still two sends on the campaign: the complete fixture + the one confirmed');
select is((select count(*) from public.send_recipients r join t_send1 t on t.id = r.send_id), 1::bigint, 'O16 the snapshot was not duplicated');
-- a stale count while the send is active is still a count_mismatch (the recount runs before the insert)
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', 2) $$, 'P0001', 'count_mismatch', 'O17 a wrong count is refused even while a send is active (recount first)');

-- ordering: the untargeted email has three recipients whose contact_ids are NOT in external_id order
create temp table t_send3 as select * from public.confirm_send('00000000-0000-4000-8000-00000000c003', 3);
select is((select recipient_count from t_send3), 3, 'O18 untargeted email: recipient_count = 3');
select results_eq(
  $$ select r.external_id from public.send_recipients r join t_send3 t on t.id = r.send_id order by r.contact_id $$,
  $$ values ('RC-country-ug'), ('RC-country-null'), ('RC-recipient') $$,
  'O18 snapshot ordered by contact_id (aa01 ug, aa02 null-country, aa03 recipient) — not by external_id');
select is((select count(*) from public.send_recipients r join t_send3 t on t.id = r.send_id), 3::bigint, 'O18 recipient_count = count(send_recipients) for the three');
select is((select body_sha256 from t_send3),
          encode(sha256(convert_to(E'RC-country-ug\nRC-country-null\nRC-recipient', 'UTF8')), 'hex'),
          'O19 body_sha256 = sha256(external_ids in contact_id order joined by \n) — the digest 4.3 recomputes');
select is((select body_sha256 from t_send3),
          (select encode(sha256(convert_to(string_agg(r.external_id, E'\n' order by r.contact_id), 'UTF8')), 'hex')
             from public.send_recipients r join t_send3 t on t.id = r.send_id),
          'O19 ... and equals a recomputation over the stored snapshot');

-- sms: the address is the phone
create temp table t_send2 as select * from public.confirm_send('00000000-0000-4000-8000-00000000c002', 2);
select results_eq(
  $$ select r.external_id, r.address from public.send_recipients r join t_send2 t on t.id = r.send_id order by r.contact_id $$,
  $$ values ('RC-recipient', '+254700000001'), ('RC-no-email', '+254700000003') $$,
  'O21 sms snapshot: address = phone, ordered by contact_id (aa03, aa04)');
select is((select body_sha256 from t_send2), encode(sha256(convert_to(E'RC-recipient\nRC-no-email', 'UTF8')), 'hex'), 'O21 sms body_sha256 over the same canonical form');

-- what the owner sees through the tables afterwards
select is((select count(*) from public.sends), 4::bigint, 'O22 owner sees four sends of brand A (fixture + three confirmed)');
select is((select count(*) from public.sends where status = 'confirmed'), 3::bigint, 'O22 three of them confirmed');
select is((select count(*) from public.send_recipients), 6::bigint, 'O22 six snapshot rows in total (1 + 3 + 2)');
select is((select count(*) from public.sends where brand_id = current_setting('confirm.brand_b')::uuid), 0::bigint, 'O22 nothing of brand B is visible');
select pg_temp.as_postgres();

-- the analyst still cannot confirm, and only reads what the owner made
select pg_temp.as_user(current_setting('confirm.analyst_a'));
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', 1) $$, 'P0001', 'not_owner', 'A1 analyst → not_owner while a send is active (role check still first)');
select is((select count(*) from public.sends where status = 'confirmed'), 3::bigint, 'A2 analyst reads the three confirmed sends of own brand');
select pg_temp.as_postgres();

-- ============================================================================
-- B: the owner of brand B — own campaign works, brand A's is not_in_brand, and the rows carry brand B.
-- ============================================================================
select pg_temp.as_user(current_setting('confirm.owner_b'));
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', 1) $$, 'P0001', 'not_in_brand', 'B1 owner of B: brand A''s campaign → not_in_brand');
create temp table t_sendb as select * from public.confirm_send('00000000-0000-4000-8000-00000000c0b1', 1);
select is((select brand_id from t_sendb), current_setting('confirm.brand_b')::uuid, 'B2 owner of B confirms own campaign: brand_id = B');
select is((select confirmed_by from t_sendb), 'fixture-confirm-owner-b@tenancy.test', 'B2 confirmed_by = owner B''s email');
select results_eq(
  $$ select r.brand_id, r.external_id, r.address from public.send_recipients r join t_sendb t on t.id = r.send_id $$,
  $$ values (current_setting('confirm.brand_b')::uuid, 'RC-B1', 'b1@x.test') $$,
  'B2 snapshot rows carry brand B');
select is((select count(*) from public.sends), 1::bigint, 'B3 owner of B sees only own send');
select pg_temp.as_postgres();

-- ============================================================================
-- N: anon — permission denied, nothing else.
-- ============================================================================
set local role anon;
select throws_ok($$ select public.confirm_send('00000000-0000-4000-8000-00000000c001', 1) $$, '42501', null, 'N1 anon: permission denied on confirm_send');
reset role;

-- ============================================================================
-- Z: as postgres — the table state is exactly the four confirms, and the role is restored.
-- ============================================================================
select is((select count(*) from public.sends where status = 'confirmed' and source = 'portal'), 4::bigint, 'Z1 four confirmed portal sends in total (3 in A, 1 in B)');
select is((select count(*) from public.send_recipients), 7::bigint, 'Z1 seven snapshot rows in total');
select is((select count(*) from public.send_recipients r where not exists (select 1 from public.sends s where s.id = r.send_id and s.brand_id = r.brand_id)), 0::bigint, 'Z2 every snapshot row carries its send''s brand_id');
-- the internal predicate is postgres-only (no grant): the snapshot is exactly its recipients, for every confirmed send
select results_eq(
  $$ select r.contact_id from public.send_recipients r join t_send3 t on t.id = r.send_id order by r.contact_id $$,
  $$ select r.contact_id from internal.recipient_classification('00000000-0000-4000-8000-00000000c003') r where r.reason is null order by r.contact_id $$,
  'Z3 the untargeted email snapshot is exactly the shared predicate''s recipients');
select results_eq(
  $$ select r.contact_id, r.address from public.send_recipients r join t_send2 t on t.id = r.send_id order by r.contact_id $$,
  $$ select r.contact_id, r.address from internal.recipient_classification('00000000-0000-4000-8000-00000000c002') r where r.reason is null order by r.contact_id $$,
  'Z3 the sms snapshot is exactly the shared predicate''s recipients with its addresses');
select is(current_user::text, 'postgres', 'Z4 role restored before finish');

select * from finish();
rollback;
