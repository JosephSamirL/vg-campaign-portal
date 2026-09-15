-- 0002_core_tables.sql — core data tables (architecture D-2, D-4, D-5; Step-3 amendments #1, #2, #6, #10;
-- Story-Time amendments S8, S12, S17). Once pushed this file is never edited: Stories 2.2–2.4 add nothing here.

-- ---------------------------------------------------------------------------
-- S17 default-privilege fix (carried in from Story 1.3). Postgres cannot subtract the built-in
-- "execute to PUBLIC" default per schema, so 0000_grants.sql's per-schema line was a no-op:
-- a bare `create function public.f()` still reached anon/authenticated through PUBLIC. The
-- schema-less form below rewrites the default for the role that runs every migration and the
-- SQL editor (postgres); the blanket revoke covers every function that already exists; the
-- two tenancy helpers are then re-granted explicitly. Explicit per-function revoke/grant lines
-- remain mandatory (schema.sql readers must see the allow-list); the tenancy suite's S5/S6
-- fail the build on any leak either way.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres revoke execute on functions from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.current_brand_id(), public.current_app_role() to authenticated;

-- ---------------------------------------------------------------------------
-- Event vocabulary: one enum + one normaliser, reused by the seed importer (2.4) and the
-- provider poller (6.2). Unknown spellings map to 'unknown' (amendment #2), never rejected.
-- ---------------------------------------------------------------------------
create type public.event_type as enum ('delivered', 'bounced', 'opened', 'clicked', 'unsubscribed', 'complained', 'unknown');
create type public.event_source as enum ('seed', 'provider');

create or replace function public.normalize_event_type(p text) returns public.event_type
language sql immutable set search_path = '' as $$
  select case lower(btrim(coalesce(p, '')))
    when 'delivered'    then 'delivered'
    when 'bounce'       then 'bounced'
    when 'bounced'      then 'bounced'
    when 'open'         then 'opened'
    when 'opened'       then 'opened'
    when 'click'        then 'clicked'
    when 'clicked'      then 'clicked'
    when 'unsubscribe'  then 'unsubscribed'
    when 'unsubscribed' then 'unsubscribed'
    when 'complaint'    then 'complained'
    when 'complained'   then 'complained'
    else 'unknown'
  end::public.event_type
$$;
-- security invoker, executable by no exposed role: only the internal importers/poller call it.
revoke execute on function public.normalize_event_type(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables. brand_id is always the first non-PK column and references brands (D-2).
-- Natural keys: contacts/campaigns (brand_id, external_id); events (brand_id, source, event_id).
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm with schema extensions;

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id),
  external_id text not null,
  full_name text,
  email text,                             -- stored lower-cased by the importer
  phone text,
  country text,                           -- nullable by design: unknown is null, never a sentinel
  city text,
  signup_at timestamptz,
  status text,                            -- nullable by design (Story 3.1 coalesces to 'unknown')
  consent_marketing boolean,              -- raw source boolean keeps the source name
  deleted_at timestamptz,
  suppressed_until timestamptz,
  notes text,
  suppressed_at timestamptz,              -- set by Story 6.2's monotonic trigger (D-4); no trigger here
  suppressed_reason text,
  routed_from text,                       -- source brand code when the row came from another brand's file
  as_of date not null default '1970-01-01',   -- defaults exist only so fixtures can insert; the importer always sets both
  file_rank int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_contacts_brand_id_external_id unique (brand_id, external_id)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id),
  external_id text not null,
  name text,                              -- `name`, not `campaign_name`: Story 3.1's views reference c.name (S12)
  channel text,
  target_country text,
  reported_sent int,
  reported_delivered int,
  reported_bounced int,
  reported_opens int,
  reported_clicks int,
  spend numeric,
  sent_at timestamptz,
  send_local_time text,
  parent_external_id text,                -- raw pointer kept for the second-pass resolution in Story 2.4
  parent_campaign_id uuid references public.campaigns(id),
  as_of date not null default '1970-01-01',
  file_rank int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_campaigns_brand_id_external_id unique (brand_id, external_id)
);

create table public.events (
  id bigint generated always as identity primary key,
  brand_id uuid not null references public.brands(id),
  source public.event_source not null,
  event_id text not null,
  type public.event_type not null,
  contact_id uuid references public.contacts(id),     -- nullable: unresolvable recipient (amendment #6)
  campaign_id uuid references public.campaigns(id),
  send_id uuid,                                       -- FK is added by Story 4.1 with the sends table
  batch_id text,
  channel text,
  occurred_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  constraint uq_events_brand_id_source_event_id unique (brand_id, source, event_id)
);

-- ---------------------------------------------------------------------------
-- Indexes (D-5). text_pattern_ops serves Story 3.3's prefix search; the trigram index its name search.
-- ---------------------------------------------------------------------------
create index idx_contacts_brand_id_signup_at on public.contacts (brand_id, signup_at);
create index idx_contacts_brand_id_email on public.contacts (brand_id, email text_pattern_ops);
create index idx_contacts_full_name_trgm on public.contacts using gin (full_name extensions.gin_trgm_ops);
create index idx_events_brand_id_contact_id_type on public.events (brand_id, contact_id, type);
create index idx_events_brand_id_campaign_id_type on public.events (brand_id, campaign_id, type);
create index idx_campaigns_brand_id_sent_at on public.campaigns (brand_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- RLS: enabled AND forced; exactly one select policy per table; no write policies
-- (writes only via RPCs / service role). (select …) wraps the helper so it runs once per query.
-- ---------------------------------------------------------------------------
alter table public.contacts enable row level security;
alter table public.contacts force row level security;
alter table public.campaigns enable row level security;
alter table public.campaigns force row level security;
alter table public.events enable row level security;
alter table public.events force row level security;

create policy contacts_select_own_brand on public.contacts
  for select to authenticated using (brand_id = (select public.current_brand_id()));
create policy campaigns_select_own_brand on public.campaigns
  for select to authenticated using (brand_id = (select public.current_brand_id()));
create policy events_select_own_brand on public.events
  for select to authenticated using (brand_id = (select public.current_brand_id()));

-- Explicit allow-list: SELECT to authenticated only; anon holds nothing (defaults were revoked in 0000).
grant select on public.contacts, public.campaigns, public.events to authenticated;

-- ---------------------------------------------------------------------------
-- Staging (S8): raw CSV records as text[], one row per record, in the unexposed `staging` schema
-- (schema usage was revoked from public/anon/authenticated in 0000_grants.sql; no policy, no grant).
-- Lives here rather than in 0003_import.sql because Story 2.2's hosted smoke test needs it first.
-- ---------------------------------------------------------------------------
create table staging.stage_contacts (
  id bigint generated always as identity primary key,
  run_id uuid not null,            -- generated by scripts/seed per file; becomes import_runs.id in Story 2.3
  source_file text not null,
  file_brand text not null,
  row_no int not null,
  ncols int not null,
  cols text[] not null,
  had_nul boolean not null default false,
  as_of date not null,
  file_rank int not null
);
create index idx_stage_contacts_run_id on staging.stage_contacts (run_id);

create table staging.stage_campaigns (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  source_file text not null,
  file_brand text not null,
  row_no int not null,
  ncols int not null,
  cols text[] not null,
  had_nul boolean not null default false,
  as_of date not null,
  file_rank int not null
);
create index idx_stage_campaigns_run_id on staging.stage_campaigns (run_id);

create table staging.stage_events (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  source_file text not null,
  file_brand text not null,
  row_no int not null,
  ncols int not null,
  cols text[] not null,
  had_nul boolean not null default false,
  as_of date not null,
  file_rank int not null
);
create index idx_stage_events_run_id on staging.stage_events (run_id);

create table staging.stage_send_log (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  source_file text not null,
  file_brand text not null,
  row_no int not null,
  ncols int not null,
  cols text[] not null,
  had_nul boolean not null default false,
  as_of date not null,
  file_rank int not null
);
create index idx_stage_send_log_run_id on staging.stage_send_log (run_id);
