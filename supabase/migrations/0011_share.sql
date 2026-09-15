-- 0011_share.sql — the share-link boundary in the database (Story 5.1; architecture D-1, D-2, D-5, D-10;
-- Step-3 amendment #7; Story-Time amendments S1, S2, S18, S20). One migration per story: 0010 is on hosted.
--
-- share_links                 — one row per published link: sha256(token) + bcrypt(password). Brand users read it
--                               ONLY through v_share_links: there is no table-level SELECT for authenticated, just a
--                               column-level grant on the non-hash columns (S2 — a security_invoker view needs the
--                               invoker's privileges on the base table), so `select *` and `select token_hash`
--                               are refused by Postgres itself. Writes happen only inside the two owner RPCs.
-- internal.share_attempts     — the per-token failure ledger for the rate limit; lives in the unexposed schema,
--                               no policy, no grant: only get_shared_results (security definer) touches it.
-- v_share_links               — security_invoker, non-hash columns + status (active / expired / revoked).
-- create_share_link           — owner-only, brand-checked; returns the raw URL-safe token exactly once.
-- revoke_share_link           — owner-only, brand-checked; second revoke is a no-op.
-- get_shared_results          — the stranger's only door (anon may EXECUTE nothing else): volatile (PostgREST
--                               would expose a stable RPC to GET — password in URLs and logs), security definer,
--                               advisory-locked per token, prunes and counts the ledger, ALWAYS runs exactly one
--                               bcrypt (a dummy hash of the same cost when the token is unknown — no timing
--                               oracle), records an attempt only for tokens that exist (no ledger bloat), and
--                               RETURNS status ∈ {ok, share_denied, rate_limited} instead of raising (S1: a raise
--                               would roll back the attempt insert, so the 11th attempt could never be limited).
-- Also here (Epic 3 review follow-ups, deferred to "the next upsert-style migration" = this one): per-rate
-- `metric_rules.alternative_text` and `v_signups_30d` re-created with `with w as not materialized`.
--
-- `set search_path = ''` everywhere: public.*, internal.*, extensions.crypt / gen_salt / gen_random_bytes and
-- auth.uid() are schema-qualified; sha256, encode, hashtext, pg_advisory_xact_lock are pg_catalog.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- share_links — grants first, then policies (D-2). No write grant, no write policy: the RPCs write as postgres.
-- ---------------------------------------------------------------------------
create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id),
  campaign_id uuid not null references public.campaigns(id),
  token_hash bytea not null unique,
  password_hash text not null,
  expires_at timestamptz null,
  revoked_at timestamptz null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
comment on table public.share_links is
  'Published share links: sha256(token) + bcrypt(password). Brand users read only v_share_links (column-level SELECT, no hash columns); writes only through create_share_link / revoke_share_link.';

revoke all on public.share_links from public, anon, authenticated;
-- column-level only (S2): has_table_privilege('authenticated', 'public.share_links', 'select') stays false, so
-- `select *` and any reference to token_hash / password_hash raise 42501; v_share_links reads these columns.
grant select (id, brand_id, campaign_id, expires_at, revoked_at, created_by, created_at) on public.share_links to authenticated;

alter table public.share_links enable row level security;
alter table public.share_links force row level security;
create policy share_links_select_own_brand on public.share_links
  for select to authenticated using (brand_id = (select public.current_brand_id()));

-- ---------------------------------------------------------------------------
-- internal.share_attempts — failure ledger, pruned to the last 15 minutes by get_shared_results itself.
-- ---------------------------------------------------------------------------
create table internal.share_attempts (
  token_hash bytea not null,
  attempted_at timestamptz not null default now()
);
create index idx_share_attempts_token_hash_attempted_at on internal.share_attempts (token_hash, attempted_at);
comment on table internal.share_attempts is
  'One row per failed unlock of an EXISTING share link (unknown tokens are never recorded). get_shared_results prunes rows older than 15 minutes and answers rate_limited at 10 or more.';

-- ---------------------------------------------------------------------------
-- v_share_links — the only read path for brand users. security_invoker: the caller's RLS and column grants apply.
-- ---------------------------------------------------------------------------
create view public.v_share_links with (security_invoker = true) as
select l.id, l.brand_id, l.campaign_id, l.expires_at, l.revoked_at, l.created_by, l.created_at,
       case when l.revoked_at is not null then 'revoked'
            when l.expires_at <= now() then 'expired'
            else 'active' end::text as status
from public.share_links l;
grant select on public.v_share_links to authenticated;

-- ---------------------------------------------------------------------------
-- create_share_link — owner-only; not_owner → invalid_input → not_in_brand; returns the raw token once.
-- The 32 random bytes are base64url-encoded without padding: 43 chars of [A-Za-z0-9_-]. Only sha256(token) is
-- stored. The password is never trimmed or case-folded (an 8-char password of spaces + x is accepted).
-- ---------------------------------------------------------------------------
create function public.create_share_link(p_campaign_id uuid, p_password text, p_expires_at timestamptz default null)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_brand_id uuid := (select public.current_brand_id());
  v_token text;
begin
  if (select public.current_app_role()) is distinct from 'owner' then raise exception 'not_owner'; end if;
  if p_password is null or length(p_password) < 8 or p_expires_at <= now() then raise exception 'invalid_input'; end if;
  if not exists (select 1 from public.campaigns k where k.id = p_campaign_id and k.brand_id = v_brand_id) then
    raise exception 'not_in_brand';
  end if;

  v_token := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  insert into public.share_links (brand_id, campaign_id, token_hash, password_hash, expires_at, created_by)
  values (v_brand_id, p_campaign_id,
          sha256(convert_to(v_token, 'UTF8')),
          extensions.crypt(p_password, extensions.gen_salt('bf')),
          p_expires_at, auth.uid());
  return v_token;
end $$;
comment on function public.create_share_link(uuid, text, timestamptz) is
  'Publish a share link for one campaign of the caller''s brand: not_owner (role is distinct from owner), invalid_input (password null or shorter than 8 chars — never trimmed — or expires_at in the past), not_in_brand (foreign / unknown / null campaign). Stores sha256(token) + bcrypt(password) and returns the raw URL-safe token — the only time it is visible.';

-- ---------------------------------------------------------------------------
-- revoke_share_link — owner-only; unknown / other-brand id → not_in_brand; an already-revoked own link is a no-op.
-- ---------------------------------------------------------------------------
create function public.revoke_share_link(p_id uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_brand_id uuid := (select public.current_brand_id());
begin
  if (select public.current_app_role()) is distinct from 'owner' then raise exception 'not_owner'; end if;
  update public.share_links l set revoked_at = now()
   where l.id = p_id and l.brand_id = v_brand_id and l.revoked_at is null;
  if not found and not exists (select 1 from public.share_links l where l.id = p_id and l.brand_id = v_brand_id) then
    raise exception 'not_in_brand';
  end if;
end $$;
comment on function public.revoke_share_link(uuid) is
  'Revoke one share link of the caller''s brand: not_owner for analysts, not_in_brand for an unknown or foreign id; revoking an already-revoked link is a no-op.';

-- ---------------------------------------------------------------------------
-- get_shared_results — the stranger's door. Returns exactly one row; status decides whether the rest is filled.
-- Order: coalesce args → hash → advisory lock per token → prune the ledger → 10+ recent failures → rate_limited
-- → load the link → ONE bcrypt (dummy hash when unknown) → checks → record the failure (existing links only)
-- and share_denied, or the campaign's `reported` aggregate row with captions (no ids, no spend, no contacts).
-- The dummy hash was generated once with
--   select extensions.crypt(encode(extensions.gen_random_bytes(16), 'hex'), extensions.gen_salt('bf'))
-- and pasted here: same algorithm and cost ($2a$06$) as every stored password_hash.
-- ---------------------------------------------------------------------------
create function public.get_shared_results(p_token text, p_password text)
returns table (
  status text, campaign_name text, channel text, sent_at timestamptz,
  reported_sent bigint, reported_delivered bigint, reported_bounced bigint, reported_opens bigint, reported_clicks bigint,
  delivered_rate numeric, bounce_rate numeric, open_rate numeric, click_rate numeric, unsubscribe_rate numeric,
  captions jsonb
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  c_dummy_hash constant text := '$2a$06$JW01TLb113BR38BnVO1tb.8iiONoC58NlGNsAjUf3nHyPHPmBCQlW';
  v_hash bytea;
  v_link public.share_links;
  v_link_found boolean;
  v_compare_hash text;
  v_match boolean;
  v_ok boolean;
begin
  p_token := coalesce(p_token, '');
  p_password := coalesce(p_password, '');
  v_hash := sha256(convert_to(p_token, 'UTF8'));

  -- serialise concurrent guesses on the same token: the ledger count below is then exact
  perform pg_advisory_xact_lock(hashtext(encode(v_hash, 'hex')));

  delete from internal.share_attempts a where a.token_hash = v_hash and a.attempted_at < now() - interval '15 minutes';
  if (select count(*) from internal.share_attempts a where a.token_hash = v_hash) >= 10 then
    return query select 'rate_limited'::text, null::text, null::text, null::timestamptz,
                        null::bigint, null::bigint, null::bigint, null::bigint, null::bigint,
                        null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::jsonb;
    return;
  end if;

  select * into v_link from public.share_links l where l.token_hash = v_hash;
  v_link_found := found;

  -- exactly one bcrypt on every path from here (unknown token → the dummy hash, same cost): no timing oracle
  v_compare_hash := coalesce(v_link.password_hash, c_dummy_hash);
  v_match := extensions.crypt(p_password, v_compare_hash) = v_compare_hash;

  v_ok := v_link_found and v_match
      and v_link.revoked_at is null
      and (v_link.expires_at is null or v_link.expires_at > now())
      and exists (select 1 from public.campaigns k where k.id = v_link.campaign_id and k.brand_id = v_link.brand_id);

  if not v_ok then
    if v_link_found then insert into internal.share_attempts (token_hash) values (v_hash); end if;
    return query select 'share_denied'::text, null::text, null::text, null::timestamptz,
                        null::bigint, null::bigint, null::bigint, null::bigint, null::bigint,
                        null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::jsonb;
    return;
  end if;

  -- the campaign's own `reported` row from the one definition of every rate (D-5), plus the captions
  return query
    select 'ok'::text, p.name, p.channel, p.sent_at,
           p.sent::bigint, p.delivered::bigint, p.bounced::bigint, p.opens::bigint, p.clicks::bigint,
           p.delivered_rate, p.bounce_rate, p.open_rate, p.click_rate, p.unsubscribe_rate,
           (select jsonb_object_agg(r.key, r.rule_text) from public.metric_rules r
             where r.key in ('delivered_rate', 'bounce_rate', 'open_rate', 'click_rate', 'unsubscribe_rate'))
           || jsonb_build_object('source', 'as reported by the source')
      from public.v_campaign_performance p
     where p.campaign_id = v_link.campaign_id and p.source = 'reported';
end $$;
comment on function public.get_shared_results(text, text) is
  'The public share page''s only query. Returns exactly one row: status ok (with the campaign''s reported aggregate row and captions), share_denied (wrong token / wrong password / revoked / expired / campaign gone — indistinguishable, one bcrypt each) or rate_limited (10+ failures on an existing token in 15 minutes). Never raises: a raise would roll back the attempt it records.';

-- ---------------------------------------------------------------------------
-- Grants (D-2): defaults are revoked in 0000, so every function is allow-listed explicitly. anon may execute
-- get_shared_results and nothing else; the owner RPCs are authenticated-only.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_share_link(uuid, text, timestamptz), public.revoke_share_link(uuid) from public, anon;
grant execute on function public.create_share_link(uuid, text, timestamptz), public.revoke_share_link(uuid) to authenticated;
revoke execute on function public.get_shared_results(text, text) from public;
grant execute on function public.get_shared_results(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Epic 3 review follow-ups (Story 3.1 Completion Notes, "PM decisions"): 0005 is frozen on hosted, so both ride here.
--
-- (1) metric_rules: the four rate rows other than open_rate carried the open-rate alternative ("Opens ÷ delivered;
--     unique opens") verbatim from the story split of PRD §5; each now names the rejected way of computing ITS
--     rate. open_rate keeps the PRD wording. The `contactable` alternative ("11.9k Kilele contacts differ") is
--     left PRD-verbatim: it quotes a figure the PRD publishes, not tenant data, and 0005's test pins it.
-- ---------------------------------------------------------------------------
insert into public.metric_rules (key, label, rule_text, alternative_text) values
  ('delivered_rate', $t$Delivered rate$t$,
   $t$`delivered rate = delivered ÷ sent`. Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked$t$,
   $t$Delivered ÷ (sent − bounced); counting every delivered event instead of one per contact$t$),
  ('bounce_rate', $t$Bounce rate$t$,
   $t$`bounce rate = bounced ÷ sent`. Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked$t$,
   $t$Bounced ÷ delivered; counting every bounce event instead of one per contact$t$),
  ('click_rate', $t$Click rate$t$,
   $t$`click rate = clicks ÷ sent`. Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked$t$,
   $t$Clicks ÷ opens (click-to-open); unique clicks$t$),
  ('unsubscribe_rate', $t$Unsubscribe rate$t$,
   $t$`unsubscribe rate = unsubscribes ÷ sent`. Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked$t$,
   $t$Unsubscribes ÷ delivered; counting the contact's current status instead of the event$t$)
on conflict (key) do update
  set label = excluded.label,
      rule_text = excluded.rule_text,
      alternative_text = excluded.alternative_text;

-- ---------------------------------------------------------------------------
-- (2) v_signups_30d: identical columns and semantics to 0005, but `with w as not materialized` so the window
--     bounds are inlined into the signup_at predicates and idx_contacts_brand_id_signup_at is used (0005's
--     materialised CTE — referenced three times, so materialised by default — made them a join filter; the
--     0005 comment saying the index "serves them" was wrong until now).
-- ---------------------------------------------------------------------------
create or replace view public.v_signups_30d with (security_invoker = true) as
with w as not materialized (select (now() at time zone 'utc')::date as window_end),
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
comment on view public.v_signups_30d is
  '30 zero-filled UTC days ending today (UTC), one row per brand per day; window_start / window_end / future_dated_count repeated on every row. The window CTE is NOT MATERIALIZED (0011) so the signup_at range predicates reach idx_contacts_brand_id_signup_at.';
