-- 0005_metrics.test.sql — one definition of every number (Story 3.1; D-4, D-5; amendments #1, #9, S5, S12).
--
-- Synthetic brand + contacts + campaigns under one transaction, rolled back — the local seed data is
-- never touched. Pins: the is_contactable truth table (blank status counts, bounced / unsubscribed /
-- future suppression / null consent / suppressed_at do not), the inlinable shape of the predicate
-- (security invoker, no proconfig), the nine metric_rules rows behind RLS, the four security_invoker
-- views, nullif denominators (sent = 0 → null, no error), the unclamped open rate (KIL-0016's real
-- 12,679 / 10,640 → 119.16), and the explicit 30-day UTC window with future-dated rows excluded but counted.

begin;
create extension if not exists pgtap with schema extensions;
select plan(102);

-- ============================================================================
-- T: shape — is_contactable, metric_rules, the four views, grants.
-- ============================================================================
select has_function('public', 'is_contactable', array['public.contacts'], 'T1 public.is_contactable(contacts) exists');
select is(p.prosecdef, false, 'T2 is_contactable is security invoker (prosecdef = false)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'is_contactable';
select is(p.proconfig, null, 'T3 is_contactable has no proconfig (no set search_path — stays inlinable)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'is_contactable';
select is(p.provolatile, 's', 'T4 is_contactable is stable')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'is_contactable';
select is(l.lanname, 'sql', 'T5 is_contactable is language sql')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
where n.nspname = 'public' and p.proname = 'is_contactable';
select ok(has_function_privilege('authenticated', 'public.is_contactable(public.contacts)', 'execute'), 'T6 authenticated may execute is_contactable');
select ok(not has_function_privilege('anon', 'public.is_contactable(public.contacts)', 'execute'), 'T7 anon may not execute is_contactable');

select has_table('public', 'metric_rules', 'T8 public.metric_rules exists');
select columns_are('public', 'metric_rules', array['key', 'label', 'rule_text', 'alternative_text'], 'T9 metric_rules columns');
select col_is_pk('public', 'metric_rules', 'key', 'T10 metric_rules.key is the primary key');
select ok(c.relrowsecurity and c.relforcerowsecurity, 'T11 metric_rules RLS enabled + forced')
from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'metric_rules';
select is(
  (select row(p.cmd, p.roles::text[], p.qual)::text from pg_policies p where p.schemaname = 'public' and p.tablename = 'metric_rules' and p.policyname = 'metric_rules_select_signed_in'),
  row('SELECT', array['authenticated'], '(auth.uid() IS NOT NULL)')::text,
  'T12 policy metric_rules_select_signed_in: select, to authenticated, using auth.uid() is not null');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'metric_rules'), 1::bigint, 'T13 metric_rules has exactly one policy');
select ok(has_table_privilege('authenticated', 'public.metric_rules', 'SELECT'), 'T14 authenticated may select metric_rules');
select ok(not has_table_privilege('authenticated', 'public.metric_rules', 'INSERT,UPDATE,DELETE,TRUNCATE'), 'T15 authenticated cannot write metric_rules');
select ok(not has_table_privilege('anon', 'public.metric_rules', 'SELECT,INSERT,UPDATE,DELETE'), 'T16 anon holds nothing on metric_rules');

select has_view('public', v, format('T17 view public.%s exists', v))
from unnest(array['v_dashboard_totals', 'v_signups_30d', 'v_campaign_performance', 'v_contacts']) v;
select ok(
  exists (select 1 from pg_options_to_table(c.reloptions) o where o.option_name = 'security_invoker' and o.option_value in ('true', 'on', '1')),
  format('T18 security_invoker = true: public.%s', c.relname))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('v_dashboard_totals', 'v_signups_30d', 'v_campaign_performance', 'v_contacts')
order by c.relname;
select ok(has_table_privilege('authenticated', format('public.%I', v), 'SELECT') and not has_table_privilege('anon', format('public.%I', v), 'SELECT'),
          format('T19 select granted to authenticated only: public.%s', v))
from unnest(array['v_dashboard_totals', 'v_signups_30d', 'v_campaign_performance', 'v_contacts']) v;

select columns_are('public', 'v_dashboard_totals', array['brand_id', 'total_customers', 'contactable'], 'T20 v_dashboard_totals columns');
select columns_are('public', 'v_signups_30d', array['brand_id', 'day', 'signups', 'window_start', 'window_end', 'future_dated_count'], 'T21 v_signups_30d columns');
select columns_are('public', 'v_campaign_performance',
  array['brand_id', 'campaign_id', 'external_id', 'name', 'channel', 'sent_at', 'spend', 'target_country', 'source', 'send_id',
        'sent', 'delivered', 'bounced', 'opens', 'clicks', 'unsubscribes',
        'delivered_rate', 'bounce_rate', 'open_rate', 'click_rate', 'unsubscribe_rate', 'dispatched_at'],
  'T22 v_campaign_performance columns (Story 3.1''s list + dispatched_at appended by Story 6.2''s portal rows)');
select columns_are('public', 'v_contacts',
  array['id', 'brand_id', 'external_id', 'full_name', 'email', 'phone', 'country', 'city', 'status', 'consent_marketing',
        'signup_at', 'suppressed_at', 'suppressed_reason', 'suppressed_until', 'contactable'],
  'T23 v_contacts columns');
-- unbounded numeric: the rates carry no typmod (numeric(5,2) would overflow at 1000 %).
select ok(a.atttypid = 'numeric'::regtype and a.atttypmod = -1, format('T24 rate is unbounded numeric: v_campaign_performance.%s', a.attname))
from pg_attribute a
where a.attrelid = 'public.v_campaign_performance'::regclass
  and a.attname in ('delivered_rate', 'bounce_rate', 'open_rate', 'click_rate', 'unsubscribe_rate')
order by a.attname;

-- ============================================================================
-- R: metric_rules rows — the nine PRD §5 keys, verbatim text spot-checked.
-- ============================================================================
select is((select count(*) from public.metric_rules), 9::bigint, 'R1 nine metric_rules rows');
select set_eq(
  $$ select key from public.metric_rules $$,
  array['total_customers', 'contactable', 'signups_30d', 'delivered_rate', 'bounce_rate', 'open_rate', 'click_rate', 'unsubscribe_rate', 'recipients'],
  'R2 metric_rules keys are exactly the nine PRD §5 numbers');
select is((select label from public.metric_rules where key = 'open_rate'), 'Open rate', 'R3 open_rate label');
select is((select rule_text from public.metric_rules where key = 'open_rate'),
  '`open rate = opens ÷ sent` (**total** opens — can exceed 100%, caption says so). Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked',
  'R4 open_rate rule_text verbatim (total opens, can exceed 100%)');
select is((select alternative_text from public.metric_rules where key = 'contactable'),
  'Consent-only, or ignoring seed events (11.9k Kilele contacts differ)', 'R5 contactable alternative_text verbatim');
select is((select rule_text from public.metric_rules where key = 'signups_30d'),
  'Count by `signup_at` UTC date over the 30 calendar days ending today, zero-filled; future-dated signups excluded from the chart and counted in the caption; the exact date window is shown',
  'R6 signups_30d rule_text verbatim');
select ok(not exists (select 1 from public.metric_rules where label = '' or rule_text = '' or alternative_text = ''), 'R7 no metric_rules text is blank');

-- ============================================================================
-- fixtures — one synthetic brand, one signed-in user, contacts per truth-table row, campaigns.
-- ============================================================================
create function pg_temp.fx() returns void language plpgsql as $$
declare
  b uuid;
  u uuid := '00000000-0000-4000-8000-0000000000f5';
  we date := (now() at time zone 'utc')::date;
begin
  insert into public.brands (code, name) values ('METRICTEST', 'Metrics Test Brand') returning id into b;
  perform set_config('metrics.brand', b::text, true);
  perform set_config('metrics.user', u::text, true);
  perform set_config('metrics.window_end', we::text, true);

  insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-metrics@tenancy.test', '{}', '{}', now(), now());
  insert into public.app_users (email, brand_id, role, auth_user_id) values ('fixture-metrics@tenancy.test', b, 'analyst', u);

  -- truth table: external_id says what the row tests; signup_at far in the past so the window block is unaffected
  insert into public.contacts (brand_id, external_id, email, status, consent_marketing, suppressed_until, suppressed_at, suppressed_reason, deleted_at, signup_at) values
    (b, 'TT-blank-status',        'a@x.test', null,           true,  null,                  null,  null,      null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-active',              'b@x.test', 'active',       true,  null,                  null,  null,      null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-pending',             'c@x.test', 'pending',      true,  null,                  null,  null,      null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-suppressed-past',     'd@x.test', 'active',       true,  now() - interval '1 day', null, null,    null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-bounced',             'e@x.test', 'bounced',      true,  null,                  null,  null,      null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-unsubscribed',        'f@x.test', 'unsubscribed', true,  null,                  null,  null,      null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-suppressed-future',   'g@x.test', 'active',       true,  now() + interval '1 day', null, null,    null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-consent-null',        'h@x.test', 'active',       null,  null,                  null,  null,      null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-consent-false',       'i@x.test', 'active',       false, null,                  null,  null,      null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-suppressed-at',       'j@x.test', 'active',       true,  null,                  now(), 'bounced', null,  '2025-01-01T00:00:00Z'),
    (b, 'TT-deleted',             'k@x.test', 'active',       true,  null,                  null,  null,      now(), '2025-01-01T00:00:00Z');

  -- window rows (consent false so the contactable count above stays at 4)
  insert into public.contacts (brand_id, external_id, status, consent_marketing, signup_at) values
    (b, 'W-today',      'active', false, now()),
    (b, 'W-day-29-in',  'active', false, now() - interval '29 days'),
    (b, 'W-day-30-out', 'active', false, now() - interval '30 days'),
    (b, 'W-future',     'active', false, now() + interval '2 days');
  -- a deleted future-dated row is neither charted nor counted
  insert into public.contacts (brand_id, external_id, status, consent_marketing, signup_at, deleted_at) values
    (b, 'W-future-deleted', 'active', false, now() + interval '3 days', now());

  insert into public.campaigns (brand_id, external_id, name, channel, sent_at, spend, target_country, reported_sent, reported_delivered, reported_bounced, reported_opens, reported_clicks) values
    (b, 'CMP-zero',  'Zero sent',  'email', '2026-03-01T10:00:00Z', 0,     'KE', 0,     0,     0,   0,     0),
    (b, 'CMP-0016',  'KIL-0016 twin', 'email', '2026-03-02T10:00:00Z', 1420, 'KE', 10640, 10214, 426, 12679, 1183),
    (b, 'CMP-null',  'No report',  'sms',   '2026-03-03T10:00:00Z', null,  null, null,  null,  null, null,  null);
end $$;
select pg_temp.fx();

-- ============================================================================
-- C: is_contactable truth table (as postgres — RLS is forced but postgres bypasses it as superuser).
-- ============================================================================
select is(public.is_contactable(c), true,  'C1 blank status + consent → contactable (coalesce, never null)') from public.contacts c where c.external_id = 'TT-blank-status' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), true,  'C2 active + consent → contactable') from public.contacts c where c.external_id = 'TT-active' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), true,  'C3 pending counts as contactable') from public.contacts c where c.external_id = 'TT-pending' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), true,  'C4 suppressed_until in the past → contactable') from public.contacts c where c.external_id = 'TT-suppressed-past' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), false, 'C5 bounced → not contactable') from public.contacts c where c.external_id = 'TT-bounced' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), false, 'C6 unsubscribed → not contactable') from public.contacts c where c.external_id = 'TT-unsubscribed' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), false, 'C7 suppressed_until in the future → not contactable') from public.contacts c where c.external_id = 'TT-suppressed-future' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), false, 'C8 consent_marketing null → not contactable') from public.contacts c where c.external_id = 'TT-consent-null' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), false, 'C9 consent_marketing false → not contactable') from public.contacts c where c.external_id = 'TT-consent-false' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), false, 'C10 suppressed_at set → not contactable') from public.contacts c where c.external_id = 'TT-suppressed-at' and c.brand_id = current_setting('metrics.brand')::uuid;
select is(public.is_contactable(c), false, 'C11 deleted_at set → not contactable') from public.contacts c where c.external_id = 'TT-deleted' and c.brand_id = current_setting('metrics.brand')::uuid;
-- the predicate never returns null (a null would silently drop rows from a filter)
select is((select count(*) from public.contacts c where c.brand_id = current_setting('metrics.brand')::uuid and public.is_contactable(c) is null), 0::bigint, 'C12 is_contactable is never null');
-- inlining: the planner expands the SQL function into the scan filter instead of calling it per row.
create function pg_temp.plan_of(q text) returns text language plpgsql as $$
declare l text; out text := '';
begin
  for l in execute 'explain (costs off) ' || q loop out := out || l || E'\n'; end loop;
  return out;
end $$;
select ok(pg_temp.plan_of('select count(*) from public.contacts c where public.is_contactable(c)') !~ 'is_contactable',
          'C13 is_contactable is inlined (no function call in the plan)');

-- ============================================================================
-- V: views as postgres — exact numbers for the synthetic brand.
-- ============================================================================
select is((select row(total_customers, contactable)::text from public.v_dashboard_totals where brand_id = current_setting('metrics.brand')::uuid),
          row(14::bigint, 4::bigint)::text, 'V1 v_dashboard_totals: 14 non-deleted contacts, 4 contactable (2 deleted rows excluded)');

-- campaign rates
select is((select row(sent, delivered, bounced, opens, clicks, delivered_rate, bounce_rate, open_rate, click_rate)::text
           from public.v_campaign_performance where brand_id = current_setting('metrics.brand')::uuid and external_id = 'CMP-zero'),
          row(0, 0, 0, 0, 0, null::numeric, null::numeric, null::numeric, null::numeric)::text,
          'V2 sent = 0 → every rate is null (nullif denominator, no division error)');
select lives_ok($$ select * from public.v_campaign_performance $$, 'V3 selecting the performance view never raises on zero / null sent');
select is((select open_rate from public.v_campaign_performance where brand_id = current_setting('metrics.brand')::uuid and external_id = 'CMP-0016'),
          119.16::numeric, 'V4 open rate 12,679 / 10,640 = 119.16, unclamped');
select is((select row(delivered_rate, bounce_rate, click_rate)::text from public.v_campaign_performance where brand_id = current_setting('metrics.brand')::uuid and external_id = 'CMP-0016'),
          row(96.00::numeric, 4.00::numeric, 11.12::numeric)::text, 'V5 delivered / bounce / click rates over sent, two decimals');
select is((select row(sent, delivered_rate, open_rate)::text from public.v_campaign_performance where brand_id = current_setting('metrics.brand')::uuid and external_id = 'CMP-null'),
          row(null::int, null::numeric, null::numeric)::text, 'V6 null reported counts → null rates');
select is((select row(source, send_id, unsubscribes, unsubscribe_rate)::text from public.v_campaign_performance where brand_id = current_setting('metrics.brand')::uuid and external_id = 'CMP-0016'),
          row('reported', null::uuid, null::bigint, null::numeric)::text, 'V7 reported row: source = reported, send_id / unsubscribes / unsubscribe_rate null');
select is((select count(*) from public.v_campaign_performance where brand_id = current_setting('metrics.brand')::uuid), 3::bigint, 'V8 one reported row per campaign');
select ok((select 100.0 * 12679 / nullif(10640, 0)) > 100, 'V9 an open rate above 100 % is representable (no clamp anywhere)');
select ok((select round(100.0 * 999999 / nullif(1, 0), 2)) = 99999900.00, 'V10 unbounded numeric: a 99,999,900 % rate does not overflow');

-- window
select is((select count(*) from public.v_signups_30d where brand_id = current_setting('metrics.brand')::uuid), 30::bigint, 'V11 v_signups_30d: exactly 30 rows for the brand');
select is((select count(distinct day) from public.v_signups_30d where brand_id = current_setting('metrics.brand')::uuid), 30::bigint, 'V12 30 distinct days');
select is((select row(min(window_start), max(window_start), min(window_end), max(window_end))::text from public.v_signups_30d where brand_id = current_setting('metrics.brand')::uuid),
          row(current_setting('metrics.window_end')::date - 29, current_setting('metrics.window_end')::date - 29, current_setting('metrics.window_end')::date, current_setting('metrics.window_end')::date)::text,
          'V13 window_start = today UTC − 29, window_end = today UTC, identical on every row');
select is((select row(min(day), max(day))::text from public.v_signups_30d where brand_id = current_setting('metrics.brand')::uuid),
          row(current_setting('metrics.window_end')::date - 29, current_setting('metrics.window_end')::date)::text, 'V14 days run from window_start to window_end');
select is((select sum(signups) from public.v_signups_30d where brand_id = current_setting('metrics.brand')::uuid), 2::numeric, 'V15 two signups in the window (today and day −29); day −30 and the future row excluded');
select is((select signups from public.v_signups_30d where brand_id = current_setting('metrics.brand')::uuid and day = current_setting('metrics.window_end')::date), 1::bigint, 'V16 today has 1 signup');
select is((select signups from public.v_signups_30d where brand_id = current_setting('metrics.brand')::uuid and day = current_setting('metrics.window_end')::date - 29), 1::bigint, 'V17 the first day of the window has 1 signup (day −29 is in)');
select is((select count(*) from public.v_signups_30d where brand_id = current_setting('metrics.brand')::uuid and signups = 0), 28::bigint, 'V18 the other 28 days are zero-filled');
select is((select row(min(future_dated_count), max(future_dated_count))::text from public.v_signups_30d where brand_id = current_setting('metrics.brand')::uuid),
          row(1::bigint, 1::bigint)::text, 'V19 future_dated_count = 1 on every row (the deleted future row is not counted)');
select is((select pg_typeof(signups)::text from public.v_signups_30d limit 1), 'bigint', 'V20 signups is bigint');

-- v_contacts
select is((select count(*) from public.v_contacts where brand_id = current_setting('metrics.brand')::uuid), 14::bigint, 'V21 v_contacts hides deleted rows (14 of 16)');
select is((select count(*) from public.v_contacts where brand_id = current_setting('metrics.brand')::uuid and contactable), 4::bigint, 'V22 v_contacts.contactable = is_contactable (4)');
select is((select string_agg(external_id, ',' order by external_id) from public.v_contacts where brand_id = current_setting('metrics.brand')::uuid and contactable),
          'TT-active,TT-blank-status,TT-pending,TT-suppressed-past', 'V23 exactly the four contactable rows');
select is((select row(status, consent_marketing, suppressed_reason)::text from public.v_contacts where brand_id = current_setting('metrics.brand')::uuid and external_id = 'TT-suppressed-at'),
          row('active', true, 'bounced')::text, 'V24 v_contacts carries suppression columns');

-- ============================================================================
-- A: as the signed-in fixture user (RLS through security_invoker) — only the synthetic brand is visible.
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('metrics.user'), 'role', 'authenticated')::text, true);

select is(current_user::text, 'authenticated', 'A0 running as authenticated');
select is(public.current_brand_id(), current_setting('metrics.brand')::uuid, 'A1 current_brand_id() is the synthetic brand');
select is((select count(*) from public.metric_rules), 9::bigint, 'A2 a signed-in user reads all nine metric_rules');
select is((select count(*) from public.v_dashboard_totals), 1::bigint, 'A3 v_dashboard_totals: one row, own brand only');
select is((select row(total_customers, contactable)::text from public.v_dashboard_totals), row(14::bigint, 4::bigint)::text, 'A4 same totals through RLS');
select is((select count(*) from public.v_signups_30d), 30::bigint, 'A5 v_signups_30d: 30 rows, own brand only (brands policy scopes the cross join)');
select is((select count(distinct brand_id) from public.v_signups_30d), 1::bigint, 'A6 v_signups_30d: exactly one brand visible');
select is((select count(*) from public.v_campaign_performance), 3::bigint, 'A7 v_campaign_performance: own campaigns only');
select is((select count(*) from public.v_contacts), 14::bigint, 'A8 v_contacts: own non-deleted contacts only');
select is((select count(*) from public.v_contacts where brand_id <> current_setting('metrics.brand')::uuid), 0::bigint, 'A9 no other brand''s contacts');
select is((select count(*) from public.contacts c where public.is_contactable(c)), 4::bigint, 'A10 is_contactable is callable by authenticated');
select is((select open_rate from public.v_campaign_performance where external_id = 'CMP-0016'), 119.16::numeric, 'A11 119.16 through the view as the user');

-- anon: nothing
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
select throws_ok($$ select count(*) from public.metric_rules $$, '42501', null, 'A12 anon: permission denied on metric_rules');
select throws_ok($$ select count(*) from public.v_contacts $$, '42501', null, 'A13 anon: permission denied on v_contacts');
select throws_ok($$ select count(*) from public.v_dashboard_totals $$, '42501', null, 'A14 anon: permission denied on v_dashboard_totals');
reset role;

-- a signed-in user of another brand sees nothing of the synthetic brand
-- (the tenancy suite's fixture user B is not present here; a JWT for an unknown sub → current_brand_id() null)
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000000fe', 'role', 'authenticated')::text, true);
select is(public.current_brand_id(), null, 'A15 unknown user → current_brand_id() null');
select is((select count(*) from public.v_dashboard_totals), 0::bigint, 'A16 unknown user sees no totals');
select is((select count(*) from public.v_signups_30d), 0::bigint, 'A17 unknown user sees no window rows');
select is((select count(*) from public.v_contacts), 0::bigint, 'A18 unknown user sees no contacts');
select is((select count(*) from public.metric_rules), 9::bigint, 'A19 metric_rules is shared: any signed-in user reads the nine rules');
reset role;
select is(current_user::text, 'postgres', 'A20 role restored before finish');

select * from finish();
rollback;
