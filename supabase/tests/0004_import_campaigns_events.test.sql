-- 0004_import_campaigns_events.test.sql — the campaigns and events importers (Story 2.4; D-3, D-4, S16, S18).
--
-- Synthetic staging rows under one transaction, rolled back — the local seed data is never touched.
-- Campaigns: spend with a decimal comma, in-file duplicates, parent resolved only within the brand
-- (parent_not_in_brand / parent_unknown), channel / country normalisation, re-run → inserted 0.
-- Events: contact only in another brand → reject; contact routed out of the file brand → the event
-- follows it; unknown campaign → null + warn (never looked up by external_id alone); type vocabulary;
-- in-file duplicate → one row + warn; re-run → inserted 0, already_present = n.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ============================================================================
-- T: shape — the four new internal functions; nothing new in public.
-- ============================================================================
select has_function('internal', 'normalize_spend', array['text'], 'T1 internal.normalize_spend(text) exists');
select has_function('internal', 'normalize_int', array['text'], 'T2 internal.normalize_int(text) exists');
select has_function('internal', 'import_campaigns', array['uuid'], 'T3 internal.import_campaigns(uuid) exists');
select has_function('internal', 'import_events', array['uuid'], 'T4 internal.import_events(uuid) exists');
select ok(p.provolatile = 'i' and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'),
          format('T5 immutable + search_path pinned: internal.%s', p.proname))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'internal' and p.proname in ('normalize_spend', 'normalize_int') order by p.proname;
select ok(exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'), format('T6 search_path pinned: internal.%s', p.proname))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'internal' and p.proname in ('import_campaigns', 'import_events') order by p.proname;
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'internal' and p.prosecdef), 'T7 nothing in internal is security definer');
select ok(not has_function_privilege('anon', 'internal.import_events(uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'internal.import_events(uuid)', 'EXECUTE'), 'T8 importers are not executable by exposed roles');

-- ============================================================================
-- N: the two new normalisers.
-- ============================================================================
select is(internal.normalize_spend(v), r, format('N1 spend %L → %s', v, r))
from (values ('221,09', 221.09), ('221.09', 221.09), (' 1420.00 ', 1420.00), ('0', 0), ('0,5', 0.5), ('-3,25', -3.25), ('12', 12)) t(v, r);
select is(internal.normalize_spend(v), null, format('N2 spend %L → null', v))
from unnest(array['', '  ', 'abc', '1.2.3', '1,000.50', '12e3', '$12', null]) v;
select is(internal.normalize_int(v), r, format('N3 int %L → %s', v, r))
from (values ('0', 0), ('19000', 19000), (' 42 ', 42), ('2147483647', 2147483647)) t(v, r);
select is(internal.normalize_int(v), null, format('N4 int %L → null', v))
from unnest(array['', ' ', '-1', '1.0', '1,000', 'n/a', '1e3', '2147483648', '99999999999', null]) v;

-- ============================================================================
-- helpers
-- ============================================================================
create function pg_temp.krec(
  p_ext text, p_name text default 'Campaign', p_channel text default 'email', p_country text default 'KE',
  p_sent text default '100', p_delivered text default '90', p_bounced text default '10', p_opens text default '50', p_clicks text default '20',
  p_spend text default '12.50', p_sent_at text default '2026-03-01T10:00:00Z', p_slt text default '2026-03-01 13:00', p_parent text default ''
) returns text[] language sql immutable as $$
  select array[p_ext, p_name, p_channel, p_country, p_sent, p_delivered, p_bounced, p_opens, p_clicks, p_spend, p_sent_at, p_slt, p_parent]
$$;
create function pg_temp.kstage(
  p_run uuid, p_row int, p_cols text[], p_had_nul boolean default false,
  p_brand text default 'KILELE', p_as_of date default '2026-08-01', p_rank int default 10, p_file text default 'test-campaigns.csv'
) returns void language sql as $$
  insert into staging.stage_campaigns (run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank)
  values (p_run, p_file, p_brand, p_row, coalesce(array_length(p_cols, 1), 0), p_cols, p_had_nul, p_as_of, p_rank)
$$;
create function pg_temp.erec(
  p_ext text, p_contact text default 'CA', p_campaign text default 'K1', p_type text default 'open', p_channel text default 'email',
  p_at text default '2026-03-02T08:00:00.123456Z'
) returns text[] language sql immutable as $$
  select array[p_ext, p_contact, p_campaign, p_type, p_channel, p_at]
$$;
create function pg_temp.estage(
  p_run uuid, p_row int, p_cols text[], p_had_nul boolean default false,
  p_brand text default 'KILELE', p_as_of date default '2026-08-01', p_rank int default 10, p_file text default 'test-events.csv'
) returns void language sql as $$
  insert into staging.stage_events (run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank)
  values (p_run, p_file, p_brand, p_row, coalesce(array_length(p_cols, 1), 0), p_cols, p_had_nul, p_as_of, p_rank)
$$;
create function pg_temp.brand(p_code text) returns uuid language sql stable as $$ select id from public.brands where code = p_code $$;
create function pg_temp.campaign(p_brand text, p_ext text) returns public.campaigns language sql stable as $$
  select c from public.campaigns c where c.brand_id = pg_temp.brand(p_brand) and c.external_id = p_ext
$$;
create function pg_temp.event(p_ext text) returns public.events language sql stable as $$
  select e from public.events e where e.source = 'seed' and e.event_id = p_ext and e.brand_id in (pg_temp.brand('KILELE'), pg_temp.brand('KAROO'))
$$;
create function pg_temp.reasons(p_run uuid, p_sev public.issue_severity, p_row int) returns text language sql stable as $$
  select string_agg(reason, ',' order by reason) from public.import_issues where run_id = p_run and severity = p_sev and row_no is not distinct from p_row
$$;

-- ============================================================================
-- K: import_campaigns on synthetic rows.
-- ============================================================================
select throws_ok($$ select internal.import_campaigns('00000000-0000-4000-8000-0000000000c0') $$, 'invalid_input', 'K0 empty run → invalid_input');

-- pre-existing: a KAROO campaign B1 (the cross-brand parent target) and a newer KILELE row PRE (must stay unchanged).
insert into public.campaigns (brand_id, external_id, name, channel, as_of, file_rank)
values (pg_temp.brand('KAROO'),  'B1',  'karoo b1', 'email', '2026-08-01', 10),
       (pg_temp.brand('KILELE'), 'PRE', 'newer',    'sms',   '2026-09-01', 20);

-- ---- run c1: KILELE campaigns (as_of 2026-08-01, rank 10) ----
select pg_temp.kstage(r, 2,  (pg_temp.krec('C12'))[1:12])                                           from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- wrong_column_count
select pg_temp.kstage(r, 3,  array['external_id','name','channel','target_country','reported_sent','reported_delivered','reported_bounced','reported_opens','reported_clicks','spend','sent_at','send_local_time','parent_external_id'])
                                                                                                    from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- repeated_header
select pg_temp.kstage(r, 4,  pg_temp.krec(''))                                                      from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- blank_external_id
select pg_temp.kstage(r, 5,  pg_temp.krec('K1', p_name => ' Launch ', p_channel => 'SMS ', p_country => 'kenya', p_spend => '221,09', p_sent => '19000'))
                                                                                                    from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- clean, normalised
select pg_temp.kstage(r, 6,  pg_temp.krec('K2', p_channel => 'push', p_country => 'atlantis', p_spend => 'abc', p_sent => 'n/a', p_clicks => '1.5', p_sent_at => 'yesterday'))
                                                                                                    from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- five value warnings
select pg_temp.kstage(r, 7,  pg_temp.krec('D1', p_name => 'first'))                                 from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- superseded
select pg_temp.kstage(r, 8,  pg_temp.krec('D1', p_name => 'second'))                                from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- wins
select pg_temp.kstage(r, 9,  pg_temp.krec('P1', p_parent => 'K1'))                                  from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- parent in brand
select pg_temp.kstage(r, 10, pg_temp.krec('P2', p_parent => 'B1'))                                  from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- parent only in KAROO
select pg_temp.kstage(r, 11, pg_temp.krec('P3', p_parent => 'NOPE'))                                from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- parent nowhere
select pg_temp.kstage(r, 12, pg_temp.krec('N1'), true)                                              from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- nul_bytes_stripped
select pg_temp.kstage(r, 13, pg_temp.krec('PRE', p_name => 'base'))                                 from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- older than stored → unchanged
select pg_temp.kstage(r, 14, pg_temp.krec('X1', p_country => '', p_spend => '', p_sent => '', p_delivered => '', p_bounced => '', p_opens => '', p_clicks => '', p_sent_at => '', p_slt => ''))
                                                                                                    from (select '00000000-0000-4000-8000-0000000000c1'::uuid r) t;  -- blanks → null, no warning

create temp table t_c1 as select internal.import_campaigns('00000000-0000-4000-8000-0000000000c1') as s;

select is((select s from t_c1) - 'warnings' - 'warned_rows',
  '{"staged": 13, "rejected": 3, "routed": 0, "candidates": 9, "inserted": 8, "updated": 0, "unchanged": 1, "loaded": 9, "duplicates": 1}'::jsonb,
  'K1 run c1 summary counts');
select is((select array_agg(k order by k) from jsonb_object_keys((select s from t_c1)) k),
  array['candidates', 'duplicates', 'inserted', 'loaded', 'rejected', 'routed', 'staged', 'unchanged', 'updated', 'warned_rows', 'warnings'],
  'K2 summary has exactly the eleven keys');
select is((select row(brand_id, brand_code, source_file, entity, finished_at is not null, summary = (select s from t_c1))::text from public.import_runs where id = '00000000-0000-4000-8000-0000000000c1'),
  row(pg_temp.brand('KILELE'), 'KILELE', 'test-campaigns.csv', 'campaigns', true, true)::text, 'K3 import_runs row: entity campaigns, finished_at set, summary stored');

-- rejects
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'reject', 2), 'wrong_column_count', 'K4 12-column row → wrong_column_count');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'reject', 3), 'repeated_header', 'K5 header record → repeated_header');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'reject', 4), 'blank_external_id', 'K6 blank id → blank_external_id');
select is((select count(*) from public.campaigns where external_id in ('C12', '', 'external_id')), 0::bigint, 'K7 rejected rows are not loaded');

-- normalisation on the stored row
select is((select row(name, channel, target_country, reported_sent, reported_delivered, spend, sent_at, send_local_time, parent_external_id, as_of, file_rank)::text from pg_temp.campaign('KILELE', 'K1')),
  row('Launch', 'sms', 'KE', 19000, 90, 221.09::numeric, '2026-03-01 10:00:00+00'::timestamptz, '2026-03-01 13:00', null::text, '2026-08-01'::date, 10)::text,
  'K8 K1: name trimmed, channel lower(btrim), country kenya → KE, spend 221,09 → 221.09, ints, sent_at UTC, send_local_time raw');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'warn', 5), null, 'K9 a clean row has no warning');

-- value warnings: stored as null (channel stored as-is), one warn per (row, reason)
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'warn', 6),
  'channel_unknown,reported_count_unparseable,reported_count_unparseable,sent_at_unparseable,spend_unparseable,target_country_unknown', 'K10 K2 → the value warnings (one per offending reported_* column)');
select is((select row(channel, target_country, spend, reported_sent, reported_clicks, reported_opens, sent_at)::text from pg_temp.campaign('KILELE', 'K2')),
  row('push', null::text, null::numeric, null::int, null::int, 50, null::timestamptz)::text, 'K11 K2: unknown channel still stored, unparseable values null');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000c1' and row_no = 6 and reason = 'spend_unparseable'), '{"value": "abc"}'::jsonb, 'K12 warn detail is only the offending value');
select is((select string_agg(detail->>'column', ',' order by detail->>'column') from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000c1' and row_no = 6 and reason = 'reported_count_unparseable'),
  'reported_clicks,reported_sent', 'K13 reported_count_unparseable names the column');
select is((select row(target_country, spend, reported_sent, reported_delivered, reported_bounced, reported_opens, reported_clicks, sent_at, send_local_time)::text from pg_temp.campaign('KILELE', 'X1')),
  row(null::text, null::numeric, null::int, null::int, null::int, null::int, null::int, null::timestamptz, null::text)::text, 'K14 X1: blanks stored as null');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'warn', 14), null, 'K15 blanks are not "unparseable" — no warning');

-- duplicates: last row wins, one warning on the superseded row
select is((select name from pg_temp.campaign('KILELE', 'D1')), 'second', 'K16 in-file duplicate: last row wins');
select is((select count(*) from public.campaigns where external_id = 'D1'), 1::bigint, 'K17 one D1 row');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'warn', 7), 'duplicate_external_id', 'K18 superseded row → duplicate_external_id');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'warn', 8), null, 'K19 the winning row has no duplicate warning');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'warn', 12), 'nul_bytes_stripped', 'K20 had_nul → nul_bytes_stripped');

-- parents: resolved within the brand only
select is((select parent_campaign_id from pg_temp.campaign('KILELE', 'P1')), (select id from pg_temp.campaign('KILELE', 'K1')), 'K21 P1 → K1 resolved within the brand');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'warn', 9), null, 'K22 a resolved parent has no warning');
select is((select row(parent_external_id, parent_campaign_id)::text from pg_temp.campaign('KILELE', 'P2')), row('B1', null::uuid)::text, 'K23 P2 → B1 lives only in KAROO: pointer kept raw, parent_campaign_id null');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'warn', 10), 'parent_not_in_brand', 'K24 P2 → parent_not_in_brand');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000c1' and row_no = 10), '{"value": "B1"}'::jsonb, 'K25 parent_not_in_brand detail is the raw pointer');
select is((select row(parent_external_id, parent_campaign_id)::text from pg_temp.campaign('KILELE', 'P3')), row('NOPE', null::uuid)::text, 'K26 P3 → pointer to nothing: null');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c1', 'warn', 11), 'parent_unknown', 'K27 P3 → parent_unknown');

-- precedence: an older base row never touches a newer stored row
select is((select row(name, channel, as_of, file_rank)::text from pg_temp.campaign('KILELE', 'PRE')), row('newer', 'sms', '2026-09-01'::date, 20)::text, 'K28 PRE unchanged: newer stored row wins');
select is((select s->'warnings' from t_c1), (select count(*)::text::jsonb from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000c1' and severity = 'warn'), 'K29 summary.warnings = warn issue count');
select is((select s->'warned_rows' from t_c1), '5'::jsonb, 'K30 summary.warned_rows = distinct warned rows (6, 7, 10, 11, 12)');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000c1' and severity = 'route'), 0::bigint, 'K31 campaigns are never routed');

-- idempotency: same rows, fresh run_id
insert into staging.stage_campaigns (run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank)
select '00000000-0000-4000-8000-0000000000c2', source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank
from staging.stage_campaigns where run_id = '00000000-0000-4000-8000-0000000000c1';
create temp table t_c2 as select internal.import_campaigns('00000000-0000-4000-8000-0000000000c2') as s;
select is((select s from t_c2) - 'inserted' - 'unchanged', (select s from t_c1) - 'inserted' - 'unchanged', 'K32 second run: every other count identical');
select is((select s->'inserted' from t_c2), '0'::jsonb, 'K33 second run: inserted 0');
select is((select s->'updated' from t_c2), '0'::jsonb, 'K34 second run: updated 0');
select is((select s->'unchanged' from t_c2), '9'::jsonb, 'K35 second run: unchanged = candidates');
select is((select count(*) from public.campaigns where brand_id = pg_temp.brand('KILELE') and external_id in ('K1', 'K2', 'D1', 'P1', 'P2', 'P3', 'N1', 'PRE', 'X1')), 9::bigint, 'K36 second run added no rows');
select is((select parent_campaign_id from pg_temp.campaign('KILELE', 'P1')), (select id from pg_temp.campaign('KILELE', 'K1')), 'K37 second run: parent link unchanged');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000c2', 'warn', 10), 'parent_not_in_brand', 'K38 second run warns the cross-brand parent again');
-- same run_id again → report replaced, one run row
create temp table t_c2b as select internal.import_campaigns('00000000-0000-4000-8000-0000000000c2') as s;
select is((select s from t_c2b), (select s from t_c2), 'K39 re-running the same run_id → identical summary');
select is((select count(*) from public.import_runs where id = '00000000-0000-4000-8000-0000000000c2'), 1::bigint, 'K40 still one import_runs row for that run_id');

-- ---- run c3: a newer KILELE file (as_of 2026-09-01, rank 20): rename K1, repoint P1 → K2, clear P3's pointer ----
select pg_temp.kstage('00000000-0000-4000-8000-0000000000c3', 2, pg_temp.krec('K1', p_name => 'Launch v2'), false, 'KILELE', '2026-09-01', 20, 'test-campaigns-delta.csv');
select pg_temp.kstage('00000000-0000-4000-8000-0000000000c3', 3, pg_temp.krec('P1', p_parent => 'K2'), false, 'KILELE', '2026-09-01', 20, 'test-campaigns-delta.csv');
select pg_temp.kstage('00000000-0000-4000-8000-0000000000c3', 4, pg_temp.krec('P2', p_parent => 'K1'), false, 'KILELE', '2026-09-01', 20, 'test-campaigns-delta.csv');
create temp table t_c3 as select internal.import_campaigns('00000000-0000-4000-8000-0000000000c3') as s;
select is((select s from t_c3) - 'warnings' - 'warned_rows',
  '{"staged": 3, "rejected": 0, "routed": 0, "candidates": 3, "inserted": 0, "updated": 3, "unchanged": 0, "loaded": 3, "duplicates": 0}'::jsonb, 'K41 newer file → updated');
select is((select row(name, as_of, file_rank)::text from pg_temp.campaign('KILELE', 'K1')), row('Launch v2', '2026-09-01'::date, 20)::text, 'K42 K1 renamed by the newer file');
select is((select parent_campaign_id from pg_temp.campaign('KILELE', 'P1')), (select id from pg_temp.campaign('KILELE', 'K2')), 'K43 P1 repointed to K2 (parent pass is idempotent, is distinct from)');
select is((select parent_campaign_id from pg_temp.campaign('KILELE', 'P2')), (select id from pg_temp.campaign('KILELE', 'K1')), 'K44 P2 now resolves within the brand');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000c3'), 0::bigint, 'K45 the newer file has no issues');
select is((select brand_id from pg_temp.campaign('KILELE', 'P1')), pg_temp.brand('KILELE'), 'K46 brand_id never changes on update');
select is((select name from pg_temp.campaign('KAROO', 'B1')), 'karoo b1', 'K47 the other brand''s campaign is untouched');

-- ============================================================================
-- E: import_events on synthetic rows.
-- ============================================================================
select throws_ok($$ select internal.import_events('00000000-0000-4000-8000-0000000000e0') $$, 'invalid_input', 'E0 empty run → invalid_input');

-- contacts: CA in KILELE; CB only in KAROO (no routing); CR in KAROO, routed there from KILELE. Campaign KB in KAROO.
insert into public.contacts (brand_id, external_id, full_name, status, as_of, file_rank, routed_from)
values (pg_temp.brand('KILELE'), 'CA', 'a', 'active', '2026-08-01', 10, null),
       (pg_temp.brand('KAROO'),  'CB', 'b', 'active', '2026-08-01', 10, null),
       (pg_temp.brand('KAROO'),  'CR', 'r', 'active', '2026-08-01', 9,  'KILELE');
insert into public.campaigns (brand_id, external_id, name, channel, as_of, file_rank) values (pg_temp.brand('KAROO'), 'KB', 'karoo kb', 'email', '2026-08-01', 10);

select pg_temp.estage(r, 2,  (pg_temp.erec('E-5'))[1:5])                                            from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- wrong_column_count
select pg_temp.estage(r, 3,  array['event_id','contact_external_id','campaign_external_id','type','channel','occurred_at'])
                                                                                                    from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- repeated_header
select pg_temp.estage(r, 4,  pg_temp.erec(''))                                                      from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- blank_event_id
select pg_temp.estage(r, 5,  pg_temp.erec('E-B', p_contact => 'CB'))                                from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- unknown_contact (only in KAROO)
select pg_temp.estage(r, 6,  pg_temp.erec('E-R', p_contact => 'CR'))                                from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- follows the routed contact
select pg_temp.estage(r, 7,  pg_temp.erec('E-1', p_type => 'complaint', p_channel => 'Email '))     from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- clean
select pg_temp.estage(r, 8,  pg_temp.erec('E-2', p_campaign => 'NOPE'))                             from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- unknown_campaign
select pg_temp.estage(r, 9,  pg_temp.erec('E-3', p_type => 'delivery'))                             from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- type_unknown
select pg_temp.estage(r, 10, pg_temp.erec('E-4', p_at => 'yesterday'))                              from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- occurred_at_unparseable
select pg_temp.estage(r, 11, pg_temp.erec('E-D', p_type => 'click'))                                from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- superseded duplicate
select pg_temp.estage(r, 12, pg_temp.erec('E-D', p_type => 'click'))                                from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- wins
select pg_temp.estage(r, 13, pg_temp.erec('E-N', p_type => 'Bounce'), true)                         from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- nul_bytes_stripped
select pg_temp.estage(r, 14, pg_temp.erec('E-X', p_campaign => 'KB'))                               from (select '00000000-0000-4000-8000-0000000000e1'::uuid r) t;  -- KAROO's campaign id → unknown here

create temp table t_e1 as select internal.import_events('00000000-0000-4000-8000-0000000000e1') as s;

select is((select s from t_e1) - 'warnings' - 'warned_rows',
  '{"staged": 13, "rejected": 4, "routed": 1, "candidates": 8, "inserted": 8, "updated": 0, "unchanged": 0, "loaded": 8, "duplicates": 1, "already_present": 0}'::jsonb,
  'E1 run e1 summary counts (routed = events that followed a routed contact)');
select is((select array_agg(k order by k) from jsonb_object_keys((select s from t_e1)) k),
  array['already_present', 'candidates', 'duplicates', 'inserted', 'loaded', 'rejected', 'routed', 'staged', 'unchanged', 'updated', 'warned_rows', 'warnings'],
  'E2 summary has the eleven keys + already_present');
select is((select row(brand_id, brand_code, source_file, entity, finished_at is not null, summary = (select s from t_e1))::text from public.import_runs where id = '00000000-0000-4000-8000-0000000000e1'),
  row(pg_temp.brand('KILELE'), 'KILELE', 'test-events.csv', 'events', true, true)::text, 'E3 import_runs row: entity events, finished_at set, summary stored');

-- rejects
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'reject', 2), 'wrong_column_count', 'E4 5-column row → wrong_column_count');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'reject', 3), 'repeated_header', 'E5 header record → repeated_header');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'reject', 4), 'blank_event_id', 'E6 blank id → blank_event_id');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'reject', 5), 'unknown_contact', 'E7 contact only in another brand (not routed) → unknown_contact');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000e1' and row_no = 5), '{"value": "CB"}'::jsonb, 'E8 unknown_contact detail is the contact external_id');
select is((select count(*) from public.events where event_id in ('E-5', 'E-B', 'event_id', '')), 0::bigint, 'E9 rejected rows are not loaded');

-- the stored row
select is((select row(brand_id, source, type, contact_id, campaign_id, channel, occurred_at)::text from pg_temp.event('E-1')),
  row(pg_temp.brand('KILELE'), 'seed'::public.event_source, 'complained'::public.event_type,
      (select id from public.contacts where brand_id = pg_temp.brand('KILELE') and external_id = 'CA'),
      (select id from pg_temp.campaign('KILELE', 'K1')), 'email', '2026-03-02 08:00:00.123456+00'::timestamptz)::text,
  'E10 E-1: source seed, complaint → complained, contact + campaign resolved in the file brand, channel lower(btrim), microsecond UTC stamp');
select is((select raw from pg_temp.event('E-1')), jsonb_build_object('cols', array['E-1', 'CA', 'K1', 'complaint', 'Email ', '2026-03-02T08:00:00.123456Z']), 'E11 raw = {"cols": [...]}');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'warn', 7), null, 'E12 a clean row has no warning');

-- follows a routed contact
select is((select row(brand_id, contact_id, campaign_id)::text from pg_temp.event('E-R')),
  row(pg_temp.brand('KAROO'), (select id from public.contacts where brand_id = pg_temp.brand('KAROO') and external_id = 'CR'), null::uuid)::text,
  'E13 E-R stored under KAROO with the routed contact; campaign_id null (never a cross-brand pointer)');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'warn', 6), 'event_follows_routed_contact,unknown_campaign', 'E14 E-R → event_follows_routed_contact + unknown_campaign');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000e1' and row_no = 6 and reason = 'event_follows_routed_contact'), '{"to": "KAROO"}'::jsonb, 'E15 follow detail names the brand');
select is((select brand_id from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000e1' and row_no = 6 and reason = 'event_follows_routed_contact'), pg_temp.brand('KILELE'), 'E16 the issue stays in the source brand');

-- unknown campaign, unknown type, unparseable stamp
select is((select row(campaign_id, contact_id is not null)::text from pg_temp.event('E-2')), row(null::uuid, true)::text, 'E17 E-2: campaign_id null, event kept for contactability');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'warn', 8), 'unknown_campaign', 'E18 E-2 → unknown_campaign');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000e1' and row_no = 8), '{"value": "NOPE"}'::jsonb, 'E19 unknown_campaign detail is the raw pointer');
select is((select campaign_id from pg_temp.event('E-X')), null::uuid, 'E20 E-X: KAROO''s KB is not KILELE''s — never looked up by external_id alone');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'warn', 14), 'unknown_campaign', 'E21 E-X → unknown_campaign');
select is((select type from pg_temp.event('E-3')), 'unknown'::public.event_type, 'E22 E-3: delivery → unknown, still stored');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'warn', 9), 'type_unknown', 'E23 E-3 → type_unknown');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000e1' and row_no = 9), '{"value": "delivery"}'::jsonb, 'E24 type_unknown detail is the raw type');
select is((select occurred_at from pg_temp.event('E-4')), null::timestamptz, 'E25 E-4: occurred_at null');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'warn', 10), 'occurred_at_unparseable', 'E26 E-4 → occurred_at_unparseable');
select is((select type from pg_temp.event('E-N')), 'bounced'::public.event_type, 'E27 E-N: Bounce → bounced');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'warn', 13), 'nul_bytes_stripped', 'E28 had_nul → nul_bytes_stripped');

-- duplicates
select is((select count(*) from public.events where event_id = 'E-D'), 1::bigint, 'E29 in-file duplicate → one row');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'warn', 11), 'duplicate_event_id', 'E30 superseded row → duplicate_event_id');
select is(pg_temp.reasons('00000000-0000-4000-8000-0000000000e1', 'warn', 12), null, 'E31 the winning row has no duplicate warning');
select is((select s->'warned_rows' from t_e1), '7'::jsonb, 'E32 warned_rows = distinct warned rows (6, 8, 9, 10, 11, 13, 14)');
select is((select s->'warnings' from t_e1), (select count(*)::text::jsonb from public.import_issues where run_id = '00000000-0000-4000-8000-0000000000e1' and severity = 'warn'), 'E33 summary.warnings = warn issue count');
select is((select count(*) from public.import_issues where detail is not null and (detail ? 'cols' or detail ? 'full_name')), 0::bigint, 'E34 detail never carries a whole row');

-- idempotency: fresh run_id → inserted 0, already_present = candidates; then the same run_id
insert into staging.stage_events (run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank)
select '00000000-0000-4000-8000-0000000000e2', source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank
from staging.stage_events where run_id = '00000000-0000-4000-8000-0000000000e1';
create temp table t_e2 as select internal.import_events('00000000-0000-4000-8000-0000000000e2') as s;
select is((select s from t_e2) - 'inserted' - 'unchanged' - 'already_present', (select s from t_e1) - 'inserted' - 'unchanged' - 'already_present', 'E35 second run: every other count identical');
select is((select s->'inserted' from t_e2), '0'::jsonb, 'E36 second run: inserted 0');
select is((select s->'already_present' from t_e2), '8'::jsonb, 'E37 second run: already_present = candidates');
select is((select s->'unchanged' from t_e2), '8'::jsonb, 'E38 second run: unchanged = already_present');
select is((select count(*) from public.events where source = 'seed' and event_id like 'E-%'), 8::bigint, 'E39 second run added no rows');
create temp table t_e2b as select internal.import_events('00000000-0000-4000-8000-0000000000e2') as s;
select is((select s from t_e2b), (select s from t_e2), 'E40 re-running the same run_id → identical summary');
select is((select count(*) from public.import_runs where id = '00000000-0000-4000-8000-0000000000e2'), 1::bigint, 'E41 still one import_runs row');

-- a KAROO file with the same event_id as a KILELE event → its own row (natural key includes brand)
select pg_temp.estage('00000000-0000-4000-8000-0000000000e3', 2, pg_temp.erec('E-1', p_contact => 'CB', p_campaign => 'KB'), false, 'KAROO', '2026-08-01', 10, 'karoo-test-events.csv');
create temp table t_e3 as select internal.import_events('00000000-0000-4000-8000-0000000000e3') as s;
select is((select s->'inserted' from t_e3), '1'::jsonb, 'E42 same event_id in another brand → inserted');
select is((select row(brand_id, campaign_id)::text from public.events where source = 'seed' and event_id = 'E-1' and brand_id = pg_temp.brand('KAROO')),
  row(pg_temp.brand('KAROO'), (select id from pg_temp.campaign('KAROO', 'KB')))::text, 'E43 KAROO event resolves KAROO''s campaign');
select is((select count(*) from public.import_issues where brand_id <> (select brand_id from public.import_runs r where r.id = run_id)), 0::bigint, 'E44 every issue carries its run''s (source) brand_id');

select * from finish();
rollback;
