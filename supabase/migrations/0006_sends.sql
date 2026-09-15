-- 0006_sends.sql — send records + the exact recipient preview (Story 4.1; architecture D-2, D-4, D-6;
-- Step-3 amendments #1, #4, #9; Story-Time amendments S6, S17, S18). Numbered 0006 per S18.
-- Stories 4.2 (confirm_send), 4.3 (dispatch), 4.5 (import_send_log) append `-- Story 4.x` sections below.
--
-- sends / send_recipients / provider_batches — the record of what went out. RLS enabled AND forced with the
--                               brand policy; `authenticated` holds SELECT only, so the app never inserts,
--                               updates or deletes a send row directly — every status transition is a
--                               compare-and-set inside a security definer RPC or a service-role function (FR20).
--                               S6: `sends.batch_id` / `failure_reason` (read by 4.3/4.4) and `brand_id` on both
--                               child tables so each table carries its own tenancy policy.
-- uq_sends_one_active_per_campaign — one send per campaign that is not yet complete / partial / failed (D-2).
-- internal.recipient_classification(campaign) — THE recipient predicate (D-6): one row per non-deleted contact
--                               of the campaign's brand with the address for the channel and an exclusion
--                               reason (null = recipient). Reasons are exclusive by priority
--                               (not_contactable → no_address → country) so the counts always reconcile.
--                               Calls is_contactable (D-4) — never restates it. Shared with 4.2's confirm_send
--                               so the number previewed is the number confirmed. No grant: internal only.
-- public.recipient_preview(campaign) — security definer, the explicit brand check is the guard (RLS filters
--                               nothing inside a secdef function): `not_in_brand` for another brand's or an
--                               unknown campaign, `invalid_input` when the channel is not email/sms. One row:
--                               total + three excluded counts + the `recipients` rule text for the caption.

-- ---------------------------------------------------------------------------
-- enums — the status names verbatim
-- ---------------------------------------------------------------------------
create type public.send_status as enum ('pending', 'confirmed', 'dispatched', 'reporting', 'complete', 'partial', 'failed');
create type public.send_source as enum ('portal', 'seed_send_log');

-- ---------------------------------------------------------------------------
-- sends
-- ---------------------------------------------------------------------------
create table public.sends (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id),
  campaign_id uuid not null references public.campaigns(id),
  status public.send_status not null default 'pending',
  source public.send_source not null,
  batch_key text unique,                 -- seed send-log key; null for portal sends
  recipient_count int not null check (recipient_count >= 0),
  confirmed_by text,                     -- approver email (app_users.email); null for seed sends
  confirmed_at timestamptz,
  dispatched_at timestamptz,
  provider_responded_at timestamptz,
  dispatch_attempts int not null default 0,
  dispatch_lease_until timestamptz,
  body_sha256 text,                      -- hex sha256 of external_ids joined by '\n', ordered by contact_id
  batch_id text,                         -- copy of provider_batches.batch_id (reconciliation + UI)
  accepted_count int,
  rejected_count int,
  failure_reason text,                   -- provider 4xx message (Stories 4.3/4.4)
  created_at timestamptz not null default now()
);
comment on table public.sends is
  'One row per send (portal or imported seed send log). Append-only from the app: authenticated holds SELECT only; status moves by compare-and-set inside RPCs / service-role functions.';
create unique index uq_sends_one_active_per_campaign
  on public.sends (campaign_id) where status not in ('complete', 'partial', 'failed');
create index idx_sends_brand_campaign_created on public.sends (brand_id, campaign_id, created_at desc);
create index idx_sends_dispatch_pending on public.sends (status, dispatch_lease_until) where batch_id is null;

-- ---------------------------------------------------------------------------
-- send_recipients — the exact list that was confirmed; the contact row is pinned (on delete restrict)
-- ---------------------------------------------------------------------------
create table public.send_recipients (
  send_id uuid not null references public.sends(id) on delete cascade,
  brand_id uuid not null references public.brands(id),
  contact_id uuid not null references public.contacts(id) on delete restrict,
  external_id text not null,
  address text not null,                 -- email for channel email, phone for sms
  primary key (send_id, contact_id)
);
comment on table public.send_recipients is
  'The recipients of a send as confirmed (external_id + address at confirmation time). contact_id restricts deletes so the record outlives the contact.';

-- ---------------------------------------------------------------------------
-- provider_batches — the provider's batch per send; cursor columns are written only by Epic 6
-- ---------------------------------------------------------------------------
create table public.provider_batches (
  send_id uuid primary key references public.sends(id) on delete cascade,
  brand_id uuid not null references public.brands(id),
  batch_id text not null unique,
  next_cursor text,                      -- opaque, kept while has_more
  last_event_id text,                    -- positional last item when has_more=false
  polling text not null default 'active' check (polling in ('active', 'quiet')),
  last_polled_at timestamptz,
  last_ok_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.provider_batches is
  'The provider batch behind a dispatched send. next_cursor / last_event_id / polling / last_polled_at / last_ok_at are written by Epic 6 only.';

-- ---------------------------------------------------------------------------
-- RLS (enabled AND forced) + policies + grants — grants first, then policies (D-2); SELECT only, never anon
-- ---------------------------------------------------------------------------
revoke all on public.sends, public.send_recipients, public.provider_batches from public, anon, authenticated;
grant select on public.sends, public.send_recipients, public.provider_batches to authenticated;

alter table public.sends enable row level security;
alter table public.sends force row level security;
create policy sends_select_own_brand on public.sends
  for select to authenticated using (brand_id = (select public.current_brand_id()));

alter table public.send_recipients enable row level security;
alter table public.send_recipients force row level security;
create policy send_recipients_select_own_brand on public.send_recipients
  for select to authenticated using (brand_id = (select public.current_brand_id()));

alter table public.provider_batches enable row level security;
alter table public.provider_batches force row level security;
create policy provider_batches_select_own_brand on public.provider_batches
  for select to authenticated using (brand_id = (select public.current_brand_id()));

-- ---------------------------------------------------------------------------
-- internal.recipient_classification — the shared predicate (D-6). Security invoker, internal schema, no grant.
-- `coalesce(is_contactable(c), false)`: a null predicate must exclude, never vanish (amendment #9).
-- `is distinct from`: a null country is a mismatch when the campaign targets one (PRD §5 "unknown").
-- Both sides are normalised at import; normalize_country on the stored value is idempotent (Story 2.3) and
-- keeps a raw fixture value such as 'kenya' honest.
-- ---------------------------------------------------------------------------
create function internal.recipient_classification(p_campaign_id uuid)
returns table (contact_id uuid, external_id text, address text, reason text)
language sql stable set search_path = '' as $$
  select c.id,
         c.external_id,
         case k.channel when 'email' then c.email else c.phone end,
         case
           when not coalesce(public.is_contactable(c), false) then 'not_contactable'
           when (case k.channel when 'email' then c.email else c.phone end) is null then 'no_address'
           when k.target_country is not null
                and internal.normalize_country(c.country) is distinct from k.target_country
             then 'country_mismatch_or_unknown'
         end
  from public.campaigns k
  join public.contacts c on c.brand_id = k.brand_id and c.deleted_at is null
  where k.id = p_campaign_id
$$;
comment on function internal.recipient_classification(uuid) is
  'One row per non-deleted contact of the campaign''s brand: address for the channel + exclusion reason (null = recipient). Reasons exclusive by priority: not_contactable, no_address, country_mismatch_or_unknown. Shared by recipient_preview and confirm_send (D-6).';
revoke execute on function internal.recipient_classification(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.recipient_preview — the confirm screen's numbers. Secdef runs as postgres (BYPASSRLS): the explicit
-- brand check below is the only guard, so it comes first and treats an unknown id exactly like a foreign one.
-- ---------------------------------------------------------------------------
create function public.recipient_preview(p_campaign_id uuid)
returns table (total_count bigint, not_contactable bigint, no_address bigint,
               country_mismatch_or_unknown bigint, rule_text text, channel text, target_country text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_campaign public.campaigns;
begin
  select * into v_campaign from public.campaigns k
   where k.id = p_campaign_id and k.brand_id = (select public.current_brand_id());
  if not found then raise exception 'not_in_brand'; end if;
  if v_campaign.channel is null or v_campaign.channel not in ('email', 'sms') then
    raise exception 'invalid_input';
  end if;
  return query
    select count(*) filter (where r.reason is null),
           count(*) filter (where r.reason = 'not_contactable'),
           count(*) filter (where r.reason = 'no_address'),
           count(*) filter (where r.reason = 'country_mismatch_or_unknown'),
           (select m.rule_text from public.metric_rules m where m.key = 'recipients'),
           v_campaign.channel,
           v_campaign.target_country
    from internal.recipient_classification(p_campaign_id) r;
end $$;
comment on function public.recipient_preview(uuid) is
  'Recipient preview for one campaign of the caller''s brand: total_count + not_contactable / no_address / country_mismatch_or_unknown (the four sum to the brand''s non-deleted contacts) + the recipients rule text. Raises not_in_brand (foreign or unknown campaign) or invalid_input (channel not email/sms).';
revoke execute on function public.recipient_preview(uuid) from public, anon;
grant execute on function public.recipient_preview(uuid) to authenticated;
