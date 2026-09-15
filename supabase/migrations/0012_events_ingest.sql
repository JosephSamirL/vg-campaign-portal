-- 0012_events_ingest.sql — ingest events in any order, any number of times (Story 6.2; architecture D-2, D-4, D-5, D-8;
-- Step-3 amendments #6, #17; Story-Time amendments S4, S10, S11, S19, S20; docs/provider-api.md `## Probe 2026-09-15`,
-- which is authoritative over the story text wherever the two differ).
--
-- Part 0 — carried in from the Epic 2 / Epic 4 reviews (migrations are append-only, so the fixes are `create or replace`
--          copies of the frozen 0003 / 0004 / 0008 / 0009 / 0010 functions; every untouched line is byte-identical):
--   S19 (1) an event that follows a routed contact into another brand is stored under a source-qualified id
--           (`<file brand>:<event_id>`) — seed ids overlap 100 % across brands, so the bare id collided with (or was
--           silently dropped by) the target brand's own native event;
--       (2) normalize_int / normalize_spend match ASCII digits only (`[0-9]`, not `\d` — PG ARE `\d` matches Unicode
--           digits and the cast then raised and aborted the whole import);
--       (3) the parent pass never lets a campaign parent itself (self-pointer → parent_unknown);
--       (4) import_runs.finished_at = clock_timestamp() (now() is transaction time = started_at);
--       (5) unknown_campaign only for a NON-BLANK pointer; a followed row's unresolved pointer is campaign_not_followed.
--   4.5 review: import_send_log warns batch_key_taken (key held by another brand's / campaign's send — was a silent
--           already_present) and rejects unsupported_status (status ≠ `sent`) and repeated_header.
--   Epic 4 review (D-7): public.dispatch_mark_partial(send, reason) — the CAS confirmed|dispatched → partial with a
--           failure_reason, called by the dispatch-send Edge Function on a 5xx / timeout while DISPATCH_RETRY_ENABLED
--           <> 'on' (sweep off ⇒ unknown outcome is partial immediately) and by the sweep; the sweep's attempt cap stamps
--           dispatch_outcome_unknown_after_3_attempts; a 24-hour age ceiling turns older candidates partial with
--           dispatch_expired instead of re-POSTing a day-old snapshot; dispatch_record_result handles a
--           provider_batches.batch_id collision inside the function (→ failed, duplicate_batch_id) instead of raising
--           after the sends CAS and rolling a real 2xx back.
--
-- Part 1 — the story (FR-24–FR-27):
--   trg_events_insert_suppress — AFTER INSERT on events, `when (contact_id is not null and type in (bounced,
--           unsubscribed, complained))` (never fires for the 373k seed opens/clicks/deliveries — amendment #17):
--           contacts.suppressed_at = coalesce(occurred_at, now()) / suppressed_reason = type, MONOTONIC on presence and
--           value (S10): set when null, moved only EARLIER, never cleared, never later — so the value is the same
--           whatever the arrival order. A backfill applies the same rule to the seed events loaded in Epic 2 (S4).
--   internal.ingest_provider_events(send, batch, events) — one page of the provider's report stream: per-batch
--           advisory lock (send_in_progress), tenancy from the send's snapshot only (brand_code in the payload is
--           never read), recipient resolved ONLY through the send's send_recipients — an event for anyone else (the
--           provider forges one per batch for a real contact of another brand, probe d2) is dropped and counted as
--           foreign_recipient; type through normalize_event_type (unknown kept); occurred_at verbatim, future allowed;
--           dedupe on (batch_id, event_id) through the natural key (the stored event_id is `<batch_id>:<provider id>`,
--           the raw payload keeps the provider's own); a poison element never aborts the call.
--   internal.recipient_state(send, contact) — precedence, not time, decides the visible terminal state
--           (unsubscribed | complained > bounced > delivered; probe d2 — `delivered` is re-appended after `opened`).
--   internal.complete_sends() — reporting → complete 24 h after dispatched_at (S11: the 24 h rule only).
--   internal.poll_log + internal.poll_status (S11 + `deferred` from the probe: a run that ran out of budget waiting on
--           a 503 Retry-After) — unexposed, no grants; public.v_last_sync (security_invoker) and
--           public.last_poll_status() (secdef, two columns, brand-agnostic: poller health is global) are the surfaces.
--   v_campaign_performance — the reported row per campaign plus one source = 'portal' row per dispatched portal send
--           (sent = accepted_count; delivered / bounced / unsubscribed distinct per contact, opened / clicked total).
--
-- Every function `set search_path = ''`, schema-qualified; error codes raised as P0001 with the code as the message.

-- ===========================================================================
-- Part 0a — S19 importer fixes (2): ASCII digits only
-- ===========================================================================
create or replace function internal.normalize_spend(p text) returns numeric
language sql immutable set search_path = '' as $$
  select case when v ~ '^-?[0-9]+([.,][0-9]+)?$' then replace(v, ',', '.')::numeric end
  from (select btrim(coalesce(p, ''))) as t(v)
$$;

create or replace function internal.normalize_int(p text) returns int
language sql immutable set search_path = '' as $$
  select case when v ~ '^[0-9]{1,10}$' then (case when v::bigint <= 2147483647 then v::int end) end   -- nested CASE: the cast only runs on digits
  from (select btrim(coalesce(p, ''))) as t(v)
$$;

-- ===========================================================================
-- Part 0a — S19 (4): import_contacts — byte-identical to 0003 except finished_at = clock_timestamp()
-- ===========================================================================
create or replace function internal.import_contacts(p_run_id uuid) returns jsonb
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
  from staging.stage_contacts s where s.run_id = p_run_id limit 1;
  if v_file is null then
    raise exception 'invalid_input' using hint = 'no staged rows for run ' || p_run_id;
  end if;
  select b.id into v_brand_id from public.brands b where b.code = v_brand_code;
  if v_brand_id is null then
    raise exception 'invalid_input' using hint = 'file_brand ' || v_brand_code || ' is not a known brand';
  end if;

  -- Re-running the same staged run replaces its report (issues cascade); contacts are unaffected
  -- because the upsert below is a no-op for rows that are not strictly newer.
  delete from public.import_runs where id = p_run_id;
  insert into public.import_runs (id, brand_id, brand_code, source_file, entity)
  values (p_run_id, v_brand_id, v_brand_code, v_file, 'contacts');

  -- Staged positions follow Story 2.2's canonical order; cols[n] is null on ragged rows (rejected first).
  -- The temp table is dropped on commit; the guard covers several runs inside one transaction (pgTAP).
  if to_regclass('pg_temp._c') is not null then drop table pg_temp._c; end if;
  create temp table _c on commit drop as
  select s.id as stage_id, s.row_no, s.ncols, s.had_nul,
         nullif(btrim(s.cols[1]), '')                as external_id,
         nullif(btrim(s.cols[2]), '')                as full_name,
         s.cols[3]                                   as raw_email,
         internal.normalize_email(s.cols[3])         as email,
         s.cols[4]                                   as raw_phone,
         internal.normalize_phone(s.cols[4])         as phone,
         s.cols[5]                                   as raw_country,
         internal.normalize_country(s.cols[5])       as country,
         nullif(btrim(s.cols[6]), '')                as city,
         s.cols[7]                                   as raw_signup_at,
         internal.normalize_signup_at(s.cols[7])     as signup_at,
         s.cols[8]                                   as raw_status,
         internal.normalize_status(s.cols[8])        as status,
         s.cols[9]                                   as raw_consent,
         internal.normalize_consent(s.cols[9])       as consent_marketing,
         internal.normalize_signup_at(s.cols[10])    as deleted_at,
         internal.normalize_signup_at(s.cols[11])    as suppressed_until,
         s.cols[12]                                  as raw_brand_code,
         internal.normalize_brand_code(s.cols[12])   as brand_code,
         nullif(s.cols[13], '')                      as notes,
         null::text                                  as reject_reason,
         null::uuid                                  as target_brand_id,
         false                                       as followed,
         null::int                                   as dup_rank
  from staging.stage_contacts s
  where s.run_id = p_run_id;

  -- FR-8 rejections, first match wins.
  update pg_temp._c c set reject_reason = case
    when c.ncols <> 13 then 'wrong_column_count'
    when c.external_id = 'external_id' then 'repeated_header'
    when c.external_id is null then 'blank_external_id'
    when c.signup_at is null then 'bad_signup_at'
    when c.brand_code is not null and not exists (select 1 from public.brands b where b.code = c.brand_code) then 'unknown_brand_code'
  end;

  -- Routing: a non-blank code naming another known brand sends the row there; blank = the file's brand.
  update pg_temp._c c
     set target_brand_id = coalesce((select b.id from public.brands b where b.code = c.brand_code), v_brand_id)
   where c.reject_reason is null;
  -- A fresh temp table has no statistics: analysed here, after target_brand_id is set, so the joins below
  -- (against 80k+ contacts) get hash plans instead of a nested loop per staged row.
  analyze pg_temp._c;

  -- Delta rows follow a contact this brand's earlier file routed away.
  update pg_temp._c c
     set target_brand_id = x.brand_id, followed = true
    from public.contacts x
    join public.brands b on b.id = x.brand_id and b.id <> v_brand_id
   where c.reject_reason is null
     and c.target_brand_id = v_brand_id
     and x.external_id = c.external_id
     and x.routed_from = v_brand_code;

  -- In-file duplicates: last row (highest row_no) wins per (target brand, external_id).
  update pg_temp._c c
     set dup_rank = d.r
    from (select stage_id, row_number() over (partition by target_brand_id, external_id order by row_no desc) as r
            from pg_temp._c where reject_reason is null) d
   where d.stage_id = c.stage_id and c.reject_reason is null;

  -- Issues: rejects (one per row, detail = the offending raw value where there is one).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, c.row_no, 'reject', c.reject_reason,
         case c.reject_reason
           when 'wrong_column_count' then jsonb_build_object('value', c.ncols)
           when 'bad_signup_at'      then jsonb_build_object('value', c.raw_signup_at)
           when 'unknown_brand_code' then jsonb_build_object('value', c.raw_brand_code)
         end
  from pg_temp._c c
  where c.reject_reason is not null;

  -- Warnings: per (row, reason) for rows landing in the file's own brand.
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, c.row_no, 'warn', w.reason, w.detail
  from pg_temp._c c
  cross join lateral (values
    ('duplicate_external_id', c.dup_rank > 1,                                       jsonb_build_object('value', c.external_id)),
    ('blank_brand_code',      c.dup_rank = 1 and c.brand_code is null,              null::jsonb),
    ('consent_unknown',       c.dup_rank = 1 and c.consent_marketing is null,       jsonb_build_object('value', c.raw_consent)),
    ('status_unknown',        c.dup_rank = 1 and c.status is null,                  jsonb_build_object('value', c.raw_status)),
    ('country_unknown',       c.dup_rank = 1 and c.country is null,                 jsonb_build_object('value', c.raw_country)),
    ('email_missing',         c.dup_rank = 1 and btrim(coalesce(c.raw_email, '')) = '',   null::jsonb),
    ('email_invalid',         c.dup_rank = 1 and btrim(coalesce(c.raw_email, '')) <> '' and c.email is null, jsonb_build_object('value', c.raw_email)),
    ('phone_missing',         c.dup_rank = 1 and btrim(coalesce(c.raw_phone, '')) = '',   null::jsonb),
    ('phone_invalid',         c.dup_rank = 1 and btrim(coalesce(c.raw_phone, '')) <> '' and c.phone is null, jsonb_build_object('value', c.raw_phone)),
    ('nul_bytes_stripped',    c.dup_rank = 1 and c.had_nul,                         null::jsonb)
  ) as w(reason, hit, detail)
  where c.reject_reason is null
    and c.target_brand_id = v_brand_id
    and w.hit;

  -- A followed row is routed, so no value warnings (S9) — only the fact that it followed, and where.
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, c.row_no, 'warn', 'followed_routed_contact', jsonb_build_object('to', b.code)
  from pg_temp._c c
  join public.brands b on b.id = c.target_brand_id
  where c.reject_reason is null and c.dup_rank = 1 and c.followed;

  -- Routed rows: one count-only issue per target brand in the SOURCE file's run, never a per-row record (S9).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, null, 'route', 'routed_to_' || lower(b.code), jsonb_build_object('to', b.code, 'count', count(*))
  from pg_temp._c c
  join public.brands b on b.id = c.target_brand_id
  where c.reject_reason is null and c.dup_rank = 1 and c.target_brand_id <> v_brand_id
  group by b.code;

  -- Upsert: source columns only; strictly newer (as_of, file_rank) wins; suppressed_at / suppressed_reason,
  -- brand_id, id, created_at are never in the SET list. dup_rank = 1 is mandatory (one row per key per statement).
  with up as (
    insert into public.contacts as c
      (brand_id, external_id, full_name, email, phone, country, city, signup_at, status, consent_marketing,
       deleted_at, suppressed_until, notes, routed_from, as_of, file_rank)
    select t.target_brand_id, t.external_id, t.full_name, t.email, t.phone, t.country, t.city, t.signup_at, t.status, t.consent_marketing,
           t.deleted_at, t.suppressed_until, t.notes,
           case when t.target_brand_id <> v_brand_id then v_brand_code end,
           v_as_of,
           case when t.target_brand_id <> v_brand_id then v_rank - 1 else v_rank end
    from pg_temp._c t
    where t.reject_reason is null and t.dup_rank = 1
    on conflict (brand_id, external_id) do update set
      full_name = excluded.full_name, email = excluded.email, phone = excluded.phone, country = excluded.country, city = excluded.city,
      signup_at = excluded.signup_at, status = excluded.status, consent_marketing = excluded.consent_marketing,
      deleted_at = excluded.deleted_at, suppressed_until = excluded.suppressed_until, notes = excluded.notes,
      routed_from = excluded.routed_from, as_of = excluded.as_of, file_rank = excluded.file_rank, updated_at = now()
    where (excluded.as_of, excluded.file_rank) > (c.as_of, c.file_rank)
    returning (c.xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
  from up;

  select jsonb_build_object(
           'staged',      count(*),
           'rejected',    count(*) filter (where c.reject_reason is not null),
           'routed',      count(*) filter (where c.reject_reason is null and c.dup_rank = 1 and c.target_brand_id <> v_brand_id),
           'candidates',  count(*) filter (where c.reject_reason is null and c.dup_rank = 1),
           'inserted',    v_inserted,
           'updated',     v_updated,
           'unchanged',   count(*) filter (where c.reject_reason is null and c.dup_rank = 1) - v_inserted - v_updated,
           'loaded',      count(*) filter (where c.reject_reason is null and c.dup_rank = 1),
           'duplicates',  count(*) filter (where c.dup_rank > 1),
           'warnings',    (select count(*) from public.import_issues i where i.run_id = p_run_id and i.severity = 'warn'),
           'warned_rows', (select count(distinct i.row_no) from public.import_issues i where i.run_id = p_run_id and i.severity = 'warn'))
    into v_summary
  from pg_temp._c c;

  update public.import_runs set finished_at = clock_timestamp(), summary = v_summary where id = p_run_id;   -- S19 (4): real finish time, not transaction time
  drop table pg_temp._c;
  return v_summary;
end $$;

-- ===========================================================================
-- Part 0a — S19 (3), (4): import_campaigns — self-pointer guard in the parent pass, clock_timestamp()
-- ===========================================================================
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
     and p.id <> c.id                                   -- S19 (3): a campaign never parents itself
     and c.parent_campaign_id is distinct from p.id;
  update public.campaigns c
     set parent_campaign_id = null, updated_at = now()
   where c.brand_id = v_brand_id
     and c.parent_campaign_id is not null
     and not exists (select 1 from public.campaigns p
                      where p.brand_id = c.brand_id and p.external_id = c.parent_external_id and p.id <> c.id);

  -- Unresolved pointers on this run's rows: only in another brand → parent_not_in_brand; nowhere → parent_unknown.
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, k.row_no, 'warn',
         case when exists (select 1 from public.campaigns x where x.external_id = k.parent_external_id and x.brand_id <> v_brand_id)
              then 'parent_not_in_brand' else 'parent_unknown' end,
         jsonb_build_object('value', k.parent_external_id)
  from pg_temp._k k
  where k.reject_reason is null and k.dup_rank = 1
    and k.parent_external_id is not null
    and not exists (select 1 from public.campaigns p where p.brand_id = v_brand_id and p.external_id = k.parent_external_id
                      and p.external_id <> k.external_id);   -- S19 (3): a self-pointer resolves to nothing → parent_unknown

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

  update public.import_runs set finished_at = clock_timestamp(), summary = v_summary where id = p_run_id;   -- S19 (4)
  drop table pg_temp._k;
  return v_summary;
end $$;

-- ===========================================================================
-- Part 0a — S19 (1), (4), (5): import_events — source-qualified followed ids, unknown_campaign rules, clock_timestamp()
-- ===========================================================================
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
         nullif(btrim(s.cols[1]), '')                as event_id,       -- the file's id, verbatim (kept in raw.cols)
         -- S19 (1): seed event ids overlap 100 % across brands, so an event that FOLLOWS a routed contact into another
         -- brand is stored under a source-qualified id (<file brand>:<id>) and can never collide with — or be silently
         -- dropped by — that brand's own native event of the same id.
         case when h.id is null and r.id is not null
              then v_brand_code || ':' || nullif(btrim(s.cols[1]), '')
              else nullif(btrim(s.cols[1]), '') end  as stored_event_id,
         s.cols[2]                                   as contact_ext,
         s.cols[3]                                   as campaign_ext,
         nullif(btrim(s.cols[3]), '')                as campaign_ptr,   -- S19 (5): a blank pointer is "no campaign", never warned
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

  -- In-file duplicates: last row (highest row_no) wins per (stored brand, stored event_id).
  update pg_temp._e e
     set dup_rank = d.r
    from (select stage_id, row_number() over (partition by brand_id, stored_event_id order by row_no desc) as r
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
    -- S19 (5): unknown_campaign only for a NON-BLANK pointer that resolves to nothing in the file brand; a followed row's
    -- pointer is never resolved across brands by design (D-2), so it gets its own reason instead of a misleading one.
    ('unknown_campaign',             e.dup_rank = 1 and not e.followed and e.campaign_ptr is not null and e.campaign_id is null, jsonb_build_object('value', e.campaign_ext)),
    ('campaign_not_followed',        e.dup_rank = 1 and e.followed and e.campaign_ptr is not null,                      jsonb_build_object('value', e.campaign_ext)),
    ('type_unknown',                 e.dup_rank = 1 and e.type = 'unknown',                                             jsonb_build_object('value', e.raw_type)),
    ('occurred_at_unparseable',      e.dup_rank = 1 and btrim(coalesce(e.raw_occurred_at, '')) <> '' and e.occurred_at is null, jsonb_build_object('value', e.raw_occurred_at)),
    ('nul_bytes_stripped',           e.dup_rank = 1 and e.had_nul,                                                      null::jsonb)
  ) as w(reason, hit, detail)
  where e.reject_reason is null
    and w.hit;

  -- Insert: seed rows are immutable — an event already present is left alone (do nothing tolerates
  -- in-statement duplicates, but dup_rank = 1 is still what counts and warns them).
  insert into public.events (brand_id, source, event_id, type, contact_id, campaign_id, channel, occurred_at, raw)
  select e.brand_id, 'seed', e.stored_event_id, e.type, e.contact_id, e.campaign_id, e.channel, e.occurred_at, jsonb_build_object('cols', e.raw_cols)
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

  update public.import_runs set finished_at = clock_timestamp(), summary = v_summary where id = p_run_id;   -- S19 (4)
  drop table pg_temp._e;
  return v_summary;
end $$;
comment on function internal.import_events(uuid) is
  'The seed events importer (Story 2.4, fixed by 6.2 / S19): an event that follows a routed contact is stored under <file brand>:<event_id>; unknown_campaign only for a non-blank pointer, campaign_not_followed for a followed row''s pointer; finished_at = clock_timestamp(). Never sets suppressed_at (the 6.2 trigger does).';

-- ===========================================================================
-- Part 0b — 4.5 review (e), (f): import_send_log — batch_key_taken, unsupported_status, repeated_header, clock_timestamp()
-- ===========================================================================
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
         s.cols[5]                                   as raw_status,
         lower(btrim(coalesce(s.cols[5], '')))       as status,
         null::uuid                                  as campaign_id,
         case
           when s.ncols <> 5 then 'wrong_column_count'
           when btrim(s.cols[1]) = 'batch_key' then 'repeated_header'          -- 4.5 review (f): like every other importer
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
  -- 4.5 review (f): the file's status column is validated — only `sent` batches are complete history; a queued /
  -- failed / cancelled batch must never import as a terminal `complete` send.
  update pg_temp._l l
     set reject_reason = case
           when l.campaign_id is null then 'unknown_campaign'
           when l.queued_at is null then 'unparseable_queued_at'
           when l.recipient_count is null then 'unparseable_recipient_count'
           when l.status is distinct from 'sent' then 'unsupported_status'
         end
   where l.reject_reason is null and l.dup_rank = 1
     and (l.campaign_id is null or l.queued_at is null or l.recipient_count is null or l.status is distinct from 'sent');

  -- Issues: rejects (one per row, detail = the offending raw value where there is one).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, l.row_no, 'reject', l.reject_reason,
         case l.reject_reason
           when 'wrong_column_count'          then jsonb_build_object('value', l.ncols)
           when 'unknown_campaign'            then jsonb_build_object('value', l.raw_campaign)
           when 'unparseable_queued_at'       then jsonb_build_object('value', l.raw_queued_at)
           when 'unparseable_recipient_count' then jsonb_build_object('value', l.raw_recipient_count)
           when 'unsupported_status'          then jsonb_build_object('value', l.raw_status)
         end
  from pg_temp._l l
  where l.reject_reason is not null;

  -- Warnings: one duplicate_batch_key per superseded row (BATCH-0003 ×3 → 1 send + 2 warnings).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, l.row_no, 'warn', 'duplicate_batch_key', jsonb_build_object('value', l.batch_key)
  from pg_temp._l l
  where l.reject_reason is null and l.dup_rank > 1;

  -- 4.5 review (e): batch_key is unique table-wide. A surviving row whose key already belongs to ANOTHER brand's or
  -- another campaign's send would silently count as already_present; it now also warns batch_key_taken so the import
  -- report shows the collision (the row is still not loaded — the earlier send keeps the key).
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  select v_brand_id, p_run_id, v_file, l.row_no, 'warn', 'batch_key_taken', jsonb_build_object('value', l.batch_key)
  from pg_temp._l l
  where l.reject_reason is null and l.dup_rank = 1
    and exists (select 1 from public.sends x
                 where x.batch_key = l.batch_key
                   and (x.brand_id <> v_brand_id or x.campaign_id <> l.campaign_id));

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

  update public.import_runs set finished_at = clock_timestamp(), summary = v_summary where id = p_run_id;   -- S19 (4)
  drop table pg_temp._l;
  return v_summary;
end $$;
comment on function internal.import_send_log(uuid) is
  'The seed send-log importer (Story 4.5, fixed by 6.2): reject wrong_column_count / repeated_header / blank_batch_key, collapse by batch_key (last row wins, duplicate_batch_key warn per superseded row), reject unknown_campaign (file brand only) / unparseable_queued_at / unparseable_recipient_count / unsupported_status (status ≠ sent), warn batch_key_taken when the key already belongs to another brand''s or campaign''s send, insert sends source seed_send_log, status complete, confirmed_at = dispatched_at = queued_at, on conflict (batch_key) do nothing. Run by pnpm seed as postgres; not exposed.';

-- ===========================================================================
-- Part 0c — Epic 4 review (D-7): dispatch_mark_partial, dispatch_record_result collision, the sweep's cap reason + ceiling
-- ===========================================================================
-- The CAS confirmed|dispatched (no batch_id) → partial with the reason. `partial` with a null accepted_count is what the
-- portal renders as "provider outcome unknown" (4.4) — nothing is fabricated (FR-19). Lives in public next to its four
-- 0008 siblings because PostgREST cannot reach `internal` (S3) and the Edge Function's service client is the caller;
-- service_role only — in neither tenancy allow-list (no anon / authenticated grant, not security definer).
create function public.dispatch_mark_partial(p_send_id uuid, p_reason text) returns setof public.sends
language sql volatile set search_path = '' as $$
  update public.sends
     set status = 'partial',
         failure_reason = left(p_reason, 500)
   where id = p_send_id and status in ('confirmed', 'dispatched') and batch_id is null
  returning *;
$$;
comment on function public.dispatch_mark_partial(uuid, text) is
  'Service-role only (and the sweep). Marks a confirmed|dispatched send with no batch_id as partial with failure_reason (cut to 500 chars) — the unknown-outcome exit while the dispatch sweep is off (D-7) and the sweep''s own cap / expiry stamp. CAS: zero rows when the send is elsewhere or already carries a batch_id.';
revoke execute on function public.dispatch_mark_partial(uuid, text) from public, anon, authenticated;
grant execute on function public.dispatch_mark_partial(uuid, text) to service_role;

-- dispatch_record_result: provider_batches.batch_id is unique table-wide. A collision used to raise AFTER the sends CAS
-- and roll the whole 2xx back (the send then replayed until capped). Now a batch_id that already belongs to another
-- send is a terminal failed (duplicate_batch_id: <id>) — checked first, and the race is caught by the unique_violation
-- handler around the insert (only that insert is undone; the send is then re-stamped failed with its batch_id cleared).
create or replace function public.dispatch_record_result(p_send_id uuid, p_batch_id text, p_accepted_ids text[], p_rejected_count int)
returns setof public.sends
language plpgsql volatile set search_path = '' as $$
declare
  v_accepted int;
  v_send public.sends;
begin
  if exists (select 1 from public.provider_batches b where b.batch_id = p_batch_id and b.send_id <> p_send_id) then
    update public.sends s
       set status = 'failed',
           failure_reason = left('duplicate_batch_id: ' || p_batch_id, 500),
           provider_responded_at = now()
     where s.id = p_send_id and s.status = 'dispatched' and s.batch_id is null
    returning * into v_send;
    if found then return next v_send; end if;
    return;
  end if;

  select count(distinct r.external_id) into v_accepted
    from public.send_recipients r
   where r.send_id = p_send_id and r.external_id = any (p_accepted_ids);

  update public.sends s
     set batch_id = p_batch_id,
         accepted_count = v_accepted,
         rejected_count = p_rejected_count,
         provider_responded_at = now(),
         status = case when v_accepted = s.recipient_count then 'reporting'::public.send_status else 'partial'::public.send_status end
   where s.id = p_send_id and s.status = 'dispatched' and s.batch_id is null
  returning * into v_send;

  if found then
    begin
      insert into public.provider_batches (send_id, brand_id, batch_id, polling)
      values (v_send.id, v_send.brand_id, p_batch_id, 'active')
      on conflict (send_id) do nothing;
    exception when unique_violation then
      -- lost the race on batch_id between the check above and the insert: the 2xx is not ours to keep
      update public.sends s
         set status = 'failed',
             failure_reason = left('duplicate_batch_id: ' || p_batch_id, 500),
             batch_id = null,
             accepted_count = null,
             rejected_count = null
       where s.id = p_send_id
      returning * into v_send;
    end;
    return next v_send;
  end if;
end $$;
comment on function public.dispatch_record_result(uuid, text, text[], int) is
  'Service-role only. Records the provider''s 2xx: batch_id, accepted_count = count(distinct accepted ∩ send_recipients.external_id), rejected_count, provider_responded_at, status reporting (all accepted) or partial; inserts provider_batches(polling active). A batch_id already held by another send → failed (duplicate_batch_id: <id>), never a rolled-back 2xx. CAS on status = dispatched and batch_id is null — zero rows when already recorded.';

-- The sweep (0009): (a) the cap now stamps its reason; (a2) a 24-hour age ceiling — a send whose dispatch began (or, never
-- leased, was confirmed) more than 24 h ago is partial / dispatch_expired, never re-POSTed; (b) the candidate selection
-- carries the same ceiling. (Enabling the job is Story 6.3's `0013_cron_poll.sql`, after this migration — probe row a.)
create or replace function internal.dispatch_sweep() returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_url text;
  v_secret text;
  v_capped int := 0;
  v_expired int := 0;
  v_queued int := 0;
  s record;
begin
  -- (a) the cap: three attempts, no provider response, lease expired → partial (unknown outcome, never re-POSTed)
  for s in
    select id from public.sends
     where status = 'dispatched'
       and batch_id is null
       and dispatch_lease_until is not null and dispatch_lease_until < now()
       and dispatch_attempts >= 3
  loop
    perform public.dispatch_mark_partial(s.id, 'dispatch_outcome_unknown_after_3_attempts');
    v_capped := v_capped + 1;
  end loop;

  -- (a2) the age ceiling: older than 24 h (dispatched_at, or confirmed_at when never leased), no batch_id, no live lease
  for s in
    select id from public.sends
     where status in ('confirmed', 'dispatched')
       and batch_id is null
       and (dispatch_lease_until is null or dispatch_lease_until < now())
       and coalesce(dispatched_at, confirmed_at) < now() - interval '24 hours'
  loop
    perform public.dispatch_mark_partial(s.id, 'dispatch_expired');
    v_expired := v_expired + 1;
  end loop;

  -- (b) re-invoke the Edge Function for every candidate, signed with the cron secret
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'functions_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_url is null or v_secret is null then
    raise warning 'dispatch_sweep: Vault secrets functions_url / cron_secret missing — capped %, expired %, re-invoke skipped', v_capped, v_expired;
    return;
  end if;

  for s in
    select id from public.sends
     where status in ('confirmed', 'dispatched')
       and batch_id is null
       and (dispatch_lease_until is null or dispatch_lease_until < now())
       and dispatch_attempts < 3
       and confirmed_at < now() - interval '2 min'
       and coalesce(dispatched_at, confirmed_at) > now() - interval '24 hours'
     order by confirmed_at
  loop
    perform net.http_post(
      url := rtrim(v_url, '/') || '/dispatch-send',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body := jsonb_build_object('send_id', s.id),
      timeout_milliseconds := 30000);
    v_queued := v_queued + 1;
  end loop;

  raise notice 'dispatch_sweep: capped %, expired %, re-invoked %', v_capped, v_expired, v_queued;
end $$;
comment on function internal.dispatch_sweep() is
  'pg_cron dispatch-sweep (every 5 min): (a) dispatched, no batch_id, lease expired, 3 attempts → partial dispatch_outcome_unknown_after_3_attempts; (a2) confirmed|dispatched, no batch_id, no live lease, older than 24 h → partial dispatch_expired; (b) net.http_post <functions_url>/dispatch-send with x-cron-secret from Vault for confirmed|dispatched sends with no batch_id, a null/expired lease, < 3 attempts, confirmed > 2 min and < 24 h ago. Vault secrets functions_url + cron_secret are created by hand per environment.';

-- ===========================================================================
-- Part 1 — helpers
-- ===========================================================================
-- A lenient ISO-8601 reader for provider payloads: null on blank / unparseable / non-finite input, never an error
-- (a poison timestamp must not abort a page). Zone-less values read as UTC; a future stamp is accepted verbatim.
create function internal.try_timestamptz(p text) returns timestamptz
language plpgsql immutable set search_path = '' set timezone = 'UTC' as $$
declare
  v text := btrim(coalesce(p, ''));
  r timestamptz;
begin
  if v !~ '^[0-9]' then return null; end if;   -- rejects '', 'now', 'today', 'infinity', junk
  r := v::timestamptz;
  if not isfinite(r) then return null; end if;
  return r;
exception when others then
  return null;
end $$;
comment on function internal.try_timestamptz(text) is 'ISO-8601 (UTC when zone-less) → timestamptz; null on anything unparseable or non-finite. Never raises.';

-- ===========================================================================
-- Part 1 — the suppression trigger (D-4, S10) + the seed backfill (S4)
-- ===========================================================================
-- Monotonic on presence AND value: set when null; move only to a strictly earlier moment; at the same moment prefer the
-- stronger reason (unsubscribed > complained > bounced) so two events at one timestamp still land the same way in any
-- order. Never cleared, never later. A null occurred_at reads as now() (constant within a transaction).
-- The brand check is defence in depth: an event's contact is always in the event's brand.
create function internal.trg_events_suppress() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_at timestamptz := coalesce(new.occurred_at, now());
  v_rank int := case new.type when 'unsubscribed' then 1 when 'complained' then 2 else 3 end;
begin
  -- the WHEN clause on the trigger is the fast path; the function guards the rule itself (defence in depth)
  if new.contact_id is null or new.type not in ('bounced', 'unsubscribed', 'complained') then
    return null;
  end if;
  update public.contacts c
     set suppressed_at = v_at,
         suppressed_reason = new.type::text
   where c.id = new.contact_id
     and c.brand_id = new.brand_id
     and (c.suppressed_at is null
          or v_at < c.suppressed_at
          or (v_at = c.suppressed_at
              and v_rank < case c.suppressed_reason when 'unsubscribed' then 1 when 'complained' then 2 when 'bounced' then 3 else 4 end));
  return null;
end $$;
comment on function internal.trg_events_suppress() is
  'AFTER INSERT on events (bounced / unsubscribed / complained with a contact): contacts.suppressed_at = coalesce(occurred_at, now()), suppressed_reason = type — set when null, moved only earlier (same moment: unsubscribed > complained > bounced), never cleared. Order-invariant (S10).';

create trigger trg_events_insert_suppress
  after insert on public.events
  for each row
  when (new.contact_id is not null and new.type in ('bounced', 'unsubscribed', 'complained'))
  execute function internal.trg_events_suppress();

-- Backfill (S4): the seed events of Epic 2 were loaded before this trigger existed. Same rule, set-based: the earliest
-- terminal event per contact (same moment → the stronger reason). The imports' upsert never writes these two columns
-- (Story 2.3), so a re-seed cannot undo this. The brand-level before/after is logged so the README figure can be
-- re-measured (Story 3.1 recorded KILELE contactable = 51,298 before this ran).
do $$
declare
  r record;
begin
  create temp table _suppress_before on commit drop as
    select b.code, count(*) filter (where public.is_contactable(c)) as contactable
      from public.contacts c join public.brands b on b.id = c.brand_id group by b.code;

  update public.contacts c
     set suppressed_at = s.at,
         suppressed_reason = s.reason
    from (select distinct on (e.contact_id) e.contact_id,
                 coalesce(e.occurred_at, now()) as at,
                 e.type::text as reason,
                 case e.type when 'unsubscribed' then 1 when 'complained' then 2 else 3 end as rank
            from public.events e
           where e.contact_id is not null
             and e.type in ('bounced', 'unsubscribed', 'complained')
           order by e.contact_id, coalesce(e.occurred_at, now()), case e.type when 'unsubscribed' then 1 when 'complained' then 2 else 3 end) s
   where c.id = s.contact_id
     and (c.suppressed_at is null
          or s.at < c.suppressed_at
          or (s.at = c.suppressed_at
              and s.rank < case c.suppressed_reason when 'unsubscribed' then 1 when 'complained' then 2 when 'bounced' then 3 else 4 end));

  for r in
    select b.code, x.contactable as before, count(*) filter (where public.is_contactable(c)) as after,
           count(*) filter (where c.suppressed_at is not null) as suppressed
      from public.contacts c join public.brands b on b.id = c.brand_id
      left join _suppress_before x on x.code = b.code
     group by b.code, x.contactable order by b.code
  loop
    raise notice 'suppression backfill %: contactable % -> % (% flipped), % contacts now carry suppressed_at',
      r.code, r.before, r.after, r.before - r.after, r.suppressed;
  end loop;
end $$;

-- ===========================================================================
-- Part 1 — internal.ingest_provider_events (D-8 + probe rows d, d2)
-- ===========================================================================
-- Provider rows link to their send: the performance view joins events by send_id (373k seed rows carry none).
create index idx_events_send_id_type on public.events (send_id, type) where send_id is not null;

create function internal.ingest_provider_events(p_send_id uuid, p_batch_id text, p_events jsonb)
returns table (inserted int, duplicates int, foreign_recipient int, unknown_type int, last_event_id text)
language plpgsql volatile set search_path = '' as $$
declare
  v_brand uuid;
  v_campaign uuid;
  v_total int;
  v_foreign int;
  v_inserted int;
  v_unknown int;
begin
  if p_send_id is null or nullif(btrim(coalesce(p_batch_id, '')), '') is null then
    raise exception 'invalid_input' using hint = 'send_id and batch_id are required';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'invalid_input' using hint = 'events must be a JSON array';
  end if;
  -- one ingester per batch at a time (the poller and a manual run must not interleave pages of one stream)
  if not pg_try_advisory_xact_lock(hashtext(p_batch_id)) then
    raise exception 'send_in_progress';
  end if;
  -- tenancy comes from the send's snapshot only — the payload's brand_code is never read (probe row d)
  select s.brand_id, s.campaign_id into v_brand, v_campaign from public.sends s where s.id = p_send_id;
  if not found then
    raise exception 'invalid_input' using hint = 'unknown send ' || p_send_id;
  end if;
  v_total := jsonb_array_length(p_events);

  -- Field names: probe row d first (event_id / recipient_id / occurred_at / type), the v1.4.0 spellings as fallbacks.
  -- The recipient key is resolved ONLY through the polled send's send_recipients (external_id, else the posted
  -- address); anyone else — a real contact of this or another brand who was not in the batch — is a forged event
  -- and is dropped (probe d2). A key-less element cannot be attributed and is kept with contact_id null (amendment #6).
  if to_regclass('pg_temp._ing') is not null then drop table pg_temp._ing; end if;
  create temp table _ing on commit drop as
  with e as (
    select x.ord, x.e,
           coalesce(nullif(btrim(x.e->>'event_id'), ''), nullif(btrim(x.e->>'id'), ''), md5(x.e::text)) as raw_id,
           coalesce(public.normalize_event_type(coalesce(x.e->>'type', x.e->>'event', x.e->>'status')), 'unknown') as type,
           internal.try_timestamptz(coalesce(x.e->>'occurred_at', x.e->>'timestamp', x.e->>'created_at')) as occurred_at,
           nullif(btrim(coalesce(x.e->>'recipient_id', x.e->>'external_id',
                                 case when jsonb_typeof(x.e->'recipient') = 'string' then x.e->>'recipient' end,
                                 x.e->'recipient'->>'external_id', x.e->'recipient'->>'id',
                                 x.e->>'contact_id', x.e->>'email')), '') as rk
      from jsonb_array_elements(p_events) with ordinality as x(e, ord)
  )
  select e.ord, e.e, e.raw_id, e.type, e.occurred_at, e.rk,
         (select sr.contact_id
            from public.send_recipients sr
           where sr.send_id = p_send_id
             and (sr.external_id = e.rk or lower(sr.address) = lower(e.rk))
           order by (sr.external_id = e.rk) desc, sr.contact_id
           limit 1) as contact_id
    from e;

  select count(*) into v_foreign from pg_temp._ing i where i.rk is not null and i.contact_id is null;

  -- Dedupe on (batch_id, event_id): the stored id is batch-qualified, so the natural key (brand_id, source, event_id)
  -- is exactly that; an exact duplicate — in this page or a replayed stream — does nothing. Duplicates inside one
  -- statement are tolerated by DO NOTHING (only the first is inserted).
  with ins as (
    insert into public.events (brand_id, campaign_id, contact_id, send_id, batch_id, source, event_id, type, occurred_at, raw)
    select v_brand, v_campaign, i.contact_id, p_send_id, p_batch_id, 'provider', p_batch_id || ':' || i.raw_id, i.type, i.occurred_at, i.e
      from pg_temp._ing i
     where i.rk is null or i.contact_id is not null
     order by i.ord
    on conflict (brand_id, source, event_id) do nothing
    returning type
  )
  select count(*), count(*) filter (where ins.type = 'unknown') into v_inserted, v_unknown from ins;

  drop table pg_temp._ing;
  return query
    select v_inserted::int,
           (v_total - v_foreign - v_inserted)::int,
           v_foreign::int,
           v_unknown::int,
           coalesce(nullif(btrim(p_events->-1->>'event_id'), ''), nullif(btrim(p_events->-1->>'id'), ''));
end $$;
comment on function internal.ingest_provider_events(uuid, text, jsonb) is
  'One page of a provider batch''s events into public.events (source provider): advisory lock per batch (send_in_progress), brand/campaign from the send, recipient resolved only through the send''s send_recipients (anyone else is dropped and counted as foreign_recipient), type via normalize_event_type (unknown kept), occurred_at verbatim (future allowed), stored event_id = <batch_id>:<provider event_id>, on conflict do nothing. Returns inserted, duplicates, foreign_recipient, unknown_type, last_event_id (the page''s positional last provider id). Not exposed.';

-- ===========================================================================
-- Part 1 — internal.recipient_state (AC3, precedence per probe d2), internal.complete_sends (AC4, S11)
-- ===========================================================================
create function internal.recipient_state(p_send_id uuid, p_contact_id uuid) returns text
language sql stable set search_path = '' as $$
  select e.type::text
    from public.events e
   where e.send_id = p_send_id
     and e.contact_id = p_contact_id
     and e.type in ('delivered', 'bounced', 'unsubscribed', 'complained')
   order by case e.type when 'unsubscribed' then 1 when 'complained' then 1 when 'bounced' then 2 else 3 end,
            e.occurred_at desc nulls last,
            e.id desc
   limit 1
$$;
comment on function internal.recipient_state(uuid, uuid) is
  'The visible terminal state of one recipient of one send, by precedence (unsubscribed | complained > bounced > delivered), then latest occurred_at — arrival order and provider timestamps never decide it (probe d2). Null when no terminal event exists.';

create function internal.complete_sends() returns int
language sql volatile set search_path = '' as $$
  with u as (
    update public.sends
       set status = 'complete'
     where status = 'reporting'
       and dispatched_at < now() - interval '24 hours'
    returning 1
  )
  select count(*)::int from u
$$;
comment on function internal.complete_sends() is
  'reporting → complete for every send dispatched more than 24 hours ago (compare-and-set); returns the row count. Called at the end of every poll run (Story 6.3).';

-- ===========================================================================
-- Part 1 — poll log (unexposed) + the two public sync surfaces
-- ===========================================================================
create type internal.poll_status as enum ('requested', 'running', 'ok', 'failed', 'auth_error', 'rate_limited', 'provider_error', 'deferred');

create table internal.poll_log (
  id bigint generated always as identity primary key,
  requested_at timestamptz not null default now(),
  net_request_id bigint,
  status internal.poll_status not null default 'requested',
  finished_at timestamptz,
  batches int,
  pages int,
  inserted int,
  duplicates int,
  error text
);
create index idx_poll_log_requested_at on internal.poll_log (requested_at desc);
comment on table internal.poll_log is
  'One row per poll run (Story 6.3): requested by cron → running → ok | failed | auth_error | rate_limited | provider_error | deferred. Global (no brand_id); lives in the unexposed internal schema. last_poll_status() exposes status + finished_at of the newest row.';

-- Per-brand "reports last synced": max(last_ok_at) over the brand's batches. security_invoker → the caller's RLS on
-- provider_batches scopes it; no join needed (S6 put brand_id on provider_batches).
create view public.v_last_sync with (security_invoker = true) as
  select pb.brand_id, max(pb.last_ok_at) as last_ok_at
    from public.provider_batches pb
   group by pb.brand_id;
grant select on public.v_last_sync to authenticated;

-- Poller health is global: the newest run's status and finish time, nothing else (no brand data, no error text).
create function public.last_poll_status() returns table (status text, finished_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.status::text, l.finished_at
    from internal.poll_log l
   order by l.requested_at desc, l.id desc
   limit 1
$$;
comment on function public.last_poll_status() is
  'Status and finished_at of the newest poll run (brand-agnostic — poller health is global). Security definer over the unexposed internal.poll_log; authenticated only.';
revoke all on function public.last_poll_status() from public, anon;
grant execute on function public.last_poll_status() to authenticated;

-- ===========================================================================
-- Part 1 — v_campaign_performance: the reported row + one portal row per dispatched portal send (D-5)
-- ===========================================================================
-- `create or replace view` cannot append columns in the middle or change the row shape, so: drop, recreate, re-grant.
-- Story 3.1's column names and order are kept for the shared columns; dispatched_at is appended (null on reported
-- rows). Portal rows: sent = accepted_count (what the provider took), delivered / bounced / unsubscribes distinct per
-- contact (a key-less event counts by its id), opens / clicks total (opens may exceed 100 %), events by send_id and
-- source = 'provider' only. Seed send-log sends (source seed_send_log) get no row: history, never a denominator (4.5).
-- Rates round(100.0 * n / nullif(sent, 0), 2) as unbounded numeric. security_invoker: the caller's RLS applies.
drop view public.v_campaign_performance;
create view public.v_campaign_performance with (security_invoker = true) as
select c.brand_id, c.id as campaign_id, c.external_id, c.name, c.channel, c.sent_at, c.spend,
       c.target_country, 'reported'::text as source, null::uuid as send_id,
       c.reported_sent as sent, c.reported_delivered as delivered, c.reported_bounced as bounced,
       c.reported_opens as opens, c.reported_clicks as clicks, null::bigint as unsubscribes,
       round(100.0 * c.reported_delivered / nullif(c.reported_sent, 0), 2) as delivered_rate,
       round(100.0 * c.reported_bounced   / nullif(c.reported_sent, 0), 2) as bounce_rate,
       round(100.0 * c.reported_opens     / nullif(c.reported_sent, 0), 2) as open_rate,
       round(100.0 * c.reported_clicks    / nullif(c.reported_sent, 0), 2) as click_rate,
       null::numeric as unsubscribe_rate,
       null::timestamptz as dispatched_at
from public.campaigns c
union all
select c.brand_id, c.id as campaign_id, c.external_id, c.name, c.channel, c.sent_at, c.spend,
       c.target_country, 'portal'::text as source, s.id as send_id,
       s.accepted_count as sent,
       (count(distinct coalesce(e.contact_id::text, e.event_id)) filter (where e.type = 'delivered'))::int    as delivered,
       (count(distinct coalesce(e.contact_id::text, e.event_id)) filter (where e.type = 'bounced'))::int      as bounced,
       (count(*) filter (where e.type = 'opened'))::int                                                         as opens,
       (count(*) filter (where e.type = 'clicked'))::int                                                        as clicks,
       count(distinct coalesce(e.contact_id::text, e.event_id)) filter (where e.type = 'unsubscribed')          as unsubscribes,
       round(100.0 * (count(distinct coalesce(e.contact_id::text, e.event_id)) filter (where e.type = 'delivered'))    / nullif(s.accepted_count, 0), 2) as delivered_rate,
       round(100.0 * (count(distinct coalesce(e.contact_id::text, e.event_id)) filter (where e.type = 'bounced'))      / nullif(s.accepted_count, 0), 2) as bounce_rate,
       round(100.0 * (count(*) filter (where e.type = 'opened'))                                                        / nullif(s.accepted_count, 0), 2) as open_rate,
       round(100.0 * (count(*) filter (where e.type = 'clicked'))                                                       / nullif(s.accepted_count, 0), 2) as click_rate,
       round(100.0 * (count(distinct coalesce(e.contact_id::text, e.event_id)) filter (where e.type = 'unsubscribed')) / nullif(s.accepted_count, 0), 2) as unsubscribe_rate,
       s.dispatched_at
from public.sends s
join public.campaigns c on c.id = s.campaign_id
left join public.events e on e.send_id = s.id and e.source = 'provider'
where s.source = 'portal' and s.dispatched_at is not null
group by c.brand_id, c.id, c.external_id, c.name, c.channel, c.sent_at, c.spend, c.target_country, s.id, s.accepted_count, s.dispatched_at;
grant select on public.v_campaign_performance to authenticated;
