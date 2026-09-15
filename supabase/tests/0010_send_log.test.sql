-- 0010_send_log.test.sql — the seed send-log importer (Story 4.5; D-2, D-3; FR-10, FR-20, FR-21; amendment S20).
--
-- Synthetic brands A and B (fresh codes, so the local seed data is never touched) with a campaign each, plus one
-- signed-in analyst in A; staging rows inserted straight into staging.stage_send_log (Story 2.2's column layout);
-- everything under one transaction, rolled back.
-- Pins: the function's shape (internal, security invoker, search_path pinned, executable by no exposed role);
-- the two structural rejects; BATCH-A ×3 → one send carrying the LAST row's values + two duplicate_batch_key
-- warnings; unknown campaign (nowhere, and only in brand B) → reject; unparseable stamp / count → reject; the
-- inserted row's fields (source seed_send_log, status complete, confirmed_at = dispatched_at = queued_at, the
-- nullable columns null); the summary keys; the import_runs row; idempotency (same run_id and a fresh run_id →
-- inserted 0, already_present = candidates, zero reject issues in the second run, sends count unchanged); a
-- complete seed send never blocks the partial unique index; the campaign's reported_* untouched; RLS keeps a
-- brand-A user from seeing brand B's seed send.

begin;
create extension if not exists pgtap with schema extensions;
select plan(68);

-- ============================================================================
-- F: the function — internal, security invoker, volatile, search_path pinned, no exposed execute.
-- ============================================================================
select has_function('internal', 'import_send_log', array['uuid'], 'F1 internal.import_send_log(uuid) exists');
select function_returns('internal', 'import_send_log', array['uuid'], 'jsonb', 'F1 import_send_log returns jsonb');
select is(p.prosecdef, false, 'F1 import_send_log is security invoker (runs as postgres from scripts/seed)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'import_send_log';
select ok(exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=""'), 'F1 import_send_log pins search_path = ''''')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'import_send_log';
select is(p.provolatile, 'v', 'F1 import_send_log is volatile (it writes)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'internal' and p.proname = 'import_send_log';
select ok(not has_function_privilege('anon', 'internal.import_send_log(uuid)', 'execute'), 'F2 anon may not execute import_send_log');
select ok(not has_function_privilege('authenticated', 'internal.import_send_log(uuid)', 'execute'), 'F2 authenticated may not execute import_send_log');
select ok(not has_function_privilege('service_role', 'internal.import_send_log(uuid)', 'execute'), 'F2 service_role may not execute import_send_log');
select ok(not has_function_privilege('public', 'internal.import_send_log(uuid)', 'execute'), 'F2 PUBLIC may not execute import_send_log');

-- ============================================================================
-- helpers + fixtures — brands A / B, one campaign each (KIL-TEST in A, B-ONLY in B), an analyst in A.
-- ============================================================================
create function pg_temp.lstage(
  p_run uuid, p_row int, p_cols text[],
  p_brand text default 'SENDLOGTEST-A', p_file text default 'test-send-log.csv'
) returns void language sql as $$
  insert into staging.stage_send_log (run_id, source_file, file_brand, row_no, ncols, cols, had_nul, as_of, file_rank)
  values (p_run, p_file, p_brand, p_row, coalesce(array_length(p_cols, 1), 0), p_cols, false, '2026-08-01', 10)
$$;
create function pg_temp.brand(p_code text) returns uuid language sql stable as $$ select id from public.brands where code = p_code $$;
create function pg_temp.reasons(p_run uuid, p_sev public.issue_severity, p_row int) returns text language sql stable as $$
  select string_agg(reason, ',' order by reason) from public.import_issues where run_id = p_run and severity = p_sev and row_no is not distinct from p_row
$$;
create function pg_temp.send(p_key text) returns public.sends language sql stable as $$ select s from public.sends s where s.batch_key = p_key $$;

insert into public.brands (code, name) values ('SENDLOGTEST-A', 'Send Log Test Brand A'), ('SENDLOGTEST-B', 'Send Log Test Brand B');
insert into public.campaigns (brand_id, external_id, name, channel, reported_sent, reported_delivered, as_of, file_rank)
values (pg_temp.brand('SENDLOGTEST-A'), 'KIL-TEST', 'a campaign', 'email', 10640, 10000, '2026-08-01', 10),
       (pg_temp.brand('SENDLOGTEST-B'), 'B-ONLY',   'b campaign', 'email', 500,   450,   '2026-08-01', 10);
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-sendlog-analyst-a@tenancy.test', '{}', '{}', now(), now());
insert into public.app_users (email, brand_id, role, auth_user_id)
values ('fixture-sendlog-analyst-a@tenancy.test', pg_temp.brand('SENDLOGTEST-A'), 'analyst', '00000000-0000-4000-8000-0000000000a1');

-- ============================================================================
-- R: run r1 — the Dev-Notes staging set, plus the unparseable rows.
-- ============================================================================
select throws_ok($$ select internal.import_send_log('00000000-0000-4000-8000-00000000a0a0') $$, 'invalid_input', 'R0 empty run → invalid_input');

select pg_temp.lstage(r, 1, array['BATCH-A', 'KIL-TEST', '2026-03-17T07:15:00Z', '1', 'sent'])    from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- superseded
select pg_temp.lstage(r, 2, array['BATCH-A', 'KIL-TEST', '2026-03-17T07:15:00Z', '2', 'sent'])    from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- superseded
select pg_temp.lstage(r, 3, array[' BATCH-A ', ' KIL-TEST ', '2026-03-17T07:15:00Z', '100', 'sent']) from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- wins (btrim)
select pg_temp.lstage(r, 4, array['BATCH-B', 'NOPE', '2026-03-18T07:15:00Z', '50', 'sent'])       from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- unknown_campaign (nowhere)
select pg_temp.lstage(r, 5, array['BATCH-C', 'KIL-TEST', '2026-03-19T07:15:00Z', '50'])           from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- wrong_column_count (4)
select pg_temp.lstage(r, 6, array['', 'KIL-TEST', '2026-03-19T07:15:00Z', '50', 'sent'])          from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- blank_batch_key
select pg_temp.lstage(r, 7, array['BATCH-D', 'B-ONLY', '2026-03-20T07:15:00Z', '50', 'sent'])     from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- unknown_campaign (only in brand B)
select pg_temp.lstage(r, 8, array['BATCH-E', 'KIL-TEST', 'yesterday', '50', 'sent'])              from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- unparseable_queued_at
select pg_temp.lstage(r, 9, array['BATCH-F', 'KIL-TEST', '2026-03-21T07:15:00Z', '1.5k', 'sent']) from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- unparseable_recipient_count
select pg_temp.lstage(r, 10, array['BATCH-G', 'NOPE', 'bad', 'x', 'sent'])                        from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- superseded: never judged, only warned
select pg_temp.lstage(r, 11, array['BATCH-G', 'KIL-TEST', '2026-03-22 08:00', '0', 'queued'])     from (select '00000000-0000-4000-8000-00000000a0a1'::uuid r) t;  -- clean: zero recipients, status ignored

create temp table t_r1 as select internal.import_send_log('00000000-0000-4000-8000-00000000a0a1') as s;

select is((select s from t_r1) - 'warnings' - 'warned_rows',
  '{"staged": 11, "rejected": 6, "routed": 0, "candidates": 2, "inserted": 2, "updated": 0, "unchanged": 0, "already_present": 0, "loaded": 2, "duplicates": 3}'::jsonb,
  'R1 run r1 summary counts');
select is((select array_agg(k order by k) from jsonb_object_keys((select s from t_r1)) k),
  array['already_present', 'candidates', 'duplicates', 'inserted', 'loaded', 'rejected', 'routed', 'staged', 'unchanged', 'updated', 'warned_rows', 'warnings'],
  'R2 summary has exactly the twelve keys (the eleven shared ones + already_present)');
select is((select (s->>'warnings')::int from t_r1), 3, 'R3 three warnings (one per superseded row)');
select is((select (s->>'warned_rows')::int from t_r1), 3, 'R3 on three rows');
select is((select row(brand_id, brand_code, source_file, entity, finished_at is not null, summary = (select s from t_r1))::text from public.import_runs where id = '00000000-0000-4000-8000-00000000a0a1'),
  row(pg_temp.brand('SENDLOGTEST-A'), 'SENDLOGTEST-A', 'test-send-log.csv', 'send_log', true, true)::text,
  'R4 import_runs row: entity send_log, finished_at set, summary stored');

-- duplicates: BATCH-A ×3 → one send, the last row's values, one warn per superseded row
select is((select count(*) from public.sends where batch_key = 'BATCH-A'), 1::bigint, 'D1 BATCH-A ×3 → exactly one send');
select is((select recipient_count from pg_temp.send('BATCH-A')), 100, 'D2 the last row (row_no 3) wins — recipient_count 100');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'warn', 1), 'duplicate_batch_key', 'D3 row 1 superseded → warn duplicate_batch_key');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'warn', 2), 'duplicate_batch_key', 'D3 row 2 superseded → warn duplicate_batch_key');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'warn', 3), null, 'D4 the winning row has no warning');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'reject', 10), null, 'D5 a superseded row is never judged: row 10 (unknown campaign, bad stamp, bad count) has no reject');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'warn', 10), 'duplicate_batch_key', 'D5 … only duplicate_batch_key');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and row_no = 2 and reason = 'duplicate_batch_key'),
  '{"value": "BATCH-A"}'::jsonb, 'D6 duplicate warn detail is only the batch_key');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and severity = 'warn' and reason = 'duplicate_batch_key'), 3::bigint, 'D7 exactly three duplicate_batch_key warnings (BATCH-A ×2, BATCH-G ×1)');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and severity = 'warn' and reason <> 'duplicate_batch_key'), 0::bigint, 'D8 no other warning reason exists');

-- rejects
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'reject', 4), 'unknown_campaign', 'J1 campaign nowhere → reject unknown_campaign');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and row_no = 4), '{"value": "NOPE"}'::jsonb, 'J1 unknown_campaign detail is the raw campaign id');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'reject', 5), 'wrong_column_count', 'J2 4-column row → reject wrong_column_count');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and row_no = 5), '{"value": 4}'::jsonb, 'J2 wrong_column_count detail is ncols');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'reject', 6), 'blank_batch_key', 'J3 blank key → reject blank_batch_key');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'reject', 7), 'unknown_campaign', 'J4 campaign only in brand B → reject unknown_campaign (file brand only, never by external_id alone)');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'reject', 8), 'unparseable_queued_at', 'J5 "yesterday" → reject unparseable_queued_at');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and row_no = 8), '{"value": "yesterday"}'::jsonb, 'J5 detail is the raw stamp');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0a1', 'reject', 9), 'unparseable_recipient_count', 'J6 "1.5k" → reject unparseable_recipient_count');
select is((select detail from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and row_no = 9), '{"value": "1.5k"}'::jsonb, 'J6 detail is the raw count');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and severity = 'reject'), 6::bigint, 'J7 six reject issues in run r1');
select is((select count(*) from public.sends where batch_key in ('BATCH-B', 'BATCH-C', 'BATCH-D', 'BATCH-E', 'BATCH-F') or batch_key = ''), 0::bigint, 'J8 rejected rows are not loaded');
select is((select string_agg(reason, ',' order by reason) from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and severity = 'reject'),
  'blank_batch_key,unknown_campaign,unknown_campaign,unparseable_queued_at,unparseable_recipient_count,wrong_column_count', 'J9 the six reject reasons, in full');

-- the inserted row's fields
select is((select row(brand_id, campaign_id, source, status, recipient_count, confirmed_at, dispatched_at,
                      confirmed_by, body_sha256, batch_id, accepted_count, rejected_count, failure_reason,
                      provider_responded_at, dispatch_attempts, dispatch_lease_until)::text
           from pg_temp.send('BATCH-A')),
  row(pg_temp.brand('SENDLOGTEST-A'), (select id from public.campaigns where external_id = 'KIL-TEST'), 'seed_send_log'::public.send_source,
      'complete'::public.send_status, 100, '2026-03-17T07:15:00Z'::timestamptz, '2026-03-17T07:15:00Z'::timestamptz,
      null::text, null::text, null::text, null::int, null::int, null::text, null::timestamptz, 0, null::timestamptz)::text,
  'S1 BATCH-A: brand A, KIL-TEST, source seed_send_log, status complete, recipient_count 100, confirmed_at = dispatched_at = queued_at, the portal-only columns null');
select is((select batch_key from pg_temp.send('BATCH-A')), 'BATCH-A', 'S2 batch_key stored btrimmed');
select is((select row(recipient_count, confirmed_at)::text from pg_temp.send('BATCH-G')), row(0, '2026-03-22T08:00:00Z'::timestamptz)::text,
  'S3 BATCH-G: zero recipients accepted, a zone-less stamp read as UTC, the status column ignored');
select is((select count(*) from public.sends where source = 'seed_send_log' and brand_id = pg_temp.brand('SENDLOGTEST-A')), 2::bigint, 'S4 two seed sends in brand A after r1');
select is((select count(*) from public.send_recipients r join public.sends s on s.id = r.send_id where s.source = 'seed_send_log'), 0::bigint, 'S5 a seed send has no recipient snapshot');
select is((select count(*) from public.provider_batches p join public.sends s on s.id = p.send_id where s.source = 'seed_send_log'), 0::bigint, 'S5 a seed send has no provider batch');

-- the campaign's reported_* are never "fixed" from the send log (FR-10 / FR-20)
select is((select row(reported_sent, reported_delivered)::text from public.campaigns where external_id = 'KIL-TEST'), row(10640, 10000)::text,
  'S6 KIL-TEST reported_sent / reported_delivered untouched (9,800 ≠ 10,640 is expected)');

-- ============================================================================
-- I: idempotency — the same run_id (report rewritten) and a fresh run_id over the same file → inserted 0.
-- ============================================================================
create temp table t_r1b as select internal.import_send_log('00000000-0000-4000-8000-00000000a0a1') as s;
select is((select s from t_r1b) - 'warnings' - 'warned_rows',
  '{"staged": 11, "rejected": 6, "routed": 0, "candidates": 2, "inserted": 0, "updated": 0, "unchanged": 2, "already_present": 2, "loaded": 2, "duplicates": 3}'::jsonb,
  'I1 same run_id again: inserted 0, already_present = candidates, everything else identical');
select is((select count(*) from public.sends where source = 'seed_send_log' and brand_id = pg_temp.brand('SENDLOGTEST-A')), 2::bigint, 'I2 sends count unchanged after the re-run');
select is((select count(*) from public.import_runs where id = '00000000-0000-4000-8000-00000000a0a1'), 1::bigint, 'I3 still one import_runs row for the run (report replaced)');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a1' and severity = 'reject'), 6::bigint, 'I4 the rewritten report has the same six rejects (not twelve)');

-- fresh run_id, only the clean rows re-staged (the seed re-stages every file under a new run_id each time)
select pg_temp.lstage(r, 1, array['BATCH-A', 'KIL-TEST', '2026-03-17T07:15:00Z', '100', 'sent']) from (select '00000000-0000-4000-8000-00000000a0a2'::uuid r) t;
select pg_temp.lstage(r, 2, array['BATCH-G', 'KIL-TEST', '2026-03-22 08:00', '0', 'sent'])       from (select '00000000-0000-4000-8000-00000000a0a2'::uuid r) t;
select pg_temp.lstage(r, 3, array['BATCH-A', 'KIL-TEST', '2026-03-17T07:15:00Z', '999', 'sent']) from (select '00000000-0000-4000-8000-00000000a0a2'::uuid r) t;  -- would win in-file, but the key already exists
create temp table t_r2 as select internal.import_send_log('00000000-0000-4000-8000-00000000a0a2') as s;
select is((select s from t_r2) - 'warnings' - 'warned_rows',
  '{"staged": 3, "rejected": 0, "routed": 0, "candidates": 2, "inserted": 0, "updated": 0, "unchanged": 2, "already_present": 2, "loaded": 2, "duplicates": 1}'::jsonb,
  'I5 fresh run_id over the same batches: inserted 0, already_present 2');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a2' and severity = 'reject'), 0::bigint, 'I6 zero reject issues in the second run');
select is((select count(*) from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0a2' and severity = 'warn'), 1::bigint, 'I6 the in-file duplicate still warns (row 1 superseded by row 3)');
select is((select recipient_count from pg_temp.send('BATCH-A')), 100, 'I7 an existing seed send is never updated (999 ignored — history is append-only)');
select is((select count(*) from public.sends where source = 'seed_send_log' and brand_id = pg_temp.brand('SENDLOGTEST-A')), 2::bigint, 'I8 sends count still 2');
select is((select count(*) from public.import_runs where brand_id = pg_temp.brand('SENDLOGTEST-A') and entity = 'send_log'), 2::bigint, 'I9 two import_runs rows (one per run_id), like every other importer');

-- ============================================================================
-- P: a complete seed send never blocks a later portal send of the same campaign (FR-21).
-- ============================================================================
select lives_ok($$
  insert into public.sends (brand_id, campaign_id, status, source, recipient_count)
  values ((select id from public.brands where code = 'SENDLOGTEST-A'), (select id from public.campaigns where external_id = 'KIL-TEST'), 'pending', 'portal', 1)
$$, 'P1 a pending portal send on KIL-TEST is accepted next to the complete seed send (partial unique index never fires on complete)');
select is((select count(*) from public.sends where campaign_id = (select id from public.campaigns where external_id = 'KIL-TEST')), 3::bigint, 'P2 KIL-TEST now has three sends: BATCH-A, BATCH-G and the pending portal send');

-- ============================================================================
-- B: another brand's file loads under that brand; RLS keeps it out of brand A's view.
-- ============================================================================
select pg_temp.lstage(r, 1, array['BATCH-B1', 'B-ONLY', '2026-03-23T07:15:00Z', '7', 'sent'], 'SENDLOGTEST-B', 'test-send-log-b.csv') from (select '00000000-0000-4000-8000-00000000a0b1'::uuid r) t;
select pg_temp.lstage(r, 2, array['BATCH-B2', 'KIL-TEST', '2026-03-23T07:15:00Z', '7', 'sent'], 'SENDLOGTEST-B', 'test-send-log-b.csv') from (select '00000000-0000-4000-8000-00000000a0b1'::uuid r) t;  -- A's campaign: unknown in B
select pg_temp.lstage(r, 3, array['BATCH-A', 'B-ONLY', '2026-03-23T07:15:00Z', '7', 'sent'], 'SENDLOGTEST-B', 'test-send-log-b.csv') from (select '00000000-0000-4000-8000-00000000a0b1'::uuid r) t;   -- key taken by brand A: do nothing
create temp table t_b1 as select internal.import_send_log('00000000-0000-4000-8000-00000000a0b1') as s;
select is((select s from t_b1) - 'warnings' - 'warned_rows',
  '{"staged": 3, "rejected": 1, "routed": 0, "candidates": 2, "inserted": 1, "updated": 0, "unchanged": 1, "already_present": 1, "loaded": 2, "duplicates": 0}'::jsonb,
  'B1 brand B: B-ONLY loads, KIL-TEST is unknown in B, BATCH-A already present (global key) → inserted 1');
select is((select row(brand_id, campaign_id)::text from pg_temp.send('BATCH-B1')),
  row(pg_temp.brand('SENDLOGTEST-B'), (select id from public.campaigns where external_id = 'B-ONLY'))::text, 'B2 BATCH-B1 stored under brand B');
select is(pg_temp.reasons('00000000-0000-4000-8000-00000000a0b1', 'reject', 2), 'unknown_campaign', 'B3 brand A''s campaign is unknown to a brand-B file');
select is((select brand_id from pg_temp.send('BATCH-A')), pg_temp.brand('SENDLOGTEST-A'), 'B4 BATCH-A still belongs to brand A (the B row did nothing)');
select is((select brand_id from public.import_issues where run_id = '00000000-0000-4000-8000-00000000a0b1' and row_no = 2), pg_temp.brand('SENDLOGTEST-B'), 'B5 the issue carries the source file''s brand');

select set_config('sendlog.brand_a', pg_temp.brand('SENDLOGTEST-A')::text, true);   -- pg_temp functions are not executable as authenticated (S17)
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
select is(public.current_brand_id(), current_setting('sendlog.brand_a')::uuid, 'V1 the analyst resolves to brand A');
select is((select count(*) from public.sends where source = 'seed_send_log'), 2::bigint, 'V2 the analyst sees brand A''s two seed sends only (BATCH-B1 invisible)');
select is((select string_agg(batch_key, ',' order by batch_key) from public.sends where source = 'seed_send_log'), 'BATCH-A,BATCH-G', 'V3 … BATCH-A and BATCH-G');
select is((select count(*) from public.import_runs where entity = 'send_log'), 2::bigint, 'V4 the analyst sees brand A''s two send_log runs only');
select throws_ok($$ select internal.import_send_log('00000000-0000-4000-8000-00000000a0a1') $$, '42501', null, 'V5 authenticated cannot call the importer');
reset role;
select is(current_user::text, 'postgres', 'Z1 role restored before finish');

select * from finish();
rollback;
