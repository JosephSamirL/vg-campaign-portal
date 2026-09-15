-- 0005_metrics.sql — one definition of every number (Story 3.1; architecture D-4, D-5; Step-3 amendments #1, #9;
-- Story-Time amendments S5, S12, S17, S18). Numbered 0005 because 0004 became the campaigns/events importers (S18).
--
-- is_contactable(contacts)    — THE contactability predicate: consumed by the views below and by Story 4.1's
--                               recipient predicate; change it once. Plain `language sql stable`, security invoker,
--                               NO `set search_path` — either would stop the planner inlining it into the scan
--                               (the 84k dashboard count and the recipient preview depend on that).
-- metric_rules                — one row per number the portal shows: the rule and the rejected alternative
--                               (PRD §5 verbatim). Captions are rendered from here, never re-typed. Seeded HERE
--                               with `on conflict do update` because seed.sql never runs on `db push` (S5).
-- v_dashboard_totals, v_signups_30d, v_campaign_performance, v_contacts — every view `security_invoker = true`
--                               so the caller's RLS applies; `nullif` denominators; rates as unbounded numeric
--                               (opens can exceed 100 % — never clamp, never numeric(5,2)).

-- ---------------------------------------------------------------------------
-- is_contactable — D-4. `coalesce(status, 'unknown')` is mandatory: `null not in (…)` is null, and a null
-- predicate silently drops every blank-status contact from every count (amendment #9).
-- ---------------------------------------------------------------------------
create or replace function public.is_contactable(c public.contacts)
returns boolean language sql stable as $$
  select c.deleted_at is null
     and c.consent_marketing is true
     and coalesce(c.status, 'unknown') not in ('bounced', 'unsubscribed')
     and (c.suppressed_until is null or c.suppressed_until < now())
     and c.suppressed_at is null
$$;
comment on function public.is_contactable(public.contacts) is
  'Contactable = not deleted, consent true, status not bounced/unsubscribed (blank counts as unknown, pending counts), suppressed_until null or past, suppressed_at null. Inlinable: keep it security invoker with no search_path.';
revoke execute on function public.is_contactable(public.contacts) from public, anon;
grant execute on function public.is_contactable(public.contacts) to authenticated;

-- ---------------------------------------------------------------------------
-- metric_rules — shared across brands (no brand_id): any signed-in user reads every row.
-- RLS enabled AND forced; the policy references auth.uid() so the tenancy suite's S2 accepts it.
-- ---------------------------------------------------------------------------
create table public.metric_rules (
  key text primary key,
  label text not null,
  rule_text text not null,
  alternative_text text not null
);

alter table public.metric_rules enable row level security;
alter table public.metric_rules force row level security;

create policy metric_rules_select_signed_in on public.metric_rules
  for select to authenticated using (auth.uid() is not null);

revoke all on public.metric_rules from public, anon, authenticated;
grant select on public.metric_rules to authenticated;

-- PRD §5 verbatim (asterisks and backticks included): `label` is the on-screen name, `rule_text` how the
-- number is counted, `alternative_text` the rejected way. Dollar-quoted so the prose needs no escaping.
insert into public.metric_rules (key, label, rule_text, alternative_text) values
  ('total_customers', $t$Total customers$t$,
   $t$Loaded contacts of the brand with no `deleted_at`, one per `external_id`$t$,
   $t$Including rejected rows or soft-deleted (we count what's real and loaded; the import report shows the rest)$t$),
  ('contactable', $t$Contactable$t$,
   $t$Total customers **and** consent = true (blank/unknown = not consented) **and** status ∉ {bounced, unsubscribed} (`pending` counts as contactable) **and** (`suppressed_until` null or in the past) **and** no ingested `bounced` / `unsubscribed` / `complained` event for the contact, seed or provider$t$,
   $t$Consent-only, or ignoring seed events (11.9k Kilele contacts differ)$t$),
  ('signups_30d', $t$Signups per day (30d)$t$,
   $t$Count by `signup_at` UTC date over the 30 calendar days ending today, zero-filled; future-dated signups excluded from the chart and counted in the caption; the exact date window is shown$t$,
   $t$Local-time days; including future-dated rows$t$),
  ('delivered_rate', $t$Delivered rate$t$,
   $t$`delivered rate = delivered ÷ sent`. Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked$t$,
   $t$Opens ÷ delivered; unique opens$t$),
  ('bounce_rate', $t$Bounce rate$t$,
   $t$`bounce rate = bounced ÷ sent`. Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked$t$,
   $t$Opens ÷ delivered; unique opens$t$),
  ('open_rate', $t$Open rate$t$,
   $t$`open rate = opens ÷ sent` (**total** opens — can exceed 100%, caption says so). Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked$t$,
   $t$Opens ÷ delivered; unique opens$t$),
  ('click_rate', $t$Click rate$t$,
   $t$`click rate = clicks ÷ sent`. Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked$t$,
   $t$Opens ÷ delivered; unique opens$t$),
  ('unsubscribe_rate', $t$Unsubscribe rate$t$,
   $t$`unsubscribe rate = unsubscribes ÷ sent`. Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked$t$,
   $t$Opens ÷ delivered; unique opens$t$),
  ('recipients', $t$Recipients$t$,
   $t$Contactable **and** valid address for the channel **and** country match when the campaign targets one; excluded counts shown by reason$t$,
   $t$All contactable$t$)
on conflict (key) do update
  set label = excluded.label,
      rule_text = excluded.rule_text,
      alternative_text = excluded.alternative_text;

-- ---------------------------------------------------------------------------
-- Views — D-5. security_invoker on every one; the caller's RLS on contacts / campaigns / brands
-- scopes each to the signed-in brand. Column lists are stable contracts for Stories 3.2–3.4 and 6.2.
-- ---------------------------------------------------------------------------

-- Totals per brand: total_customers = non-deleted rows; contactable = is_contactable (inlined into the scan).
create view public.v_dashboard_totals with (security_invoker = true) as
select c.brand_id,
       count(*) filter (where c.deleted_at is null)     as total_customers,
       count(*) filter (where public.is_contactable(c)) as contactable
from public.contacts c group by c.brand_id;

-- 30 zero-filled UTC days ending today (UTC), one row per brand per day. Every row repeats
-- window_start / window_end (the caption shows the exact window) and future_dated_count (signups
-- dated after the window, excluded from the chart and counted in the caption). The signup_at
-- predicates are range comparisons on the column itself, so idx_contacts_brand_id_signup_at serves them.
-- `(now() at time zone 'utc')::date`, never current_date (session time zone).
create view public.v_signups_30d with (security_invoker = true) as
with w as (select (now() at time zone 'utc')::date as window_end),
d as (select generate_series(window_end - 29, window_end, interval '1 day')::date as day,
             window_end - 29 as window_start, window_end from w),
s as (select brand_id, (signup_at at time zone 'utc')::date as day, count(*) as n
      from public.contacts, w
      where deleted_at is null and signup_at is not null
        and signup_at >= ((window_end - 29)::timestamp at time zone 'utc')
        and signup_at <  ((window_end + 1)::timestamp at time zone 'utc')
      group by 1, 2),
f as (select brand_id, count(*) as n from public.contacts, w
      where deleted_at is null and signup_at >= ((window_end + 1)::timestamp at time zone 'utc')
      group by 1)
select b.id as brand_id, d.day, coalesce(s.n, 0)::bigint as signups,
       d.window_start, d.window_end, coalesce(f.n, 0)::bigint as future_dated_count
from public.brands b cross join d
left join s on s.brand_id = b.id and s.day = d.day
left join f on f.brand_id = b.id;

-- One source = 'reported' row per campaign from the seed reported_* counts. Rates are
-- round(100.0 * n / nullif(d, 0), 2) as unbounded numeric: sent = 0 → null (never an error),
-- opens > sent → > 100 (never clamped). unsubscribes / unsubscribe_rate are null on reported rows
-- (the seed files carry no reported_unsubscribes); Story 6.2 unions source = 'portal' rows beneath
-- with the same column list — keep it stable.
create view public.v_campaign_performance with (security_invoker = true) as
select c.brand_id, c.id as campaign_id, c.external_id, c.name, c.channel, c.sent_at, c.spend,
       c.target_country, 'reported'::text as source, null::uuid as send_id,
       c.reported_sent as sent, c.reported_delivered as delivered, c.reported_bounced as bounced,
       c.reported_opens as opens, c.reported_clicks as clicks, null::bigint as unsubscribes,
       round(100.0 * c.reported_delivered / nullif(c.reported_sent, 0), 2) as delivered_rate,
       round(100.0 * c.reported_bounced   / nullif(c.reported_sent, 0), 2) as bounce_rate,
       round(100.0 * c.reported_opens     / nullif(c.reported_sent, 0), 2) as open_rate,
       round(100.0 * c.reported_clicks    / nullif(c.reported_sent, 0), 2) as click_rate,
       null::numeric as unsubscribe_rate
from public.campaigns c;

-- Non-deleted contacts plus the computed `contactable` (S12): lets /contacts filter server-side
-- through PostgREST (`.eq('contactable', true)`) with the same predicate the totals use.
create view public.v_contacts with (security_invoker = true) as
select c.id, c.brand_id, c.external_id, c.full_name, c.email, c.phone, c.country, c.city,
       c.status, c.consent_marketing, c.signup_at, c.suppressed_at, c.suppressed_reason,
       c.suppressed_until, public.is_contactable(c) as contactable
from public.contacts c where c.deleted_at is null;

-- Explicit allow-list: SELECT to authenticated only; anon holds nothing (defaults were revoked in 0000).
grant select on public.v_dashboard_totals, public.v_signups_30d, public.v_campaign_performance, public.v_contacts to authenticated;
