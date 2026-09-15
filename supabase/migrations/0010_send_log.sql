-- 0010_send_log.sql — the seed send-log importer (Story 4.5; architecture D-2, D-3; PRD FR-10, FR-20, FR-21;
-- Story-Time amendment S20: 0006_sends.sql is applied on hosted and frozen, so this lives in its own migration).
--
-- internal.import_send_log(p_run_id) — one staged send-log file (staging.stage_send_log, Story 2.2) → public.sends
-- rows with source = 'seed_send_log', the last of the four importers in the fixed D-3 order (users → contacts →
-- campaigns → events → send log). Same contract as internal.import_contacts / _campaigns / _events (Stories 2.3 / 2.4):
-- every keep / reject / warn rule is SQL, one import_runs row per staged file (id = the staging run_id, entity
-- 'send_log'), issues carry the file's brand_id, reason codes are stable lower_snake, re-running is a no-op on
-- sends and rewrites the run's report. Run as postgres by scripts/seed; never exposed, never granted.
--
-- Staged positions (Story 2.2 canonical order): cols[1..5] = batch_key, campaign_external_id, queued_at,
-- recipient_count, status.
--
-- Rules, in order:
--   1. structural rejects — wrong_column_count (ncols <> 5), blank_batch_key;
--   2. collapse — distinct on (batch_key), last row (highest row_no) wins; every superseded row gets ONE warn
--      duplicate_batch_key and nothing else (its values never reach the table);
--   3. value rejects on the surviving row — unknown_campaign (no campaign with that external_id in the FILE brand;
--      never resolved by external_id alone across brands), unparseable_queued_at (internal.normalize_signup_at,
--      ISO-8601 UTC), unparseable_recipient_count (internal.normalize_int);
--   4. insert sends(brand_id, campaign_id, source 'seed_send_log', batch_key, status 'complete', recipient_count,
--      confirmed_at = dispatched_at = queued_at) on conflict (batch_key) do nothing — the UNIQUE constraint on
--      sends.batch_key (Story 4.1) is the idempotency key; already_present = candidates − inserted.
--
-- The seed file's status column is always `sent`, so every batch is `complete` and nothing else from it is stored;
-- confirmed_by / body_sha256 / batch_id / accepted_count stay null (the UI tolerates that). `complete` is terminal, so
-- uq_sends_one_active_per_campaign never fires and a seed send never blocks a later portal send (FR-21). Send-log
-- batches are send HISTORY, never a rate denominator: v_campaign_performance keeps reading the campaign's reported_*
-- (FR-10 / FR-20) — BATCH-0007's 9,800 ≠ KIL-0016's reported_sent 10,640, by design.

create or replace function internal.import_send_log(p_run_id uuid) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_file text;
  v_brand_code text;
  v_brand_id uuid;
  v_inserted bigint;
  v_summary jsonb;
begin
  select s.source_file, s.file_brand
    into v_file, v_brand_code
  from staging.stage_send_log s where s.run_id = p_run_id limit 1;
  if v_file is null then
    raise exception 'invalid_input' using hint = 'no staged rows for run ' || p_run_id;
  end if;
  select b.id into v_brand_id from public.brands b where b.code = v_brand_code;
  if v_brand_id is null then
    raise exception 'invalid_input' using hint = 'file_brand ' || v_brand_code || ' is not a known brand';
  end if;

  -- Re-running the same staged run replaces its report (issues cascade); sends are unaffected because the
  -- insert below does nothing for a batch_key that already exists.
  delete from public.import_runs where id = p_run_id;
  insert into public.import_runs (id, brand_id, brand_code, source_file, entity)
  values (p_run_id, v_brand_id, v_brand_code, v_file, 'send_log');

  -- cols[n] is null on ragged rows (rejected first). Guard covers several runs in one transaction (pgTAP).
  if to_regclass('pg_temp._l') is not null then drop table pg_temp._l; end if;
  create temp table _l on commit drop as
  select s.id as stage_id, s.row_no, s.ncols,
         nullif(btrim(s.cols[1]), '')                as batch_key,
         s.cols[2]                                   as raw_campaign,
         nullif(btrim(s.cols[2]), '')                as campaign_external_id,
         s.cols[3]                                   as raw_queued_at,
         internal.normalize_signup_at(s.cols[3])     as queued_at,
         s.cols[4]                                   as raw_recipient_count,
         internal.normalize_int(s.cols[4])           as recipient_count,
         null::uuid                                  as campaign_id,
         case
           when s.ncols <> 5 then 'wrong_column_count'
           when nullif(btrim(s.cols[1]), '') is null then 'blank_batch_key'
         end                                         as reject_reason,
         null::int                                   as dup_rank
  from staging.stage_send_log s
  where s.run_id = p_run_id;

  -- Collapse: distinct on (batch_key) — the last row (highest row_no) wins among the structurally valid rows.
  update pg_temp._l l
     set dup_rank = d.r
    from (select stage_id, row_number() over (partition by batch_key order by row_no desc) as r
            from pg_temp._l where reject_reason is null) d
   where d.stage_id = l.stage_id;

  -- Resolve the campaign in the FILE brand only (Karoo's CMP-014 ≠ Kilele's CMP-014), then the value rejects on
  -- the surviving row of each batch. A superseded row is never judged: it only warns duplicate_batch_key.
  update pg_temp._l l
     set campaign_id = k.id
    from public.campaigns k
   where k.brand_id = v_brand_id and k.external_id = l.campaign_external_id
     and l.reject_reason is null and l.dup_rank = 1;
  update pg_temp._l l
     set reject_reason = case
           when l.campaign_id is null then 'unknown_campaign'
           when l.queued_at is null then 'unparseable_queued_at'
           when l.recipient_count is null then 'unparseable_recipient_count'
         end
   where l.reject_reason is null and l.dup_rank = 1
     and (l.campaign_id is null or l.queued_at is null or l.recipient_count is null);

  -- Issues: rejects (one per row, detail = the offending raw value where there is one).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, l.row_no, 'reject', l.reject_reason,
         case l.reject_reason
           when 'wrong_column_count'          then jsonb_build_object('value', l.ncols)
           when 'unknown_campaign'            then jsonb_build_object('value', l.raw_campaign)
           when 'unparseable_queued_at'       then jsonb_build_object('value', l.raw_queued_at)
           when 'unparseable_recipient_count' then jsonb_build_object('value', l.raw_recipient_count)
         end
  from pg_temp._l l
  where l.reject_reason is not null;

  -- Warnings: one duplicate_batch_key per superseded row (BATCH-0003 ×3 → 1 send + 2 warnings).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, l.row_no, 'warn', 'duplicate_batch_key', jsonb_build_object('value', l.batch_key)
  from pg_temp._l l
  where l.reject_reason is null and l.dup_rank > 1;

  -- Insert: seed sends are immutable history — a batch_key already present is left alone (unique constraint,
  -- not the partial index, so on conflict qualifies). Terminal from birth: confirmed_at = dispatched_at = queued_at.
  insert into public.sends (brand_id, campaign_id, source, batch_key, status, recipient_count, confirmed_at, dispatched_at)
  select v_brand_id, l.campaign_id, 'seed_send_log', l.batch_key, 'complete', l.recipient_count, l.queued_at, l.queued_at
  from pg_temp._l l
  where l.reject_reason is null and l.dup_rank = 1
  on conflict (batch_key) do nothing;
  get diagnostics v_inserted = row_count;

  select jsonb_build_object(
           'staged',          count(*),
           'rejected',        count(*) filter (where l.reject_reason is not null),
           'routed',          0,
           'candidates',      count(*) filter (where l.reject_reason is null and l.dup_rank = 1),
           'inserted',        v_inserted,
           'updated',         0,
           'unchanged',       count(*) filter (where l.reject_reason is null and l.dup_rank = 1) - v_inserted,
           'already_present', count(*) filter (where l.reject_reason is null and l.dup_rank = 1) - v_inserted,
           'loaded',          count(*) filter (where l.reject_reason is null and l.dup_rank = 1),
           'duplicates',      count(*) filter (where l.reject_reason is null and l.dup_rank > 1),
           'warnings',        (select count(*) from public.import_issues i where i.run_id = p_run_id and i.severity = 'warn'),
           'warned_rows',     (select count(distinct i.row_no) from public.import_issues i where i.run_id = p_run_id and i.severity = 'warn'))
    into v_summary
  from pg_temp._l l;

  update public.import_runs set finished_at = now(), summary = v_summary where id = p_run_id;
  drop table pg_temp._l;
  return v_summary;
end $$;
comment on function internal.import_send_log(uuid) is
  'The seed send-log importer (Story 4.5): reject wrong_column_count / blank_batch_key, collapse by batch_key (last row wins, duplicate_batch_key warn per superseded row), reject unknown_campaign (file brand only) / unparseable_queued_at / unparseable_recipient_count, insert sends source seed_send_log, status complete, confirmed_at = dispatched_at = queued_at, on conflict (batch_key) do nothing. Run by pnpm seed as postgres; not exposed.';
revoke execute on function internal.import_send_log(uuid) from public, anon, authenticated, service_role;
