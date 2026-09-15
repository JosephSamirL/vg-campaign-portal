-- 0003_import.test.sql — the contacts importer contract (Story 2.3; architecture D-3, amendments #8, #9, S9).
--
-- Every FR-8 row for contacts is a case here, on synthetic staging rows the real seed lacks
-- (blank brand_code, routed-vs-home collisions, a delta following a routed contact). One
-- transaction, rolled back — the local seed data is never touched.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ============================================================================
-- T: shape — enum, tables, view, RLS, policies, grants, indexes, functions.
-- ============================================================================
select has_enum('public', 'issue_severity', 'T1 enum issue_severity exists');
select enum_has_labels('public', 'issue_severity', array['reject', 'warn', 'route'], 'T2 issue_severity labels');

select has_table('public', 'import_runs', 'T3 import_runs exists');
select columns_are('public', 'import_runs',
  array['id', 'brand_id', 'brand_code', 'source_file', 'entity', 'started_at', 'finished_at', 'summary'], 'T4 import_runs columns');
select col_is_pk('public', 'import_runs', 'id', 'T5 import_runs.id is the pk');
select col_not_null('public', 'import_runs', 'brand_id', 'T6 import_runs.brand_id not null');
select fk_ok('public', 'import_runs', 'brand_id', 'public', 'brands', 'id', 'T7 import_runs.brand_id → brands');

select has_table('public', 'import_issues', 'T8 import_issues exists');
select columns_are('public', 'import_issues',
  array['id', 'brand_id', 'run_id', 'source_file', 'row_no', 'severity', 'reason', 'detail'], 'T9 import_issues columns');
select col_not_null('public', 'import_issues', 'brand_id', 'T10 import_issues.brand_id not null (source brand, S9)');
select fk_ok('public', 'import_issues', 'run_id', 'public', 'import_runs', 'id', 'T11 import_issues.run_id → import_runs');
select is(
  (select rc.delete_rule from information_schema.referential_constraints rc
   join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
   where tc.table_schema = 'public' and tc.table_name = 'import_issues' and rc.unique_constraint_name = 'import_runs_pkey'),
  'CASCADE', 'T12 import_issues.run_id on delete cascade');
select col_type_is('public', 'import_issues', 'severity', 'public', 'issue_severity', 'T13 import_issues.severity is issue_severity');

select has_view('public', 'v_import_issue_groups', 'T14 view v_import_issue_groups exists');
select columns_are('public', 'v_import_issue_groups', array['run_id', 'brand_id', 'severity', 'reason', 'n'], 'T15 view columns');
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          cross join lateral pg_options_to_table(c.reloptions) o
          where n.nspname = 'public' and c.relname = 'v_import_issue_groups'
            and o.option_name = 'security_invoker' and o.option_value in ('true', 'on', '1')),
  'T16 view is security_invoker');

select ok(c.relrowsecurity and c.relforcerowsecurity, format('T17 RLS enabled+forced: %s', c.relname))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('import_runs', 'import_issues') order by c.relname;

select policies_are('public', 'import_runs', array['import_runs_select_own_brand'], 'T18 import_runs has exactly its select policy');
select policies_are('public', 'import_issues', array['import_issues_select_own_brand'], 'T19 import_issues has exactly its select policy');
select is(p.qual, '(brand_id = ( SELECT current_brand_id() AS current_brand_id))', format('T20 policy form (initplan): %s', p.tablename))
from pg_policies p where p.schemaname = 'public' and p.tablename in ('import_runs', 'import_issues') order by p.tablename;

select ok(has_table_privilege('authenticated', 'public.import_runs', 'SELECT'), 'T21 authenticated selects import_runs');
select ok(has_table_privilege('authenticated', 'public.import_issues', 'SELECT'), 'T22 authenticated selects import_issues');
select ok(has_table_privilege('authenticated', 'public.v_import_issue_groups', 'SELECT'), 'T23 authenticated selects the view');
select ok(not has_table_privilege('authenticated', 'public.import_runs', 'INSERT,UPDATE,DELETE'), 'T24 authenticated never writes import_runs');
select ok(not has_table_privilege('authenticated', 'public.import_issues', 'INSERT,UPDATE,DELETE'), 'T25 authenticated never writes import_issues');
select ok(not has_table_privilege('anon', 'public.import_runs', 'SELECT,INSERT,UPDATE,DELETE'), 'T26 anon holds nothing on import_runs');
select ok(not has_table_privilege('anon', 'public.import_issues', 'SELECT,INSERT,UPDATE,DELETE'), 'T27 anon holds nothing on import_issues');
select ok(not has_table_privilege('anon', 'public.v_import_issue_groups', 'SELECT'), 'T28 anon holds nothing on the view');

select has_index('public', 'import_issues', 'idx_import_issues_run_id_severity_reason', array['run_id', 'severity', 'reason', 'row_no'], 'T29 issues index');
select has_index('public', 'import_runs', 'idx_import_runs_brand_id_started_at', 'T30 runs index');

select has_function('internal', f.fn, array['text'], format('T31 internal.%s(text) exists', f.fn))
from (values ('normalize_consent'), ('normalize_status'), ('normalize_country'), ('normalize_brand_code'),
             ('normalize_signup_at'), ('normalize_email'), ('normalize_phone')) f(fn);
select ok(p.provolatile = 'i' and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'),
          format('T32 immutable + search_path pinned: internal.%s', p.proname))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'internal' and p.proname like 'normalize\_%' order by p.proname;
select ok(exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'internal' and p.proname = 'normalize_signup_at'
                    and 'TimeZone=UTC' = any (p.proconfig)), 'T33 normalize_signup_at pins timezone = UTC');
select has_function('internal', 'import_contacts', array['uuid'], 'T34 internal.import_contacts(uuid) exists');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'internal' and p.prosecdef), 'T35 nothing in internal is security definer');

-- ============================================================================
-- N: normalisers — the exact mappings.
-- ============================================================================
select is(internal.normalize_consent(v), true, format('N1 consent %L → true', v))
from unnest(array['yes', 'y', '1', 'true', 't', ' YES ', 'True']) v;
select is(internal.normalize_consent(v), false, format('N2 consent %L → false', v))
from unnest(array['no', 'n', '0', 'false', 'f', ' No']) v;
select is(internal.normalize_consent(v), null, format('N3 consent %L → null', v))
from unnest(array['', ' ', 'maybe', 'consent_marketing', null]) v;

select is(internal.normalize_status(v), r, format('N4 status %L → %L', v, r))
from (values ('active', 'active'), ('ACTIVE', 'active'), ('active ', 'active'), ('pending', 'pending'), ('bounced', 'bounced'),
             ('unsubscribed', 'unsubscribed'), ('unsubscribe', 'unsubscribed'), (' Unsubscribe ', 'unsubscribed'),
             ('zzz', null), ('', null), ('unknown', null), (null, null)) t(v, r);

select is(internal.normalize_country(v), r, format('N5 country %L → %L', v, r))
from (values ('', null), ('none', null), ('NULL', null), ('\N', null), ('-', null), ('n/a', null), ('unknown', null), (null, null),
             ('ke', 'KE'), ('ke ', 'KE'), ('KEN', 'KE'), ('Kenya', 'KE'), ('254', 'KE'),
             ('za', 'ZA'), ('zaf', 'ZA'), ('South Africa', 'ZA'), ('27', 'ZA'),
             ('ma', 'MA'), ('mar', 'MA'), ('Morocco', 'MA'), ('maroc', 'MA'), ('212', 'MA'),
             ('ss', 'SS'), ('UG', 'UG'), ('rw', 'RW'), ('Et', 'ET'), ('tz', 'TZ'), ('xyz', null), ('1', null)) t(v, r);
select is(internal.normalize_country(internal.normalize_country(v)), internal.normalize_country(v), format('N6 country idempotent on %L', v))
from unnest(array['ke', 'Kenya', 'ss', '\N', 'zaf']) v;

select is(internal.normalize_brand_code(v), r, format('N7 brand_code %L → %L', v, r))
from (values ('kilele', 'KILELE'), (' Karoo ', 'KAROO'), ('', null), ('  ', null), (null, null)) t(v, r);

select is(internal.normalize_signup_at(v), r, format('N8 signup_at %L → %L', v, r))
from (values ('2026-02-01', '2026-02-01 00:00:00+00'::timestamptz),
             ('2026-02-01T10:20:30Z', '2026-02-01 10:20:30+00'),
             ('2026-02-01 10:20:30', '2026-02-01 10:20:30+00'),
             ('2026-02-01T10:20', '2026-02-01 10:20:00+00'),
             ('2026-02-01T10:20:30.123456Z', '2026-02-01 10:20:30.123456+00'),
             ('2026-02-01T10:20:30+03:00', '2026-02-01 07:20:30+00'),
             ('2026-02-01T10:20:30+0300', '2026-02-01 07:20:30+00'),
             ('01/02/2026 10:20', '2026-02-01 10:20:00+00'),
             (' 2026-02-01 ', '2026-02-01 00:00:00+00')) t(v, r);
select is(internal.normalize_signup_at(v), null, format('N9 signup_at %L → null', v))
from unnest(array['', '  ', '31/02/2026 10:00', '2026-02-30', '2026-02-30T10:00:00Z', '01/02/2026', '2026/02/01', 'yesterday', '1700000000', null]) v;
-- the function-level timezone wins over the session's
set local timezone = 'Africa/Nairobi';
select is(internal.normalize_signup_at('2026-02-01'), '2026-02-01 00:00:00+00'::timestamptz, 'N10 date-only is midnight UTC under a non-UTC session');
select is(internal.normalize_signup_at('01/02/2026 10:20'), '2026-02-01 10:20:00+00'::timestamptz, 'N11 dd/mm/yyyy is UTC under a non-UTC session');
set local timezone = 'UTC';

select is(internal.normalize_email(v), r, format('N12 email %L → %L', v, r))
from (values (' Joe@Example.COM ', 'joe@example.com'), ('a.b+c@d.co', 'a.b+c@d.co'), ('', null), ('  ', null), (null, null),
             ('not-an-email', null), ('a@b', null), ('a b@c.com', null), ('@c.com', null), ('a@@c.com', null)) t(v, r);

select is(internal.normalize_phone(v), r, format('N13 phone %L → %L', v, r))
from (values (' +254 700 000 000 ', '+254 700 000 000'), ('0712345678', '0712345678'), ('(011) 555-0100', '(011) 555-0100'),
             ('', null), ('  ', null), (null, null), ('9.99E+99', null), ('1e+10', null), ('n/a', null), ('---', null)) t(v, r);

-- ============================================================================
-- I: the importer, on synthetic staging rows.
-- ============================================================================
-- helpers: a 13-column contacts record with overrides, and a staging row (ncols from the array).
create function pg_temp.rec(
  p_ext text, p_name text default 'Fixture', p_email text default 'fx@example.com', p_phone text default '+254700000000',
  p_country text default 'KE', p_city text default 'Nairobi', p_signup text default '2026-01-01T00:00:00Z', p_status text default 'active',
  p_consent text default 'yes', p_deleted text default '', p_supp text default '', p_brand text default 'KILELE', p_notes text default ''
) returns text[] language sql immutable as $$
  select array[p_ext, p_name, p_email, p_phone, p_country, p_city, p_signup, p_status, p_consent, p_deleted, p_supp, p_brand, p_notes]
$$;
create function pg_temp.stage(
  p_run uuid, p_row int, p_cols text[], p_had_nul boolean default false,
  p_brand text default 'KILELE', p_as_of date default '2026-08-01', p_rank int default 10, p_file text default 'test-contacts.csv'
) returns void language sql as $$
  insert into staging.stage_contacts (run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank)
  values (p_run, p_file, p_brand, p_row, coalesce(array_length(p_cols, 1), 0), p_cols, p_had_nul, p_as_of, p_rank)
$$;
create function pg_temp.brand(p_code text) returns uuid language sql stable as $$ select id from public.brands where code = p_code $$;
create function pg_temp.contact(p_brand text, p_ext text) returns public.contacts language sql stable as $$
  select c from public.contacts c where c.brand_id = pg_temp.brand(p_brand) and c.external_id = p_ext
$$;
create function pg_temp.reasons(p_run uuid, p_sev public.issue_severity, p_row int) returns text language sql stable as $$
  select string_agg(reason, ',' order by reason) from public.import_issues where run_id = p_run and severity = p_sev and row_no is not distinct from p_row
$$;

-- empty / unknown runs are programmer errors
select throws_ok($$ select internal.import_contacts('00000000-0000-4000-8000-000000000000') $$, 'invalid_input', 'I0 empty run → invalid_input');
select pg_temp.stage('00000000-0000-4000-8000-0000000000ee', 2, pg_temp.rec('X1'), false, 'NOBRAND');
select throws_ok($$ select internal.import_contacts('00000000-0000-4000-8000-0000000000ee') $$, 'invalid_input', 'I0b unknown file brand → invalid_input');

-- pre-existing rows: a newer suppressed KILELE row (P1), an older suppressed KILELE row for the delta (P2),
-- KAROO's own H1 at the same as_of as the base file.
insert into public.contacts (brand_id, external_id, full_name, status, as_of, file_rank, suppressed_at, suppressed_reason)
values (pg_temp.brand('KILELE'), 'P1', 'newer', 'bounced', '2026-09-01', 20, '2026-08-15 00:00:00+00', 'bounced'),
       (pg_temp.brand('KILELE'), 'P2', 'old', 'active', '2026-08-01', 10, '2026-08-15 00:00:00+00', 'bounced'),
       (pg_temp.brand('KAROO'),  'H1', 'home', 'active', '2026-08-01', 10, null, null);

-- ---- run 1: KILELE base file (as_of 2026-08-01, rank 10) ----
select pg_temp.stage(r, 2,  (pg_temp.rec('C12'))[1:12])                                   from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- wrong_column_count
select pg_temp.stage(r, 3,  array['external_id','full_name','email','phone','country','city','signup_at','status','consent_marketing','deleted_at','suppressed_until','brand_code','notes'])
                                                                                          from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- repeated_header
select pg_temp.stage(r, 4,  pg_temp.rec(''))                                              from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- blank_external_id
select pg_temp.stage(r, 5,  pg_temp.rec('B1', p_signup => '31/02/2026 10:00'))            from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- bad_signup_at
select pg_temp.stage(r, 6,  pg_temp.rec('U1', p_brand => 'ACME'))                         from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- unknown_brand_code
select pg_temp.stage(r, 7,  pg_temp.rec('R1', p_name => 'routed one', p_brand => 'karoo'))from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- route → KAROO
select pg_temp.stage(r, 8,  pg_temp.rec('W1', p_brand => ''))                             from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- blank_brand_code
select pg_temp.stage(r, 9,  pg_temp.rec('W2', p_consent => 'maybe', p_status => 'zzz', p_country => '\N', p_email => '', p_phone => '9.99E+99'))
                                                                                          from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- five value warnings
select pg_temp.stage(r, 10, pg_temp.rec('D1', p_name => 'first'))                         from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- superseded
select pg_temp.stage(r, 11, pg_temp.rec('D1', p_name => 'second'))                        from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- wins
select pg_temp.stage(r, 12, pg_temp.rec('N1'), true)                                      from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- nul_bytes_stripped
select pg_temp.stage(r, 13, pg_temp.rec('P1', p_name => 'base'))                          from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- older than stored → unchanged
select pg_temp.stage(r, 14, pg_temp.rec('H1', p_name => 'from kilele', p_brand => 'KAROO')) from (select '00000000-0000-4000-8000-000000000001'::uuid r) t; -- routed vs home → home wins
select pg_temp.stage(r, 15, pg_temp.rec('R2', p_name => 'routed two', p_brand => 'KAROO')) from (select '00000000-0000-4000-8000-000000000001'::uuid r) t; -- route → KAROO (home file arrives later)
select pg_temp.stage(r, 16, pg_temp.rec('E1', p_email => 'not-an-email', p_phone => '', p_deleted => '2026-03-01', p_supp => '01/06/2027 00:00'))
                                                                                          from (select '00000000-0000-4000-8000-000000000001'::uuid r) t;  -- email_invalid + phone_missing; timestamps reuse

create temp table t_run1 as select internal.import_contacts('00000000-0000-4000-8000-000000000001') as s;

select is((select s from t_run1) - 'warnings' - 'warned_rows',
  '{"staged": 15, "rejected": 5, "routed": 3, "candidates": 9, "inserted": 7, "updated": 0, "unchanged": 2, "loaded": 9, "duplicates": 1}'::jsonb,
  'I1 run 1 summary counts');
select is((select array_agg(k order by k) from jsonb_object_keys((select s from t_run1)) k),
  array['candidates', 'duplicates', 'inserted', 'loaded', 'rejected', 'routed', 'staged', 'unchanged', 'updated', 'warned_rows', 'warnings'],
  'I2 summary has exactly the eleven keys');
select is((select (s->>'loaded')::int = (s->>'inserted')::int + (s->>'updated')::int + (s->>'unchanged')::int from t_run1), true, 'I3 loaded = inserted + updated + unchanged');

select is((select row(brand_id, brand_code, source_file, entity, finished_at is not null, summary = (select s from t_run1))::text from public.import_runs where id = '00000000-0000-4000-8000-000000000001'),
  row(pg_temp.brand('KILELE'), 'KILELE', 'test-contacts.csv', 'contacts', true, true)::text, 'I4 import_runs row: id = run_id, brand/file from the staged rows, finished_at set, summary stored');

-- rejects: one 'reject' issue per row, nothing loaded
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'reject', 2), 'wrong_column_count', 'I5 12-column row → wrong_column_count');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'reject', 3), 'repeated_header', 'I6 header record → repeated_header');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'reject', 4), 'blank_external_id', 'I7 blank id → blank_external_id');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'reject', 5), 'bad_signup_at', 'I8 31/02/2026 10:00 → bad_signup_at');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'reject', 6), 'unknown_brand_code', 'I9 ACME → unknown_brand_code');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-000000000001' and severity = 'reject'), 5::bigint, 'I10 exactly five reject issues');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-000000000001' and row_no = 6), '{"value": "ACME"}'::jsonb, 'I11 reject detail carries only the offending value');
select is((select count(*) from public.contacts where external_id in ('C12', 'B1', 'U1')), 0::bigint, 'I12 rejected rows are not loaded');
select is((select count(*) from public.contacts where external_id = 'external_id'), 0::bigint, 'I13 the header record is not loaded');

-- routing: rows land in KAROO with routed_from + file_rank − 1; ONE count-only route issue; no per-row record
select is((select row(brand_id, routed_from, as_of, file_rank, full_name)::text from public.contacts where external_id = 'R1'),
  row(pg_temp.brand('KAROO'), 'KILELE', '2026-08-01'::date, 9, 'routed one')::text, 'I14 R1 routed to KAROO, routed_from KILELE, file_rank 9');
select is((select count(*) from public.contacts where external_id = 'R1' and brand_id = pg_temp.brand('KILELE')), 0::bigint, 'I15 no KILELE row for the routed id');
select is((select row(brand_id, row_no, reason, detail)::text from public.import_issues where run_id = '00000000-0000-4000-8000-000000000001' and severity = 'route'),
  row(pg_temp.brand('KILELE'), null::int, 'routed_to_karoo', '{"to": "KAROO", "count": 3}'::jsonb)::text,
  'I16 exactly one count-only route issue in the SOURCE brand: routed_to_karoo, row_no null, {"to","count"}');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-000000000001' and row_no in (7, 14, 15)), 0::bigint, 'I17 routed rows have no per-row issue');
select is((select n from public.v_import_issue_groups where run_id = '00000000-0000-4000-8000-000000000001' and severity = 'route'), 1::bigint, 'I18 the view groups the route issue');

-- routed vs home precedence: the home brand's own row of the same as_of is never overwritten
select is((select row(full_name, routed_from, file_rank)::text from public.contacts where external_id = 'H1'), row('home', null::text, 10)::text, 'I19 KAROO''s own H1 survives a routed row of the same as_of');

-- warnings: accepted as the file's brand, unknowns stored as null
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'warn', 8), 'blank_brand_code', 'I20 blank brand_code → warn');
select is((select brand_id from public.contacts where external_id = 'W1'), pg_temp.brand('KILELE'), 'I21 blank brand_code row accepted as the file''s brand');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'warn', 9), 'consent_unknown,country_unknown,email_missing,phone_invalid,status_unknown', 'I22 W2 → the five value warnings');
select is((select row(consent_marketing, status, country, email, phone)::text from public.contacts where external_id = 'W2'),
  row(null::boolean, null::text, null::text, null::text, null::text)::text, 'I23 W2 unknowns stored as null, never a sentinel');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-000000000001' and row_no = 9 and reason = 'consent_unknown'), '{"value": "maybe"}'::jsonb, 'I24 warn detail is only the offending value');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'warn', 16), 'email_invalid,phone_missing', 'I25 E1 → email_invalid + phone_missing');
select is((select row(deleted_at, suppressed_until)::text from public.contacts where external_id = 'E1'),
  row('2026-03-01 00:00:00+00'::timestamptz, '2027-06-01 00:00:00+00'::timestamptz)::text, 'I26 deleted_at / suppressed_until reuse normalize_signup_at');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'warn', 12), 'nul_bytes_stripped', 'I27 had_nul → nul_bytes_stripped');

-- duplicates: last row wins, one warning on the superseded row
select is((select full_name from public.contacts where external_id = 'D1'), 'second', 'I28 in-file duplicate: last row wins');
select is((select count(*) from public.contacts where external_id = 'D1'), 1::bigint, 'I29 one D1 row');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'warn', 10), 'duplicate_external_id', 'I30 superseded row → duplicate_external_id');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000001', 'warn', 11), null, 'I31 the winning row has no duplicate warning');
select is((select s->'warnings' from t_run1), (select count(*)::text::jsonb from public.import_issues where run_id = '00000000-0000-4000-8000-000000000001' and severity = 'warn'), 'I32 summary.warnings = warn issue count');
select is((select s->'warned_rows' from t_run1), '5'::jsonb, 'I33 summary.warned_rows = distinct warned rows (8, 9, 10, 12, 16)');

-- precedence: an older base row never touches a newer stored row; suppressed_at intact either way
select is((select row(full_name, status, suppressed_at, suppressed_reason, as_of, file_rank)::text from public.contacts where external_id = 'P1'),
  row('newer', 'bounced', '2026-08-15 00:00:00+00'::timestamptz, 'bounced', '2026-09-01'::date, 20)::text, 'I34 P1 unchanged: newer stored row wins, suppressed_at intact');

-- idempotency: the same rows under a fresh run_id → nothing inserted or updated, identical counts otherwise
insert into staging.stage_contacts (run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank)
select '00000000-0000-4000-8000-000000000011', source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank
from staging.stage_contacts where run_id = '00000000-0000-4000-8000-000000000001';
create temp table t_run1b as select internal.import_contacts('00000000-0000-4000-8000-000000000011') as s;
select is((select s from t_run1b) - 'inserted' - 'unchanged', (select s from t_run1) - 'inserted' - 'unchanged', 'I35 second run: every other count identical');
select is((select s->'inserted' from t_run1b), '0'::jsonb, 'I36 second run: inserted 0');
select is((select s->'updated' from t_run1b), '0'::jsonb, 'I37 second run: updated 0');
select is((select s->'unchanged' from t_run1b), '9'::jsonb, 'I38 second run: unchanged = candidates');
select is((select count(*) from public.contacts where external_id in ('R1', 'R2', 'W1', 'W2', 'D1', 'N1', 'E1', 'P1', 'H1')), 9::bigint, 'I39 second run added no rows');

-- the same run_id again: the report is replaced (old issues cascade away), contacts untouched
create temp table t_run1c as select internal.import_contacts('00000000-0000-4000-8000-000000000011') as s;
select is((select s from t_run1c), (select s from t_run1b), 'I39b re-running the same run_id → identical summary');
select is((select count(*) from public.import_runs where id = '00000000-0000-4000-8000-000000000011'), 1::bigint, 'I39c still one import_runs row for that run_id');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-000000000011'), (select (s->>'rejected')::bigint + (s->>'warnings')::bigint + 1 from t_run1c), 'I39d issues rewritten once: rejects + warnings + one route issue');

-- ---- run 3: KAROO's own base file supplies R2 → the home row replaces the routed one ----
select pg_temp.stage('00000000-0000-4000-8000-000000000003', 2, pg_temp.rec('R2', p_name => 'karoo own', p_brand => 'KAROO'), false, 'KAROO', '2026-08-01', 10, 'karoo-test.csv');
create temp table t_run3 as select internal.import_contacts('00000000-0000-4000-8000-000000000003') as s;
select is((select s->'updated' from t_run3), '1'::jsonb, 'I40 KAROO base over a routed row (same as_of, rank 10 > 9) → updated');
select is((select row(full_name, routed_from, file_rank)::text from public.contacts where external_id = 'R2'), row('karoo own', null::text, 10)::text, 'I41 home row wins in the other direction too: routed_from cleared');
select is((select brand_id from public.import_runs where id = '00000000-0000-4000-8000-000000000003'), pg_temp.brand('KAROO'), 'I42 KAROO run belongs to KAROO');

-- ---- run 2: KILELE delta (as_of 2026-09-01, rank 20) ----
select pg_temp.stage('00000000-0000-4000-8000-000000000002', 2, pg_temp.rec('P2', p_name => 'new', p_status => 'ACTIVE ', p_country => 'ke '), false, 'KILELE', '2026-09-01', 20, 'test-delta.csv');
select pg_temp.stage('00000000-0000-4000-8000-000000000002', 3, pg_temp.rec('R1', p_name => 'routed one v2', p_brand => ''), false, 'KILELE', '2026-09-01', 20, 'test-delta.csv');
create temp table t_run2 as select internal.import_contacts('00000000-0000-4000-8000-000000000002') as s;
select is((select s from t_run2) - 'warnings' - 'warned_rows',
  '{"staged": 2, "rejected": 0, "routed": 1, "candidates": 2, "inserted": 0, "updated": 2, "unchanged": 0, "loaded": 2, "duplicates": 0}'::jsonb,
  'I43 delta summary: both rows updated, one followed');
select is((select row(full_name, status, country, suppressed_at, suppressed_reason, as_of, file_rank)::text from public.contacts where external_id = 'P2'),
  row('new', 'active', 'KE', '2026-08-15 00:00:00+00'::timestamptz, 'bounced', '2026-09-01'::date, 20)::text,
  'I44 delta over base → updated (btrim/lower applied); suppressed_at / suppressed_reason never touched');
select is((select row(brand_id, full_name, routed_from, as_of, file_rank)::text from public.contacts where external_id = 'R1'),
  row(pg_temp.brand('KAROO'), 'routed one v2', 'KILELE', '2026-09-01'::date, 19)::text, 'I45 delta row followed the routed contact into KAROO (rank 19)');
select is((select count(*) from public.contacts where external_id = 'R1'), 1::bigint, 'I46 following created no KILELE row');
select is(pg_temp.reasons('00000000-0000-4000-8000-000000000002', 'warn', 3), 'followed_routed_contact', 'I47 followed row → followed_routed_contact (its blank brand_code is not warned)');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-000000000002' and reason = 'followed_routed_contact'), '{"to": "KAROO"}'::jsonb, 'I48 followed detail names the brand only');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-000000000002' and severity = 'route'), '{"to": "KAROO", "count": 1}'::jsonb, 'I49 the followed row is counted in the route issue');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-000000000002' and row_no = 2), 0::bigint, 'I50 a clean delta row has no issue');

-- the issue table never stores a whole row
select is((select count(*) from public.import_issues where detail is not null and (detail ? 'full_name' or detail ? 'email' or detail ? 'cols')), 0::bigint, 'I51 detail never carries a whole row');
select is((select count(*) from public.import_issues where brand_id <> (select brand_id from public.import_runs r where r.id = run_id)), 0::bigint, 'I52 every issue carries its run''s (source) brand_id');

-- cascade: deleting a run removes its issues
delete from public.import_runs where id = '00000000-0000-4000-8000-000000000011';
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-000000000011'), 0::bigint, 'I53 issues cascade with their run');

select * from finish();
rollback;
