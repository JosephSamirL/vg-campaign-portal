-- 0002_core_tables.test.sql — shape and privilege assertions for supabase/migrations/0002_core_tables.sql
-- (Story 2.1, architecture D-2 / D-4 / D-5, Story-Time Amendments S8, S12, S17).
--
-- Isolation itself is asserted by 0001_tenancy.test.sql (catalog-driven); this file pins the
-- contract later stories build on: the column set, the natural keys, the event vocabulary,
-- the indexes, the exact policy/grant surface, the staging tables, and the S17 default-privilege fix.
-- Runs as postgres via `supabase test db`; everything is inside one rolled-back transaction.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ============================================================================
-- T0: S17 default-privilege fix — a bare `create function` in public must reach nobody exposed.
-- ============================================================================
create function public.f_probe() returns int language sql as 'select 1';
select ok(not has_function_privilege('anon', 'public.f_probe()', 'execute'), 'T0 probe function: anon cannot execute');
select ok(not has_function_privilege('authenticated', 'public.f_probe()', 'execute'), 'T0 probe function: authenticated cannot execute');
select ok(not has_function_privilege('public', 'public.f_probe()', 'execute'), 'T0 probe function: PUBLIC cannot execute');
select ok(
  coalesce(array_to_string((select proacl from pg_proc where oid = 'public.f_probe()'::regprocedure), ','), '') !~ '(^|,)=X/',
  'T0 probe function: no PUBLIC entry in proacl');
drop function public.f_probe();

select ok(
  not exists (
    select 1 from pg_default_acl d
    where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
      and array_to_string(d.defaclacl, ',') ~ '(^|,)(=|anon=|authenticated=)[^/]*X'),
  'T0 schema-less default ACL for postgres functions grants nothing to PUBLIC/anon/authenticated');

-- The two tenancy helpers keep their explicit authenticated grant after the blanket revoke.
select ok(has_function_privilege('authenticated', 'public.current_brand_id()', 'execute'), 'T0 current_brand_id still executable by authenticated');
select ok(has_function_privilege('authenticated', 'public.current_app_role()', 'execute'), 'T0 current_app_role still executable by authenticated');

-- ============================================================================
-- T1: enums + normalize_event_type (AC #2)
-- ============================================================================
select has_enum('public', 'event_type', 'T1 enum public.event_type exists');
select enum_has_labels('public', 'event_type',
  array['delivered', 'bounced', 'opened', 'clicked', 'unsubscribed', 'complained', 'unknown'],
  'T1 event_type labels');
select has_enum('public', 'event_source', 'T1 enum public.event_source exists');
select enum_has_labels('public', 'event_source', array['seed', 'provider'], 'T1 event_source labels');

select has_function('public', 'normalize_event_type', array['text'], 'T1 normalize_event_type(text) exists');
select function_returns('public', 'normalize_event_type', array['text'], 'event_type', 'T1 normalize_event_type returns event_type');
select is(public.normalize_event_type('delivered'), 'delivered'::public.event_type, 'T1 delivered → delivered');
select is(public.normalize_event_type('bounce'), 'bounced'::public.event_type, 'T1 bounce → bounced');
select is(public.normalize_event_type('bounced'), 'bounced'::public.event_type, 'T1 bounced → bounced');
select is(public.normalize_event_type('open'), 'opened'::public.event_type, 'T1 open → opened');
select is(public.normalize_event_type('opened'), 'opened'::public.event_type, 'T1 opened → opened');
select is(public.normalize_event_type('click'), 'clicked'::public.event_type, 'T1 click → clicked');
select is(public.normalize_event_type('clicked'), 'clicked'::public.event_type, 'T1 clicked → clicked');
select is(public.normalize_event_type('unsubscribe'), 'unsubscribed'::public.event_type, 'T1 unsubscribe → unsubscribed');
select is(public.normalize_event_type('unsubscribed'), 'unsubscribed'::public.event_type, 'T1 unsubscribed → unsubscribed');
select is(public.normalize_event_type('complaint'), 'complained'::public.event_type, 'T1 complaint → complained');
select is(public.normalize_event_type('complained'), 'complained'::public.event_type, 'T1 complained → complained');
select is(public.normalize_event_type('  Bounce  '), 'bounced'::public.event_type, 'T1 btrim + case-insensitive: "  Bounce  " → bounced');
select is(public.normalize_event_type('OPENED'), 'opened'::public.event_type, 'T1 upper-case OPENED → opened');
select is(public.normalize_event_type('spam'), 'unknown'::public.event_type, 'T1 unmapped → unknown');
select is(public.normalize_event_type(''), 'unknown'::public.event_type, 'T1 empty → unknown');
select is(public.normalize_event_type(null), 'unknown'::public.event_type, 'T1 null → unknown');

select ok(not has_function_privilege('anon', 'public.normalize_event_type(text)', 'execute'), 'T1 normalize_event_type: anon cannot execute');
select ok(not has_function_privilege('authenticated', 'public.normalize_event_type(text)', 'execute'), 'T1 normalize_event_type: authenticated cannot execute');
select ok(not has_function_privilege('public', 'public.normalize_event_type(text)', 'execute'), 'T1 normalize_event_type: PUBLIC cannot execute');
select ok(not (select prosecdef from pg_proc where oid = 'public.normalize_event_type(text)'::regprocedure), 'T1 normalize_event_type is security invoker');

-- ============================================================================
-- T2: tables (AC #1)
-- ============================================================================
select has_table('public', 'contacts', 'T2 public.contacts exists');
select has_table('public', 'campaigns', 'T2 public.campaigns exists');
select has_table('public', 'events', 'T2 public.events exists');

-- brand_id is the first non-PK column (attnum 2) and references brands.
select is((select attname::text from pg_attribute where attrelid = 'public.contacts'::regclass and attnum = 2), 'brand_id', 'T2 contacts: brand_id is the first non-PK column');
select is((select attname::text from pg_attribute where attrelid = 'public.campaigns'::regclass and attnum = 2), 'brand_id', 'T2 campaigns: brand_id is the first non-PK column');
select is((select attname::text from pg_attribute where attrelid = 'public.events'::regclass and attnum = 2), 'brand_id', 'T2 events: brand_id is the first non-PK column');
select col_not_null('public', 'contacts', 'brand_id', 'T2 contacts.brand_id not null');
select col_not_null('public', 'campaigns', 'brand_id', 'T2 campaigns.brand_id not null');
select col_not_null('public', 'events', 'brand_id', 'T2 events.brand_id not null');
select fk_ok('public', 'contacts', 'brand_id', 'public', 'brands', 'id', 'T2 contacts.brand_id → brands.id');
select fk_ok('public', 'campaigns', 'brand_id', 'public', 'brands', 'id', 'T2 campaigns.brand_id → brands.id');
select fk_ok('public', 'events', 'brand_id', 'public', 'brands', 'id', 'T2 events.brand_id → brands.id');
select fk_ok('public', 'campaigns', 'parent_campaign_id', 'public', 'campaigns', 'id', 'T2 campaigns.parent_campaign_id → campaigns.id (self)');
select fk_ok('public', 'events', 'contact_id', 'public', 'contacts', 'id', 'T2 events.contact_id → contacts.id');
select fk_ok('public', 'events', 'campaign_id', 'public', 'campaigns', 'id', 'T2 events.campaign_id → campaigns.id');
select col_is_null('public', 'events', 'contact_id', 'T2 events.contact_id nullable (unresolvable recipient)');
select col_is_null('public', 'events', 'campaign_id', 'T2 events.campaign_id nullable');
select col_is_null('public', 'events', 'send_id', 'T2 events.send_id nullable (FK arrives with sends, Story 4.1)');

-- natural keys
select has_unique('public', 'contacts', 'T2 contacts has a unique constraint');
select has_index('public', 'contacts', 'uq_contacts_brand_id_external_id', array['brand_id', 'external_id'], 'T2 uq_contacts_brand_id_external_id (brand_id, external_id)');
select index_is_unique('public', 'contacts', 'uq_contacts_brand_id_external_id', 'T2 uq_contacts_brand_id_external_id is unique');
select has_index('public', 'campaigns', 'uq_campaigns_brand_id_external_id', array['brand_id', 'external_id'], 'T2 uq_campaigns_brand_id_external_id (brand_id, external_id)');
select index_is_unique('public', 'campaigns', 'uq_campaigns_brand_id_external_id', 'T2 uq_campaigns_brand_id_external_id is unique');
select has_index('public', 'events', 'uq_events_brand_id_source_event_id', array['brand_id', 'source', 'event_id'], 'T2 uq_events_brand_id_source_event_id (brand_id, source, event_id)');
select index_is_unique('public', 'events', 'uq_events_brand_id_source_event_id', 'T2 uq_events_brand_id_source_event_id is unique');

-- contacts columns (nullable-by-design ones stay nullable: unknown is null, never a sentinel)
select has_column('public', 'contacts', c, 'T2 contacts.' || c || ' exists')
from unnest(array['external_id', 'full_name', 'email', 'phone', 'country', 'city', 'signup_at', 'status', 'consent_marketing',
                  'deleted_at', 'suppressed_until', 'notes', 'suppressed_at', 'suppressed_reason', 'routed_from',
                  'as_of', 'file_rank', 'created_at', 'updated_at']) as c;
select col_is_null('public', 'contacts', c, 'T2 contacts.' || c || ' is nullable')
from unnest(array['status', 'consent_marketing', 'country', 'signup_at', 'suppressed_at', 'suppressed_reason', 'suppressed_until', 'deleted_at', 'routed_from']) as c;
select col_type_is('public', 'contacts', 'status', 'text', 'T2 contacts.status text');
select col_type_is('public', 'contacts', 'consent_marketing', 'boolean', 'T2 contacts.consent_marketing boolean');
select col_type_is('public', 'contacts', 'suppressed_at', 'timestamp with time zone', 'T2 contacts.suppressed_at timestamptz');
select col_type_is('public', 'contacts', 'as_of', 'date', 'T2 contacts.as_of date');
select col_type_is('public', 'contacts', 'file_rank', 'integer', 'T2 contacts.file_rank int');
select col_not_null('public', 'contacts', 'as_of', 'T2 contacts.as_of not null (defaulted so fixtures can insert)');
select col_not_null('public', 'contacts', 'file_rank', 'T2 contacts.file_rank not null');

-- campaigns columns
select has_column('public', 'campaigns', c, 'T2 campaigns.' || c || ' exists')
from unnest(array['external_id', 'name', 'channel', 'target_country', 'reported_sent', 'reported_delivered', 'reported_bounced',
                  'reported_opens', 'reported_clicks', 'spend', 'sent_at', 'send_local_time', 'parent_external_id',
                  'parent_campaign_id', 'as_of', 'file_rank', 'created_at', 'updated_at']) as c;

-- events columns
select has_column('public', 'events', c, 'T2 events.' || c || ' exists')
from unnest(array['source', 'event_id', 'type', 'contact_id', 'campaign_id', 'send_id', 'batch_id', 'channel', 'occurred_at', 'raw', 'created_at']) as c;
select ok((select atttypid = 'public.event_type'::regtype from pg_attribute where attrelid = 'public.events'::regclass and attname = 'type'), 'T2 events.type is public.event_type');
select ok((select atttypid = 'public.event_source'::regtype from pg_attribute where attrelid = 'public.events'::regclass and attname = 'source'), 'T2 events.source is public.event_source');
select col_type_is('public', 'events', 'raw', 'jsonb', 'T2 events.raw jsonb');
select col_type_is('public', 'events', 'occurred_at', 'timestamp with time zone', 'T2 events.occurred_at timestamptz');
select col_type_is('public', 'events', 'send_id', 'uuid', 'T2 events.send_id uuid');
select col_type_is('public', 'events', 'batch_id', 'text', 'T2 events.batch_id text');

-- ============================================================================
-- T3: indexes (AC #3)
-- ============================================================================
select is((select extnamespace::regnamespace::text from pg_extension where extname = 'pg_trgm'), 'extensions', 'T3 pg_trgm installed in schema extensions');
select has_index('public', 'contacts', 'idx_contacts_brand_id_signup_at', array['brand_id', 'signup_at'], 'T3 idx_contacts_brand_id_signup_at');
select has_index('public', 'contacts', 'idx_contacts_brand_id_email', array['brand_id', 'email'], 'T3 idx_contacts_brand_id_email');
select matches(pg_get_indexdef('public.idx_contacts_brand_id_email'::regclass), 'text_pattern_ops', 'T3 idx_contacts_brand_id_email uses text_pattern_ops');
select has_index('public', 'events', 'idx_events_brand_id_contact_id_type', array['brand_id', 'contact_id', 'type'], 'T3 idx_events_brand_id_contact_id_type');
select has_index('public', 'events', 'idx_events_brand_id_campaign_id_type', array['brand_id', 'campaign_id', 'type'], 'T3 idx_events_brand_id_campaign_id_type');
select has_index('public', 'campaigns', 'idx_campaigns_brand_id_sent_at', array['brand_id', 'sent_at'], 'T3 idx_campaigns_brand_id_sent_at');
select matches(pg_get_indexdef('public.idx_campaigns_brand_id_sent_at'::regclass), 'sent_at DESC', 'T3 idx_campaigns_brand_id_sent_at is descending on sent_at');
select has_index('public', 'contacts', 'idx_contacts_full_name_trgm', 'T3 idx_contacts_full_name_trgm exists');
select is((select am.amname::text from pg_class i join pg_am am on am.oid = i.relam where i.oid = 'public.idx_contacts_full_name_trgm'::regclass), 'gin', 'T3 idx_contacts_full_name_trgm is gin');
select matches(pg_get_indexdef('public.idx_contacts_full_name_trgm'::regclass), 'gin_trgm_ops', 'T3 idx_contacts_full_name_trgm uses gin_trgm_ops');

-- ============================================================================
-- T4: RLS, policies, grants (AC #4)
-- ============================================================================
select ok(c.relrowsecurity and c.relforcerowsecurity, 'T4 RLS enabled + forced: ' || t)
from unnest(array['contacts', 'campaigns', 'events']) as t
join pg_class c on c.oid = ('public.' || t)::regclass;

select policies_are('public', 'contacts', array['contacts_select_own_brand'], 'T4 contacts: exactly one policy');
select policies_are('public', 'campaigns', array['campaigns_select_own_brand'], 'T4 campaigns: exactly one policy');
select policies_are('public', 'events', array['events_select_own_brand'], 'T4 events: exactly one policy');
select policy_cmd_is('public', t, t || '_select_own_brand', 'SELECT', 'T4 ' || t || '_select_own_brand is select-only')
from unnest(array['contacts', 'campaigns', 'events']) as t;
select policy_roles_are('public', t, t || '_select_own_brand', array['authenticated'], 'T4 ' || t || '_select_own_brand is for authenticated')
from unnest(array['contacts', 'campaigns', 'events']) as t;
-- the initplan wrapper matters: a bare current_brand_id() is evaluated per row.
select matches(p.qual, '^\(brand_id = \( SELECT current_brand_id\(\) AS current_brand_id\)\)$', 'T4 ' || p.tablename || ' policy is brand_id = (select current_brand_id())')
from pg_policies p where p.schemaname = 'public' and p.tablename in ('contacts', 'campaigns', 'events') order by p.tablename;

select table_privs_are('public', t, 'authenticated', array['SELECT'], 'T4 authenticated holds SELECT only on ' || t)
from unnest(array['contacts', 'campaigns', 'events']) as t;
select table_privs_are('public', t, 'anon', '{}'::text[], 'T4 anon holds nothing on ' || t)
from unnest(array['contacts', 'campaigns', 'events']) as t;
-- sequences: events uses an identity column; anon/authenticated get no usage on it.
select ok(not has_sequence_privilege('anon', pg_get_serial_sequence('public.events', 'id'), 'USAGE,SELECT,UPDATE'), 'T4 anon has no privilege on the events id sequence');
select ok(not has_sequence_privilege('authenticated', pg_get_serial_sequence('public.events', 'id'), 'USAGE,SELECT,UPDATE'), 'T4 authenticated has no privilege on the events id sequence');

-- ============================================================================
-- T5: staging tables (AC #5)
-- ============================================================================
select has_table('staging', 'stage_' || t, 'T5 staging.stage_' || t || ' exists')
from unnest(array['contacts', 'campaigns', 'events', 'send_log']) as t;
select has_column('staging', 'stage_' || t, c, 'T5 staging.stage_' || t || '.' || c || ' exists')
from unnest(array['contacts', 'campaigns', 'events', 'send_log']) as t
cross join unnest(array['id', 'run_id', 'source_file', 'file_brand', 'row_no', 'ncols', 'cols', 'had_nul', 'as_of', 'file_rank']) as c;
select col_type_is('staging', 'stage_' || t, 'cols', 'text[]', 'T5 staging.stage_' || t || '.cols is text[]')
from unnest(array['contacts', 'campaigns', 'events', 'send_log']) as t;
select has_index('staging', 'stage_' || t, 'idx_stage_' || t || '_run_id', array['run_id'], 'T5 idx_stage_' || t || '_run_id')
from unnest(array['contacts', 'campaigns', 'events', 'send_log']) as t;
select table_privs_are('staging', 'stage_' || t, r, '{}'::text[], 'T5 ' || r || ' holds nothing on staging.stage_' || t)
from unnest(array['contacts', 'campaigns', 'events', 'send_log']) as t
cross join unnest(array['anon', 'authenticated']) as r;
select ok(not has_schema_privilege(r, 'staging', 'usage'), 'T5 ' || r || ' has no usage on schema staging')
from unnest(array['anon', 'authenticated']) as r;
select is((select count(*) from pg_policies where schemaname = 'staging'), 0::bigint, 'T5 no policies in staging (not exposed; no grants)');

select * from finish();
rollback;
