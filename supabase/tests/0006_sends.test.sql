-- 0006_sends.test.sql — send records + the exact recipient preview (Story 4.1; D-2, D-4, D-6; amendments S6, S17, S18).
-- Story 4.2 extends this file (confirm_send section).
--
-- Synthetic brands A and B, one signed-in user in A, six contacts in A (one per exclusion reason plus the
-- one real recipient), an email campaign targeting KE, an sms campaign, an untargeted email campaign and a
-- `push` campaign — all under one transaction, rolled back; the local seed data is never touched.
-- Pins: the three tables' exact columns / keys / FK actions, the partial unique index (one active send per
-- campaign), RLS enabled + forced with the brand policy, SELECT-only grants (a plain insert as
-- authenticated fails), the shared predicate (reasons exclusive by priority so the counts reconcile),
-- recipient_preview's error contract (not_in_brand / invalid_input) and its grant surface.

begin;
create extension if not exists pgtap with schema extensions;
select plan(137);

-- column default as the catalog prints it (col_default_is casts into an enum column's type, which cannot hold an expression)
create function pg_temp.col_default(p_table text, p_column text) returns text language sql stable as $$
  select pg_get_expr(d.adbin, d.adrelid)
  from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  where d.adrelid = ('public.' || p_table)::regclass and a.attname = p_column
$$;

-- ============================================================================
-- T: shape — enums, tables, keys, FK actions, indexes.
-- ============================================================================
select has_enum('public', 'send_status', 'T1 enum public.send_status exists');
select enum_has_labels('public', 'send_status', array['pending', 'confirmed', 'dispatched', 'reporting', 'complete', 'partial', 'failed'], 'T1 send_status labels verbatim');
select has_enum('public', 'send_source', 'T1 enum public.send_source exists');
select enum_has_labels('public', 'send_source', array['portal', 'seed_send_log'], 'T1 send_source labels verbatim');

select has_table('public', 'sends', 'T2 public.sends exists');
select columns_are('public', 'sends',
  array['id', 'brand_id', 'campaign_id', 'status', 'source', 'batch_key', 'recipient_count', 'confirmed_by', 'confirmed_at',
        'dispatched_at', 'provider_responded_at', 'dispatch_attempts', 'dispatch_lease_until', 'body_sha256', 'batch_id',
        'accepted_count', 'rejected_count', 'failure_reason', 'created_at'],
  'T2 sends columns exactly the DDL sketch (incl. S6 batch_id, failure_reason)');
select col_is_pk('public', 'sends', 'id', 'T2 sends.id is the primary key');
select col_type_is('public', 'sends', 'status', 'send_status', 'T2 sends.status is send_status');
select col_type_is('public', 'sends', 'source', 'send_source', 'T2 sends.source is send_source');
select is(pg_temp.col_default('sends', 'status'), $$'pending'::send_status$$, 'T2 sends.status defaults to pending');
select is(pg_temp.col_default('sends', 'dispatch_attempts'), '0', 'T2 sends.dispatch_attempts defaults to 0');
select col_not_null('public', 'sends', 'recipient_count', 'T2 sends.recipient_count is not null');
select col_is_null('public', 'sends', 'batch_key', 'T2 sends.batch_key is nullable (portal sends)');
select col_is_unique('public', 'sends', 'batch_key', 'T2 sends.batch_key is unique');
select fk_ok('public', 'sends', 'brand_id', 'public', 'brands', 'id', 'T2 sends.brand_id → brands.id');
select fk_ok('public', 'sends', 'campaign_id', 'public', 'campaigns', 'id', 'T2 sends.campaign_id → campaigns.id');

select has_table('public', 'send_recipients', 'T3 public.send_recipients exists');
select columns_are('public', 'send_recipients', array['send_id', 'brand_id', 'contact_id', 'external_id', 'address'], 'T3 send_recipients columns exactly the DDL sketch (incl. S6 brand_id)');
select col_is_pk('public', 'send_recipients', array['send_id', 'contact_id'], 'T3 send_recipients pk (send_id, contact_id)');
select fk_ok('public', 'send_recipients', 'send_id', 'public', 'sends', 'id', 'T3 send_recipients.send_id → sends.id');
select fk_ok('public', 'send_recipients', 'brand_id', 'public', 'brands', 'id', 'T3 send_recipients.brand_id → brands.id');
select fk_ok('public', 'send_recipients', 'contact_id', 'public', 'contacts', 'id', 'T3 send_recipients.contact_id → contacts.id');
-- FK actions: contact_id restricts (a recipient row pins its contact), send_id cascades.
select is((select c.confdeltype from pg_constraint c where c.conrelid = 'public.send_recipients'::regclass and c.contype = 'f'
           and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.send_recipients'::regclass and attname = 'contact_id')]),
          'r', 'T3 send_recipients.contact_id is on delete restrict');
select is((select c.confdeltype from pg_constraint c where c.conrelid = 'public.send_recipients'::regclass and c.contype = 'f'
           and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.send_recipients'::regclass and attname = 'send_id')]),
          'c', 'T3 send_recipients.send_id is on delete cascade');
select col_not_null('public', 'send_recipients', 'external_id', 'T3 send_recipients.external_id is not null');
select col_not_null('public', 'send_recipients', 'address', 'T3 send_recipients.address is not null');

select has_table('public', 'provider_batches', 'T4 public.provider_batches exists');
select columns_are('public', 'provider_batches',
  array['send_id', 'brand_id', 'batch_id', 'next_cursor', 'last_event_id', 'polling', 'last_polled_at', 'last_ok_at', 'created_at'],
  'T4 provider_batches columns exactly the DDL sketch (incl. S6 brand_id)');
select col_is_pk('public', 'provider_batches', 'send_id', 'T4 provider_batches.send_id is the primary key');
select fk_ok('public', 'provider_batches', 'send_id', 'public', 'sends', 'id', 'T4 provider_batches.send_id → sends.id');
select fk_ok('public', 'provider_batches', 'brand_id', 'public', 'brands', 'id', 'T4 provider_batches.brand_id → brands.id');
select is((select c.confdeltype from pg_constraint c where c.conrelid = 'public.provider_batches'::regclass and c.contype = 'f'
           and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.provider_batches'::regclass and attname = 'send_id')]),
          'c', 'T4 provider_batches.send_id is on delete cascade');
select col_is_unique('public', 'provider_batches', 'batch_id', 'T4 provider_batches.batch_id is unique');
select is(pg_temp.col_default('provider_batches', 'polling'), $$'active'::text$$, 'T4 provider_batches.polling defaults to active');

-- indexes: the partial unique index is the "one active send per campaign" rule (D-2).
select has_index('public', 'sends', 'uq_sends_one_active_per_campaign', array['campaign_id'], 'T5 uq_sends_one_active_per_campaign (campaign_id)');
select index_is_unique('public', 'sends', 'uq_sends_one_active_per_campaign', 'T5 uq_sends_one_active_per_campaign is unique');
select matches(pg_get_indexdef('public.uq_sends_one_active_per_campaign'::regclass),
  $$WHERE \(status <> ALL \(ARRAY\['complete'::send_status, 'partial'::send_status, 'failed'::send_status\]\)\)$$,
  'T5 uq_sends_one_active_per_campaign is partial: status not in (complete, partial, failed)');
select has_index('public', 'sends', 'idx_sends_brand_campaign_created', array['brand_id', 'campaign_id', 'created_at'], 'T5 idx_sends_brand_campaign_created');
select matches(pg_get_indexdef('public.idx_sends_brand_campaign_created'::regclass), 'created_at DESC', 'T5 idx_sends_brand_campaign_created is descending on created_at');
select has_index('public', 'sends', 'idx_sends_dispatch_pending', array['status', 'dispatch_lease_until'], 'T5 idx_sends_dispatch_pending');
select matches(pg_get_indexdef('public.idx_sends_dispatch_pending'::regclass), 'WHERE \(batch_id IS NULL\)', 'T5 idx_sends_dispatch_pending is partial on batch_id is null');

-- ============================================================================
-- P: RLS, policies, grants — SELECT only for authenticated, nothing for anon (FR20: append-only from the app).
-- ============================================================================
select ok(c.relrowsecurity and c.relforcerowsecurity, format('P1 RLS enabled + forced: public.%s', c.relname))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('sends', 'send_recipients', 'provider_batches') order by c.relname;
select policies_are('public', t, array[t || '_select_own_brand'], 'P2 ' || t || ': exactly one policy, ' || t || '_select_own_brand')
from unnest(array['sends', 'send_recipients', 'provider_batches']) as t;
select policy_cmd_is('public', t, t || '_select_own_brand', 'SELECT', 'P2 ' || t || '_select_own_brand is select-only')
from unnest(array['sends', 'send_recipients', 'provider_batches']) as t;
select policy_roles_are('public', t, t || '_select_own_brand', array['authenticated'], 'P2 ' || t || '_select_own_brand is for authenticated')
from unnest(array['sends', 'send_recipients', 'provider_batches']) as t;
-- the initplan wrapper matters: a bare current_brand_id() is evaluated per row.
select matches(p.qual, '^\(brand_id = \( SELECT current_brand_id\(\) AS current_brand_id\)\)$', 'P2 ' || p.tablename || ' policy is brand_id = (select current_brand_id())')
from pg_policies p where p.schemaname = 'public' and p.tablename in ('sends', 'send_recipients', 'provider_batches') order by p.tablename;

select table_privs_are('public', t, 'authenticated', array['SELECT'], 'P3 authenticated holds SELECT only on ' || t)
from unnest(array['sends', 'send_recipients', 'provider_batches']) as t;
select ok(not has_table_privilege('authenticated', format('public.%I', t), 'INSERT'), 'P3 authenticated has no INSERT on ' || t)
from unnest(array['sends', 'send_recipients', 'provider_batches']) as t;
select ok(not has_table_privilege('authenticated', format('public.%I', t), 'UPDATE'), 'P3 authenticated has no UPDATE on ' || t)
from unnest(array['sends', 'send_recipients', 'provider_batches']) as t;
select ok(not has_table_privilege('authenticated', format('public.%I', t), 'DELETE'), 'P3 authenticated has no DELETE on ' || t)
from unnest(array['sends', 'send_recipients', 'provider_batches']) as t;
select table_privs_are('public', t, 'anon', '{}'::text[], 'P3 anon holds nothing on ' || t)
from unnest(array['sends', 'send_recipients', 'provider_batches']) as t;

-- ============================================================================
-- F: the functions — shared predicate (internal, no grant) and the preview (secdef, authenticated only).
-- ============================================================================
select has_function('internal', 'recipient_classification', array['uuid'], 'F1 internal.recipient_classification(uuid) exists');
select ok(not has_function_privilege('authenticated', 'internal.recipient_classification(uuid)', 'execute'), 'F1 authenticated cannot execute recipient_classification');
select ok(not has_function_privilege('anon', 'internal.recipient_classification(uuid)', 'execute'), 'F1 anon cannot execute recipient_classification');
select ok(not has_function_privilege('public', 'internal.recipient_classification(uuid)', 'execute'), 'F1 PUBLIC cannot execute recipient_classification');
select is(p.prosecdef, false, 'F1 recipient_classification is security invoker')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'recipient_classification';

select has_function('public', 'recipient_preview', array['uuid'], 'F2 public.recipient_preview(uuid) exists');
select is(p.prosecdef, true, 'F2 recipient_preview is security definer')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'recipient_preview';
select ok(exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=""'), 'F2 recipient_preview pins search_path = ''''')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'recipient_preview';
select is(p.provolatile, 's', 'F2 recipient_preview is stable')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'recipient_preview';
select ok(has_function_privilege('authenticated', 'public.recipient_preview(uuid)', 'execute'), 'F2 authenticated may execute recipient_preview');
select ok(not has_function_privilege('anon', 'public.recipient_preview(uuid)', 'execute'), 'F2 anon may not execute recipient_preview');
select ok(not has_function_privilege('public', 'public.recipient_preview(uuid)', 'execute'), 'F2 PUBLIC may not execute recipient_preview');

-- ============================================================================
-- fixtures — brands A (with a signed-in analyst) and B, six contacts in A, four campaigns in A, one in B.
-- ============================================================================
create function pg_temp.fx() returns void language plpgsql as $$
declare
  ba uuid; bb uuid;
  ua uuid := '00000000-0000-4000-8000-0000000000f6';
begin
  insert into public.brands (code, name) values ('SENDTEST-A', 'Sends Test Brand A') returning id into ba;
  insert into public.brands (code, name) values ('SENDTEST-B', 'Sends Test Brand B') returning id into bb;
  perform set_config('sends.brand_a', ba::text, true);
  perform set_config('sends.brand_b', bb::text, true);
  perform set_config('sends.user_a', ua::text, true);

  insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (ua, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-sends@tenancy.test', '{}', '{}', now(), now());
  insert into public.app_users (email, brand_id, role, auth_user_id) values ('fixture-sends@tenancy.test', ba, 'analyst', ua);

  -- six contacts: external_id says what the row tests. Reasons are exclusive by priority
  -- (not_contactable → no_address → country), so the consent-false row carries a good address + KE and
  -- the no-email row is contactable + KE; the phone column makes the sms campaign count differently.
  insert into public.contacts (brand_id, external_id, email, phone, country, status, consent_marketing, deleted_at) values
    (ba, 'RC-recipient',      'ok@x.test',      '+254700000001', 'KE', 'active', true,  null),
    (ba, 'RC-consent-false',  'noconsent@x.test','+254700000002', 'KE', 'active', false, null),
    (ba, 'RC-no-email',       null,             '+254700000003', 'KE', 'active', true,  null),
    (ba, 'RC-country-ug',     'ug@x.test',      '+256700000004', 'UG', 'active', true,  null),
    (ba, 'RC-country-null',   'nowhere@x.test', null,            null, 'active', true,  null),
    (ba, 'RC-deleted',        'gone@x.test',    '+254700000006', 'KE', 'active', true,  now());
  -- brand B has its own contact so brand B's campaign would count something if the brand check ever leaked
  insert into public.contacts (brand_id, external_id, email, country, status, consent_marketing)
  values (bb, 'RC-B1', 'b1@x.test', 'KE', 'active', true);

  insert into public.campaigns (id, brand_id, external_id, name, channel, target_country, sent_at) values
    ('00000000-0000-4000-8000-00000000c001', ba, 'CMP-email-KE',   'Email to Kenya',   'email', 'KE', now()),
    ('00000000-0000-4000-8000-00000000c002', ba, 'CMP-sms-KE',     'SMS to Kenya',     'sms',   'KE', now()),
    ('00000000-0000-4000-8000-00000000c003', ba, 'CMP-email-any',  'Email, untargeted','email', null, now()),
    ('00000000-0000-4000-8000-00000000c004', ba, 'CMP-push',       'Push (unsupported)','push', 'KE', now()),
    ('00000000-0000-4000-8000-00000000c005', ba, 'CMP-nochannel',  'No channel',        null,   'KE', now()),
    ('00000000-0000-4000-8000-00000000c0b1', bb, 'CMP-B-email',    'Brand B email',    'email', 'KE', now());

  -- one finished send per brand (as the app will hold them after Story 4.5), with a recipient and a batch row
  insert into public.sends (id, brand_id, campaign_id, status, source, batch_key, recipient_count, batch_id) values
    ('00000000-0000-4000-8000-00000000d001', ba, '00000000-0000-4000-8000-00000000c001', 'complete', 'seed_send_log', 'SL-A1', 1, 'BATCH-A1'),
    ('00000000-0000-4000-8000-00000000d0b1', bb, '00000000-0000-4000-8000-00000000c0b1', 'complete', 'seed_send_log', 'SL-B1', 1, 'BATCH-B1');
  insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address) values
    ('00000000-0000-4000-8000-00000000d001', ba, (select id from public.contacts where brand_id = ba and external_id = 'RC-recipient'), 'RC-recipient', 'ok@x.test'),
    ('00000000-0000-4000-8000-00000000d0b1', bb, (select id from public.contacts where brand_id = bb and external_id = 'RC-B1'), 'RC-B1', 'b1@x.test');
  insert into public.provider_batches (send_id, brand_id, batch_id) values
    ('00000000-0000-4000-8000-00000000d001', ba, 'BATCH-A1'),
    ('00000000-0000-4000-8000-00000000d0b1', bb, 'BATCH-B1');
end $$;
select pg_temp.fx();

-- ============================================================================
-- C: constraints and the shared predicate — as postgres (BYPASSRLS), the seams the RPCs rely on.
-- ============================================================================
select throws_ok(
  $$ insert into public.sends (brand_id, campaign_id, source, recipient_count)
     values (current_setting('sends.brand_a')::uuid, '00000000-0000-4000-8000-00000000c001', 'portal', -1) $$,
  '23514', null, 'C1 recipient_count < 0 violates the check');
select throws_ok(
  $$ insert into public.provider_batches (send_id, brand_id, batch_id, polling)
     values ('00000000-0000-4000-8000-00000000d001', current_setting('sends.brand_a')::uuid, 'BATCH-X', 'paused') $$,
  '23514', null, 'C2 polling outside (active, quiet) violates the check');
-- one active send per campaign: a pending send beside the complete one is fine, a second pending is not.
select lives_ok(
  $$ insert into public.sends (id, brand_id, campaign_id, source, recipient_count)
     values ('00000000-0000-4000-8000-00000000d002', current_setting('sends.brand_a')::uuid, '00000000-0000-4000-8000-00000000c001', 'portal', 1) $$,
  'C3 a pending send can follow a complete send on the same campaign');
select throws_ok(
  $$ insert into public.sends (brand_id, campaign_id, source, recipient_count)
     values (current_setting('sends.brand_a')::uuid, '00000000-0000-4000-8000-00000000c001', 'portal', 1) $$,
  '23505', null, 'C4 a second active send on the same campaign violates uq_sends_one_active_per_campaign');
select throws_ok(
  $$ update public.sends set status = 'confirmed' where id = '00000000-0000-4000-8000-00000000d001' $$,
  '23505', null, 'C5 re-activating the complete send while another is active violates the partial index');
select is((select status::text from public.sends where id = '00000000-0000-4000-8000-00000000d002'), 'pending', 'C6 sends.status defaults to pending');
select is((select dispatch_attempts from public.sends where id = '00000000-0000-4000-8000-00000000d002'), 0, 'C6 sends.dispatch_attempts defaults to 0');
select throws_ok(
  $$ delete from public.contacts where external_id = 'RC-recipient' and brand_id = current_setting('sends.brand_a')::uuid $$,
  '23503', null, 'C7 a contact referenced by send_recipients cannot be deleted (on delete restrict)');
select throws_ok(
  $$ insert into public.sends (brand_id, campaign_id, source, batch_key, recipient_count)
     values (current_setting('sends.brand_b')::uuid, '00000000-0000-4000-8000-00000000c0b1', 'seed_send_log', 'SL-A1', 1) $$,
  '23505', null, 'C8 batch_key is unique across brands');
-- cascade: deleting the pending send removes nothing else (no children) — deleting a send with children removes them.
select lives_ok($$ delete from public.sends where id = '00000000-0000-4000-8000-00000000d002' $$, 'C9 the pending fixture send can be removed again');
insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, batch_id)
values ('00000000-0000-4000-8000-00000000d003', current_setting('sends.brand_a')::uuid, '00000000-0000-4000-8000-00000000c002', 'failed', 'portal', 1, 'BATCH-A3');
insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
values ('00000000-0000-4000-8000-00000000d003', current_setting('sends.brand_a')::uuid,
        (select id from public.contacts where brand_id = current_setting('sends.brand_a')::uuid and external_id = 'RC-recipient'), 'RC-recipient', '+254700000001');
insert into public.provider_batches (send_id, brand_id, batch_id) values ('00000000-0000-4000-8000-00000000d003', current_setting('sends.brand_a')::uuid, 'BATCH-A3');
select lives_ok($$ delete from public.sends where id = '00000000-0000-4000-8000-00000000d003' $$, 'C10 deleting a send cascades to send_recipients and provider_batches');
select is((select count(*) from public.send_recipients where send_id = '00000000-0000-4000-8000-00000000d003'), 0::bigint, 'C10 no orphan send_recipients');
select is((select count(*) from public.provider_batches where send_id = '00000000-0000-4000-8000-00000000d003'), 0::bigint, 'C10 no orphan provider_batches');

-- the shared predicate: one row per non-deleted contact of the campaign's brand, reason null = recipient.
select results_eq(
  $$ select external_id, address, reason from internal.recipient_classification('00000000-0000-4000-8000-00000000c001') order by external_id $$,
  $$ values ('RC-consent-false', 'noconsent@x.test', 'not_contactable'),
            ('RC-country-null',  'nowhere@x.test',   'country_mismatch_or_unknown'),
            ('RC-country-ug',    'ug@x.test',        'country_mismatch_or_unknown'),
            ('RC-no-email',      null::text,         'no_address'),
            ('RC-recipient',     'ok@x.test',        null::text) $$,
  'C11 recipient_classification email/KE: five non-deleted contacts, reasons exclusive by priority, deleted row absent');
select results_eq(
  $$ select external_id, address, reason from internal.recipient_classification('00000000-0000-4000-8000-00000000c002') order by external_id $$,
  $$ values ('RC-consent-false', '+254700000002', 'not_contactable'),
            ('RC-country-null',  null::text,      'no_address'),
            ('RC-country-ug',    '+256700000004', 'country_mismatch_or_unknown'),
            ('RC-no-email',      '+254700000003', null::text),
            ('RC-recipient',     '+254700000001', null::text) $$,
  'C12 recipient_classification sms/KE: address is the phone; no phone → no_address before country');
select is((select count(*) from internal.recipient_classification('00000000-0000-4000-8000-00000000c0b1')), 1::bigint, 'C13 brand B''s campaign classifies brand B''s contacts only');
select is((select count(*) from internal.recipient_classification('00000000-0000-4000-8000-000000000000')), 0::bigint, 'C14 unknown campaign → zero rows (the RPC raises before reaching here)');
-- string_agg (not a scalar subquery) so a leak reports the extra rows instead of aborting the transaction.
select is((select string_agg(c.external_id, ',' order by c.external_id)
           from internal.recipient_classification('00000000-0000-4000-8000-00000000c001') r
           join public.contacts c on c.id = r.contact_id where r.reason is null),
          'RC-recipient', 'C15 contact_id is the contacts row id (the one recipient joins back to RC-recipient)');

-- ============================================================================
-- A: as the signed-in analyst of brand A — the preview through the RPC, SELECT-only tables.
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('sends.user_a'), 'role', 'authenticated')::text, true);
select is(current_user::text, 'authenticated', 'A0 running as authenticated');
select is(public.current_brand_id(), current_setting('sends.brand_a')::uuid, 'A1 current_brand_id() is brand A');

select is(
  (select row(total_count, not_contactable, no_address, country_mismatch_or_unknown, channel, target_country)::text
   from public.recipient_preview('00000000-0000-4000-8000-00000000c001')),
  row(1::bigint, 1::bigint, 1::bigint, 2::bigint, 'email', 'KE')::text,
  'A2 email/KE preview: total 1, not_contactable 1, no_address 1, country_mismatch_or_unknown 2');
select is((select count(*) from public.recipient_preview('00000000-0000-4000-8000-00000000c001')), 1::bigint, 'A3 the preview is exactly one row');
select is(
  (select total_count + not_contactable + no_address + country_mismatch_or_unknown from public.recipient_preview('00000000-0000-4000-8000-00000000c001')),
  (select count(*) from public.contacts where deleted_at is null),
  'A4 the four counts sum to the brand''s non-deleted contacts (5; the deleted row is outside every bucket)');
select is(
  (select rule_text from public.recipient_preview('00000000-0000-4000-8000-00000000c001')),
  (select rule_text from public.metric_rules where key = 'recipients'),
  'A5 rule_text is metric_rules.recipients');
select isnt((select rule_text from public.recipient_preview('00000000-0000-4000-8000-00000000c001')), '', 'A5 rule_text is not blank');
select matches((select rule_text from public.recipient_preview('00000000-0000-4000-8000-00000000c001')), '^Contactable \*\*and\*\* valid address for the channel', 'A5 rule_text reads as the PRD §5 recipients rule');
select is(
  (select row(total_count, not_contactable, no_address, country_mismatch_or_unknown, channel, target_country)::text
   from public.recipient_preview('00000000-0000-4000-8000-00000000c002')),
  row(2::bigint, 1::bigint, 1::bigint, 1::bigint, 'sms', 'KE')::text,
  'A6 sms/KE preview counts phone: total 2, not_contactable 1, no_address 1 (no phone), country 1');
select is(
  (select row(total_count, not_contactable, no_address, country_mismatch_or_unknown, channel, target_country)::text
   from public.recipient_preview('00000000-0000-4000-8000-00000000c003')),
  row(3::bigint, 1::bigint, 1::bigint, 0::bigint, 'email', null::text)::text,
  'A7 untargeted email preview: no country exclusion (UG and null country are recipients)');
select throws_ok($$ select * from public.recipient_preview('00000000-0000-4000-8000-00000000c004') $$, 'P0001', 'invalid_input', 'A8 channel push → invalid_input');
select throws_ok($$ select * from public.recipient_preview('00000000-0000-4000-8000-00000000c005') $$, 'P0001', 'invalid_input', 'A9 null channel → invalid_input');
select throws_ok($$ select * from public.recipient_preview('00000000-0000-4000-8000-00000000c0b1') $$, 'P0001', 'not_in_brand', 'A10 brand B''s campaign → not_in_brand');
select throws_ok($$ select * from public.recipient_preview('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e') $$, 'P0001', 'not_in_brand', 'A11 random uuid → not_in_brand (indistinguishable from another brand''s)');
select throws_ok($$ select * from public.recipient_preview(null) $$, 'P0001', 'not_in_brand', 'A12 null campaign id → not_in_brand');

-- the tables: own brand readable, other brand invisible, no write path at all
select is((select count(*) from public.sends), 1::bigint, 'A13 sends: own brand''s send only');
select is((select string_agg(batch_key, ',') from public.sends), 'SL-A1', 'A13 sends: the visible row is brand A''s');
select is((select count(*) from public.send_recipients), 1::bigint, 'A14 send_recipients: own brand only');
select is((select count(*) from public.provider_batches), 1::bigint, 'A15 provider_batches: own brand only');
select is((select count(*) from public.sends where brand_id = current_setting('sends.brand_b')::uuid), 0::bigint, 'A16 brand B''s send is invisible');
select throws_ok(
  $$ insert into public.sends (brand_id, campaign_id, source, recipient_count)
     values (current_setting('sends.brand_a')::uuid, '00000000-0000-4000-8000-00000000c001', 'portal', 1) $$,
  '42501', null, 'A17 a plain insert into sends as authenticated is refused (no grant, forced RLS)');
select throws_ok($$ update public.sends set status = 'confirmed' $$, '42501', null, 'A18 update sends as authenticated is refused');
select throws_ok($$ delete from public.sends $$, '42501', null, 'A19 delete sends as authenticated is refused');
select throws_ok(
  $$ insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
     values ('00000000-0000-4000-8000-00000000d001', current_setting('sends.brand_a')::uuid, gen_random_uuid(), 'x', 'x') $$,
  '42501', null, 'A20 insert into send_recipients as authenticated is refused');
select throws_ok(
  $$ insert into public.provider_batches (send_id, brand_id, batch_id) values ('00000000-0000-4000-8000-00000000d001', current_setting('sends.brand_a')::uuid, 'X') $$,
  '42501', null, 'A21 insert into provider_batches as authenticated is refused');
select throws_ok($$ select * from internal.recipient_classification('00000000-0000-4000-8000-00000000c001') $$, '42501', null, 'A22 the internal predicate is not callable by authenticated');

-- two more contacts (as postgres, then back as the analyst):
--   RC-country-kenya — raw 'kenya' (never normalised by the importer) still matches KE through normalize_country;
--   RC-both          — consent false AND no email AND UG: exactly one bucket, not_contactable, pins the priority.
reset role;
select set_config('request.jwt.claims', '', true);
insert into public.contacts (brand_id, external_id, email, country, status, consent_marketing) values
  (current_setting('sends.brand_a')::uuid, 'RC-country-kenya', 'kenya@x.test', 'kenya', 'active', true),
  (current_setting('sends.brand_a')::uuid, 'RC-both',          null,           'UG',    'active', false);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('sends.user_a'), 'role', 'authenticated')::text, true);
select is(
  (select row(total_count, not_contactable, no_address, country_mismatch_or_unknown)::text from public.recipient_preview('00000000-0000-4000-8000-00000000c001')),
  row(2::bigint, 2::bigint, 1::bigint, 2::bigint)::text,
  'A23 raw ''kenya'' counts as KE (normalize_country); consent-false + no-email + UG lands in not_contactable only (priority)');
select is(
  (select total_count + not_contactable + no_address + country_mismatch_or_unknown from public.recipient_preview('00000000-0000-4000-8000-00000000c001')),
  (select count(*) from public.contacts where deleted_at is null),
  'A24 the four counts still reconcile (7) — every contact is in exactly one bucket');

-- anon: nothing
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
select throws_ok($$ select * from public.recipient_preview('00000000-0000-4000-8000-00000000c001') $$, '42501', null, 'N1 anon: permission denied on recipient_preview');
select throws_ok($$ select count(*) from public.sends $$, '42501', null, 'N2 anon: permission denied on sends');
select throws_ok($$ select count(*) from public.send_recipients $$, '42501', null, 'N3 anon: permission denied on send_recipients');
select throws_ok($$ select count(*) from public.provider_batches $$, '42501', null, 'N4 anon: permission denied on provider_batches');
reset role;

-- a signed-in user of no brand (unknown sub): the brand check refuses, the tables show nothing
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000000fe', 'role', 'authenticated')::text, true);
select is(public.current_brand_id(), null, 'U1 unknown user → current_brand_id() null');
select throws_ok($$ select * from public.recipient_preview('00000000-0000-4000-8000-00000000c001') $$, 'P0001', 'not_in_brand', 'U2 unknown user → not_in_brand (null brand never matches)');
select is((select count(*) from public.sends), 0::bigint, 'U3 unknown user sees no sends');
reset role;
select is(current_user::text, 'postgres', 'Z1 role restored before finish');

select * from finish();
rollback;
