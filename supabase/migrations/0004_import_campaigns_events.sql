-- 0004_import_campaigns_events.sql — the campaigns and events importers (Story 2.4; architecture D-3, D-4;
-- Story-Time amendments S16, S18).
--
-- 0003_import.sql is frozen (pushed to hosted after Story 2.3 — S18), so the two remaining seed
-- normalisers and importers live here. Same contract as internal.import_contacts: every keep /
-- reject / warn rule is SQL, one import_runs row per staged file (id = the staging run_id), issues
-- carry the SOURCE file's brand_id, reason codes are stable lower_snake, re-running is a no-op on
-- the data tables and rewrites the run's report. Run as postgres by scripts/seed; never exposed.
--
-- Order (D-3): every contacts file of every brand → campaigns per brand → events per brand. Events
-- must follow ALL contacts files (1,680 Kilele contacts exist only in the delta) and the brand's
-- campaigns (or every event warns unknown_campaign). The send log is staged only (Story 4.5).
-- Nothing here sets suppressed_at (D-4 / amendment #17 — Story 6.2 backfills it from these rows).

-- ---------------------------------------------------------------------------
-- Normalisers (internal, immutable, search_path pinned; unknown is null — amendment #9).
-- ---------------------------------------------------------------------------

-- PRD FR-7: spend — a decimal with a comma (Marrakech `221,09`) or a point; blank or anything else → null.
create or replace function internal.normalize_spend(p text) returns numeric
language sql immutable set search_path = '' as $$
  select case when v ~ '^-?\d+([.,]\d+)?$' then replace(v, ',', '.')::numeric end
  from (select btrim(coalesce(p, ''))) as t(v)
$$;

-- PRD FR-7: reported counts — non-negative integer digits only (int4 range); blank or anything else → null.
create or replace function internal.normalize_int(p text) returns int
language sql immutable set search_path = '' as $$
  select case when v ~ '^\d{1,10}$' then (case when v::bigint <= 2147483647 then v::int end) end   -- nested CASE: the cast only runs on digits
  from (select btrim(coalesce(p, ''))) as t(v)
$$;

-- ---------------------------------------------------------------------------
-- internal.import_campaigns(p_run_id) — one staged campaigns file → public.campaigns + the run's report.
--
-- Staged positions (Story 2.2 canonical order): cols[1..13] = external_id, name, channel, target_country,
-- reported_sent, reported_delivered, reported_bounced, reported_opens, reported_clicks, spend, sent_at,
-- send_local_time, parent_external_id.
--
-- Reject wrong_column_count / repeated_header / blank_external_id. Warn duplicate_external_id (last row
-- wins), channel_unknown (lower(btrim) ∉ {email, sms} — still stored), target_country_unknown (non-blank but
-- normalize_country null), spend_unparseable / reported_count_unparseable / sent_at_unparseable (non-blank
-- but unparseable → null; a blank is simply null, not warned), nul_bytes_stripped. Upsert: source columns
-- only, strictly newer (as_of, file_rank) wins. Second pass over the WHOLE brand: parent_campaign_id from
-- parent_external_id within the brand only (idempotent, `is distinct from`; a pointer that no longer
-- resolves is cleared); this run's rows whose pointer resolves only in another brand warn
-- parent_not_in_brand, nowhere → parent_unknown; both leave parent_campaign_id null (FR-8).
-- ---------------------------------------------------------------------------
create or replace function internal.import_campaigns(p_run_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_file text;
  v_brand_code text;
  v_brand_id uuid;
  v_as_of date;
  v_rank int;
  v_inserted bigint;
  v_updated bigint;
  v_summary jsonb;
begin
  select s.source_file, s.file_brand, s.as_of, s.file_rank
    into v_file, v_brand_code, v_as_of, v_rank
  from staging.stage_campaigns s where s.run_id = p_run_id limit 1;
  if v_file is null then
    raise exception 'invalid_input' using hint = 'no staged rows for run ' || p_run_id;
  end if;
  select b.id into v_brand_id from public.brands b where b.code = v_brand_code;
  if v_brand_id is null then
    raise exception 'invalid_input' using hint = 'file_brand ' || v_brand_code || ' is not a known brand';
  end if;

  -- Re-running the same staged run replaces its report (issues cascade); campaigns are unaffected
  -- because the upsert below is a no-op for rows that are not strictly newer.
  delete from public.import_runs where id = p_run_id;
  insert into public.import_runs (id, brand_id, brand_code, source_file, entity)
  values (p_run_id, v_brand_id, v_brand_code, v_file, 'campaigns');

  -- cols[n] is null on ragged rows (rejected first). Guard covers several runs in one transaction (pgTAP).
  if to_regclass('pg_temp._k') is not null then drop table pg_temp._k; end if;
  create temp table _k on commit drop as
  select s.id as stage_id, s.row_no, s.ncols, s.had_nul,
         nullif(btrim(s.cols[1]), '')                as external_id,
         nullif(btrim(s.cols[2]), '')                as name,
         s.cols[3]                                   as raw_channel,
         nullif(lower(btrim(s.cols[3])), '')         as channel,
         s.cols[4]                                   as raw_target_country,
         internal.normalize_country(s.cols[4])       as target_country,
         s.cols[5]                                   as raw_sent,
         internal.normalize_int(s.cols[5])           as reported_sent,
         s.cols[6]                                   as raw_delivered,
         internal.normalize_int(s.cols[6])           as reported_delivered,
         s.cols[7]                                   as raw_bounced,
         internal.normalize_int(s.cols[7])           as reported_bounced,
         s.cols[8]                                   as raw_opens,
         internal.normalize_int(s.cols[8])           as reported_opens,
         s.cols[9]                                   as raw_clicks,
         internal.normalize_int(s.cols[9])           as reported_clicks,
         s.cols[10]                                  as raw_spend,
         internal.normalize_spend(s.cols[10])        as spend,
         s.cols[11]                                  as raw_sent_at,
         internal.normalize_signup_at(s.cols[11])    as sent_at,
         nullif(s.cols[12], '')                      as send_local_time,
         nullif(btrim(s.cols[13]), '')               as parent_external_id,
         case
           when s.ncols <> 13 then 'wrong_column_count'
           when btrim(s.cols[1]) = 'external_id' then 'repeated_header'
           when nullif(btrim(s.cols[1]), '') is null then 'blank_external_id'
         end                                         as reject_reason,
         null::int                                   as dup_rank
  from staging.stage_campaigns s
  where s.run_id = p_run_id;

  -- In-file duplicates: last row (highest row_no) wins per external_id (a campaigns file never routes).
  update pg_temp._k k
     set dup_rank = d.r
    from (select stage_id, row_number() over (partition by external_id order by row_no desc) as r
            from pg_temp._k where reject_reason is null) d
   where d.stage_id = k.stage_id;

  -- Issues: rejects (one per row).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, k.row_no, 'reject', k.reject_reason,
         case k.reject_reason when 'wrong_column_count' then jsonb_build_object('value', k.ncols) end
  from pg_temp._k k
  where k.reject_reason is not null;

  -- Warnings: per (row, reason) — a superseded duplicate gets only duplicate_external_id (S9).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, k.row_no, 'warn', w.reason, w.detail
  from pg_temp._k k
  cross join lateral (values
    ('duplicate_external_id',      k.dup_rank > 1,                                                                    jsonb_build_object('value', k.external_id)),
    ('channel_unknown',            k.dup_rank = 1 and coalesce(k.channel, '') not in ('email', 'sms'),               jsonb_build_object('value', k.raw_channel)),
    ('target_country_unknown',     k.dup_rank = 1 and btrim(coalesce(k.raw_target_country, '')) <> '' and k.target_country is null, jsonb_build_object('value', k.raw_target_country)),
    ('spend_unparseable',          k.dup_rank = 1 and btrim(coalesce(k.raw_spend, '')) <> '' and k.spend is null,    jsonb_build_object('value', k.raw_spend)),
    ('reported_count_unparseable', k.dup_rank = 1 and btrim(coalesce(k.raw_sent, '')) <> '' and k.reported_sent is null,           jsonb_build_object('column', 'reported_sent', 'value', k.raw_sent)),
    ('reported_count_unparseable', k.dup_rank = 1 and btrim(coalesce(k.raw_delivered, '')) <> '' and k.reported_delivered is null, jsonb_build_object('column', 'reported_delivered', 'value', k.raw_delivered)),
    ('reported_count_unparseable', k.dup_rank = 1 and btrim(coalesce(k.raw_bounced, '')) <> '' and k.reported_bounced is null,     jsonb_build_object('column', 'reported_bounced', 'value', k.raw_bounced)),
    ('reported_count_unparseable', k.dup_rank = 1 and btrim(coalesce(k.raw_opens, '')) <> '' and k.reported_opens is null,         jsonb_build_object('column', 'reported_opens', 'value', k.raw_opens)),
    ('reported_count_unparseable', k.dup_rank = 1 and btrim(coalesce(k.raw_clicks, '')) <> '' and k.reported_clicks is null,       jsonb_build_object('column', 'reported_clicks', 'value', k.raw_clicks)),
    ('sent_at_unparseable',        k.dup_rank = 1 and btrim(coalesce(k.raw_sent_at, '')) <> '' and k.sent_at is null,  jsonb_build_object('value', k.raw_sent_at)),
    ('nul_bytes_stripped',         k.dup_rank = 1 and k.had_nul,                                                       null::jsonb)
  ) as w(reason, hit, detail)
  where k.reject_reason is null
    and w.hit;

  -- Upsert: source columns only; strictly newer (as_of, file_rank) wins; parent_campaign_id, brand_id, id,
  -- created_at are never in the SET list (the parent pass below owns parent_campaign_id).
  with up as (
    insert into public.campaigns as c
      (brand_id, external_id, name, channel, target_country, reported_sent, reported_delivered, reported_bounced,
       reported_opens, reported_clicks, spend, sent_at, send_local_time, parent_external_id, as_of, file_rank)
    select v_brand_id, t.external_id, t.name, t.channel, t.target_country, t.reported_sent, t.reported_delivered, t.reported_bounced,
           t.reported_opens, t.reported_clicks, t.spend, t.sent_at, t.send_local_time, t.parent_external_id, v_as_of, v_rank
    from pg_temp._k t
    where t.reject_reason is null and t.dup_rank = 1
    on conflict (brand_id, external_id) do update set
      name = excluded.name, channel = excluded.channel, target_country = excluded.target_country,
      reported_sent = excluded.reported_sent, reported_delivered = excluded.reported_delivered, reported_bounced = excluded.reported_bounced,
      reported_opens = excluded.reported_opens, reported_clicks = excluded.reported_clicks, spend = excluded.spend,
      sent_at = excluded.sent_at, send_local_time = excluded.send_local_time, parent_external_id = excluded.parent_external_id,
      as_of = excluded.as_of, file_rank = excluded.file_rank, updated_at = now()
    where (excluded.as_of, excluded.file_rank) > (c.as_of, c.file_rank)
    returning (c.xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
  from up;

  -- Second pass, whole brand: resolve parent_campaign_id within the brand (idempotent), clear stale pointers.
  update public.campaigns c
     set parent_campaign_id = p.id, updated_at = now()
    from public.campaigns p
   where c.brand_id = v_brand_id
     and c.parent_external_id is not null
     and p.brand_id = c.brand_id
     and p.external_id = c.parent_external_id
     and c.parent_campaign_id is distinct from p.id;
  update public.campaigns c
     set parent_campaign_id = null, updated_at = now()
   where c.brand_id = v_brand_id
     and c.parent_campaign_id is not null
     and not exists (select 1 from public.campaigns p
                      where p.brand_id = c.brand_id and p.external_id = c.parent_external_id);

  -- Unresolved pointers on this run's rows: only in another brand → parent_not_in_brand; nowhere → parent_unknown.
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, k.row_no, 'warn',
         case when exists (select 1 from public.campaigns x where x.external_id = k.parent_external_id and x.brand_id <> v_brand_id)
              then 'parent_not_in_brand' else 'parent_unknown' end,
         jsonb_build_object('value', k.parent_external_id)
  from pg_temp._k k
  where k.reject_reason is null and k.dup_rank = 1
    and k.parent_external_id is not null
    and not exists (select 1 from public.campaigns p where p.brand_id = v_brand_id and p.external_id = k.parent_external_id);

  select jsonb_build_object(
           'staged',      count(*),
           'rejected',    count(*) filter (where k.reject_reason is not null),
           'routed',      0,
           'candidates',  count(*) filter (where k.reject_reason is null and k.dup_rank = 1),
           'inserted',    v_inserted,
           'updated',     v_updated,
           'unchanged',   count(*) filter (where k.reject_reason is null and k.dup_rank = 1) - v_inserted - v_updated,
           'loaded',      count(*) filter (where k.reject_reason is null and k.dup_rank = 1),
           'duplicates',  count(*) filter (where k.dup_rank > 1),
           'warnings',    (select count(*) from public.import_issues i where i.run_id = p_run_id and i.severity = 'warn'),
           'warned_rows', (select count(distinct i.row_no) from public.import_issues i where i.run_id = p_run_id and i.severity = 'warn'))
    into v_summary
  from pg_temp._k k;

  update public.import_runs set finished_at = now(), summary = v_summary where id = p_run_id;
  drop table pg_temp._k;
  return v_summary;
end $$;

-- ---------------------------------------------------------------------------
-- internal.import_events(p_run_id) — one staged events file → public.events + the run's report.
--
-- Staged positions: cols[1..6] = event_id, contact_external_id, campaign_external_id, type, channel, occurred_at.
--
-- Reject wrong_column_count / repeated_header / blank_event_id / unknown_contact (no contacts row with
-- brand_id = the file brand and that external_id) — UNLESS a contact with that external_id was routed
-- out of the file brand (routed_from = the file brand code), in which case the event is stored under
-- that contact's brand with warn event_follows_routed_contact ("events follow a routed contact", D-3).
-- Campaigns are looked up in the FILE brand only (Karoo's CMP-014 ≠ Kilele's CMP-014); an event that
-- followed a routed contact never gets a cross-brand campaign pointer → campaign_id null + unknown_campaign.
-- Warn unknown_campaign (kept for contactability, excluded from campaign performance — FR-27),
-- type_unknown (normalize_event_type → unknown, still stored), occurred_at_unparseable,
-- duplicate_event_id (in-file, last row wins), nul_bytes_stripped. Insert source = 'seed' with
-- on conflict (brand_id, source, event_id) do nothing; already_present = candidates − inserted.
-- ---------------------------------------------------------------------------
create or replace function internal.import_events(p_run_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_file text;
  v_brand_code text;
  v_brand_id uuid;
  v_inserted bigint;
  v_summary jsonb;
begin
  select s.source_file, s.file_brand
    into v_file, v_brand_code
  from staging.stage_events s where s.run_id = p_run_id limit 1;
  if v_file is null then
    raise exception 'invalid_input' using hint = 'no staged rows for run ' || p_run_id;
  end if;
  select b.id into v_brand_id from public.brands b where b.code = v_brand_code;
  if v_brand_id is null then
    raise exception 'invalid_input' using hint = 'file_brand ' || v_brand_code || ' is not a known brand';
  end if;

  delete from public.import_runs where id = p_run_id;
  insert into public.import_runs (id, brand_id, brand_code, source_file, entity)
  values (p_run_id, v_brand_id, v_brand_code, v_file, 'events');

  -- h = the contact in the file brand; r = a contact with that external_id routed OUT of the file brand
  -- (one per external_id, lowest brand_id if ever ambiguous); k = the campaign in the file brand.
  if to_regclass('pg_temp._e') is not null then drop table pg_temp._e; end if;
  create temp table _e on commit drop as
  with r as (
    select distinct on (x.external_id) x.external_id, x.id, x.brand_id
    from public.contacts x
    where x.routed_from = v_brand_code
    order by x.external_id, x.brand_id
  )
  select s.id as stage_id, s.row_no, s.ncols, s.had_nul,
         nullif(btrim(s.cols[1]), '')                as event_id,
         s.cols[2]                                   as contact_ext,
         s.cols[3]                                   as campaign_ext,
         s.cols[4]                                   as raw_type,
         public.normalize_event_type(s.cols[4])      as type,
         nullif(lower(btrim(s.cols[5])), '')         as channel,
         s.cols[6]                                   as raw_occurred_at,
         internal.normalize_signup_at(s.cols[6])     as occurred_at,
         s.cols                                      as raw_cols,
         coalesce(h.id, r.id)                        as contact_id,
         coalesce(h.brand_id, r.brand_id)            as brand_id,
         (h.id is null and r.id is not null)         as followed,
         case when h.id is not null then k.id end    as campaign_id,
         case
           when s.ncols <> 6 then 'wrong_column_count'
           when btrim(s.cols[1]) = 'event_id' then 'repeated_header'
           when nullif(btrim(s.cols[1]), '') is null then 'blank_event_id'
           when coalesce(h.id, r.id) is null then 'unknown_contact'
         end                                         as reject_reason,
         null::int                                   as dup_rank
  from staging.stage_events s
  left join public.contacts h on h.brand_id = v_brand_id and h.external_id = s.cols[2]
  left join r on h.id is null and r.external_id = s.cols[2]
  left join public.campaigns k on k.brand_id = v_brand_id and k.external_id = s.cols[3]
  where s.run_id = p_run_id;
  -- A fresh temp table has no statistics; 312k rows join below — analysed so the planner hashes.
  analyze pg_temp._e;

  -- In-file duplicates: last row (highest row_no) wins per (stored brand, event_id).
  update pg_temp._e e
     set dup_rank = d.r
    from (select stage_id, row_number() over (partition by brand_id, event_id order by row_no desc) as r
            from pg_temp._e where reject_reason is null) d
   where d.stage_id = e.stage_id;

  -- Issues: rejects (one per row, detail = the offending value where there is one).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, e.row_no, 'reject', e.reject_reason,
         case e.reject_reason
           when 'wrong_column_count' then jsonb_build_object('value', e.ncols)
           when 'unknown_contact'    then jsonb_build_object('value', e.contact_ext)
         end
  from pg_temp._e e
  where e.reject_reason is not null;

  -- Warnings: per (row, reason) for the rows that land (a superseded duplicate gets only duplicate_event_id).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, e.row_no, 'warn', w.reason, w.detail
  from pg_temp._e e
  cross join lateral (values
    ('duplicate_event_id',           e.dup_rank > 1,                                                                    jsonb_build_object('value', e.event_id)),
    ('event_follows_routed_contact', e.dup_rank = 1 and e.followed,                                                     jsonb_build_object('to', (select b.code from public.brands b where b.id = e.brand_id))),
    ('unknown_campaign',             e.dup_rank = 1 and e.campaign_id is null,                                          jsonb_build_object('value', e.campaign_ext)),
    ('type_unknown',                 e.dup_rank = 1 and e.type = 'unknown',                                             jsonb_build_object('value', e.raw_type)),
    ('occurred_at_unparseable',      e.dup_rank = 1 and btrim(coalesce(e.raw_occurred_at, '')) <> '' and e.occurred_at is null, jsonb_build_object('value', e.raw_occurred_at)),
    ('nul_bytes_stripped',           e.dup_rank = 1 and e.had_nul,                                                      null::jsonb)
  ) as w(reason, hit, detail)
  where e.reject_reason is null
    and w.hit;

  -- Insert: seed rows are immutable — an event already present is left alone (do nothing tolerates
  -- in-statement duplicates, but dup_rank = 1 is still what counts and warns them).
  insert into public.events (brand_id, source, event_id, type, contact_id, campaign_id, channel, occurred_at, raw)
  select e.brand_id, 'seed', e.event_id, e.type, e.contact_id, e.campaign_id, e.channel, e.occurred_at, jsonb_build_object('cols', e.raw_cols)
  from pg_temp._e e
  where e.reject_reason is null and e.dup_rank = 1
  on conflict (brand_id, source, event_id) do nothing;
  get diagnostics v_inserted = row_count;

  select jsonb_build_object(
           'staged',          count(*),
           'rejected',        count(*) filter (where e.reject_reason is not null),
           'routed',          count(*) filter (where e.reject_reason is null and e.dup_rank = 1 and e.followed),
           'candidates',      count(*) filter (where e.reject_reason is null and e.dup_rank = 1),
           'inserted',        v_inserted,
           'updated',         0,
           'unchanged',       count(*) filter (where e.reject_reason is null and e.dup_rank = 1) - v_inserted,
           'already_present', count(*) filter (where e.reject_reason is null and e.dup_rank = 1) - v_inserted,
           'loaded',          count(*) filter (where e.reject_reason is null and e.dup_rank = 1),
           'duplicates',      count(*) filter (where e.dup_rank > 1),
           'warnings',        (select count(*) from public.import_issues i where i.run_id = p_run_id and i.severity = 'warn'),
           'warned_rows',     (select count(distinct i.row_no) from public.import_issues i where i.run_id = p_run_id and i.severity = 'warn'))
    into v_summary
  from pg_temp._e e;

  update public.import_runs set finished_at = now(), summary = v_summary where id = p_run_id;
  drop table pg_temp._e;
  return v_summary;
end $$;
