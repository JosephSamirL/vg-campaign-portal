-- 0011_share.test.sql — the share-link boundary (Story 5.1; D-1, D-2, D-5, D-10; Step-3 amendment #7; S1, S2, S20).
--
-- Synthetic brands A (owner + analyst) and B (owner) with campaigns carrying reported_* counts, all under one
-- transaction, rolled back; the local seed data is never touched. Pins: the table / ledger / view shape and the
-- grant surface (column-level SELECT only — `select *` and `select token_hash` are refused by Postgres); the owner
-- RPCs' error contract (not_owner → invalid_input → not_in_brand, never a trimmed password); the stranger's door
-- returning exactly one row whose status is ok / share_denied / rate_limited (never raising), one bcrypt on every
-- path, attempts recorded only for existing tokens, 10 failures then rate_limited, revoked / expired / campaign
-- gone → share_denied; anon holds nothing but EXECUTE on get_shared_results. Plus the Epic 3 follow-ups riding in
-- 0011: per-rate metric_rules alternatives and v_signups_30d NOT MATERIALIZED.

begin;
create extension if not exists pgtap with schema extensions;
select plan(191);

-- ============================================================================
-- T: shape — share_links, internal.share_attempts, v_share_links, the three functions, the grant surface.
-- ============================================================================
select has_table('public', 'share_links', 'T1 public.share_links exists');
select columns_are('public', 'share_links', array['id', 'brand_id', 'campaign_id', 'token_hash', 'password_hash', 'expires_at', 'revoked_at', 'created_by', 'created_at'], 'T1 share_links columns');
select col_is_pk('public', 'share_links', 'id', 'T1 share_links.id is the primary key');
select col_is_unique('public', 'share_links', 'token_hash', 'T1 share_links.token_hash is unique');
select col_type_is('public', 'share_links', 'token_hash', 'bytea', 'T1 token_hash is bytea');
select col_type_is('public', 'share_links', 'password_hash', 'text', 'T1 password_hash is text');
select col_not_null('public', 'share_links', 'created_by', 'T1 created_by is not null');
select col_is_null('public', 'share_links', 'expires_at', 'T1 expires_at is nullable');
select col_is_null('public', 'share_links', 'revoked_at', 'T1 revoked_at is nullable');
select fk_ok('public', 'share_links', 'brand_id', 'public', 'brands', 'id', 'T1 share_links.brand_id → brands');
select fk_ok('public', 'share_links', 'campaign_id', 'public', 'campaigns', 'id', 'T1 share_links.campaign_id → campaigns');
select ok(c.relrowsecurity and c.relforcerowsecurity, 'T2 share_links RLS enabled + forced')
from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'share_links';
select is(
  (select row(p.cmd, p.roles::text[], p.qual)::text from pg_policies p where p.schemaname = 'public' and p.tablename = 'share_links' and p.policyname = 'share_links_select_own_brand'),
  row('SELECT', array['authenticated'], '(brand_id = ( SELECT current_brand_id() AS current_brand_id))')::text,
  'T2 policy share_links_select_own_brand: select, to authenticated, brand_id = (select current_brand_id())');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'share_links'), 1::bigint, 'T2 share_links has exactly one policy (no write policy)');

-- the grant surface: column-level SELECT on the non-hash columns only, nothing table-level, nothing for anon
select ok(not has_table_privilege('authenticated', 'public.share_links', 'select'), 'T3 authenticated has NO table-level SELECT on share_links');
select ok(not has_table_privilege('authenticated', 'public.share_links', 'insert,update,delete,truncate'), 'T3 authenticated has no write privilege on share_links');
select ok(not has_table_privilege('anon', 'public.share_links', 'select,insert,update,delete'), 'T3 anon has no table privilege on share_links');
select ok(not has_any_column_privilege('anon', 'public.share_links', 'select'), 'T3 anon has no column privilege on share_links');
select set_eq(
  $$ select a.attname::text from pg_attribute a
     where a.attrelid = 'public.share_links'::regclass and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated', 'public.share_links', a.attname, 'select') $$,
  array['id', 'brand_id', 'campaign_id', 'expires_at', 'revoked_at', 'created_by', 'created_at'],
  'T3 authenticated may SELECT exactly the seven non-hash columns');
select ok(not has_column_privilege('authenticated', 'public.share_links', 'token_hash', 'select'), 'T3 token_hash is not selectable by authenticated');
select ok(not has_column_privilege('authenticated', 'public.share_links', 'password_hash', 'select'), 'T3 password_hash is not selectable by authenticated');

select has_table('internal', 'share_attempts', 'T4 internal.share_attempts exists');
select columns_are('internal', 'share_attempts', array['token_hash', 'attempted_at'], 'T4 share_attempts columns');
select has_index('internal', 'share_attempts', 'idx_share_attempts_token_hash_attempted_at', array['token_hash', 'attempted_at'], 'T4 idx_share_attempts_token_hash_attempted_at (token_hash, attempted_at)');
select is((select count(*) from pg_policies where schemaname = 'internal' and tablename = 'share_attempts'), 0::bigint, 'T4 share_attempts has no policy (unexposed schema)');
select ok(not has_table_privilege('authenticated', 'internal.share_attempts', 'select,insert,update,delete'), 'T4 authenticated holds nothing on share_attempts');
select ok(not has_table_privilege('anon', 'internal.share_attempts', 'select,insert,update,delete'), 'T4 anon holds nothing on share_attempts');

select has_view('public', 'v_share_links', 'T5 public.v_share_links exists');
select columns_are('public', 'v_share_links', array['id', 'brand_id', 'campaign_id', 'expires_at', 'revoked_at', 'created_by', 'created_at', 'status'], 'T5 v_share_links = the non-hash columns + status');
select ok(exists (select 1 from pg_options_to_table(c.reloptions) o where o.option_name = 'security_invoker' and o.option_value in ('true', 'on', '1')), 'T5 v_share_links is security_invoker')
from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'v_share_links';
select ok(has_table_privilege('authenticated', 'public.v_share_links', 'select'), 'T5 authenticated may select v_share_links');
select ok(not has_table_privilege('anon', 'public.v_share_links', 'select'), 'T5 anon may not select v_share_links');

-- the three functions: secdef, search_path pinned, volatile, and the exact EXECUTE surface
select has_function('public', 'create_share_link', array['uuid', 'text', 'timestamp with time zone'], 'T6 create_share_link(uuid, text, timestamptz) exists');
select function_returns('public', 'create_share_link', array['uuid', 'text', 'timestamp with time zone'], 'text', 'T6 create_share_link returns text');
select has_function('public', 'revoke_share_link', array['uuid'], 'T6 revoke_share_link(uuid) exists');
select function_returns('public', 'revoke_share_link', array['uuid'], 'void', 'T6 revoke_share_link returns void');
select has_function('public', 'get_shared_results', array['text', 'text'], 'T6 get_shared_results(text, text) exists');
select function_returns('public', 'get_shared_results', array['text', 'text'], 'setof record', 'T6 get_shared_results returns a table');
select is(p.proargnames[3:17], array['status', 'campaign_name', 'channel', 'sent_at', 'reported_sent', 'reported_delivered', 'reported_bounced', 'reported_opens', 'reported_clicks', 'delivered_rate', 'bounce_rate', 'open_rate', 'click_rate', 'unsubscribe_rate', 'captions'],
  'T6 get_shared_results output columns, in order')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_shared_results';
select ok(p.prosecdef and p.provolatile = 'v' and exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=""'), format('T7 %s is security definer, volatile, search_path = ''''', p.proname))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('create_share_link', 'revoke_share_link', 'get_shared_results') order by p.proname;
select ok(has_function_privilege('authenticated', 'public.create_share_link(uuid, text, timestamptz)', 'execute'), 'T8 authenticated may execute create_share_link');
select ok(has_function_privilege('authenticated', 'public.revoke_share_link(uuid)', 'execute'), 'T8 authenticated may execute revoke_share_link');
select ok(has_function_privilege('authenticated', 'public.get_shared_results(text, text)', 'execute'), 'T8 authenticated may execute get_shared_results');
select ok(has_function_privilege('anon', 'public.get_shared_results(text, text)', 'execute'), 'T8 anon may execute get_shared_results');
select ok(not has_function_privilege('anon', 'public.create_share_link(uuid, text, timestamptz)'::regprocedure, 'execute'), 'T8 anon may not execute create_share_link');
select ok(not has_function_privilege('anon', 'public.revoke_share_link(uuid)'::regprocedure, 'execute'), 'T8 anon may not execute revoke_share_link');
select ok(not has_function_privilege('public', 'public.get_shared_results(text, text)'::regprocedure, 'execute'), 'T8 PUBLIC may not execute get_shared_results');
select set_eq(
  $$ select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute') $$,
  array['get_shared_results'],
  'T8 anon may execute get_shared_results and nothing else in public');

-- structure of the timing defence: exactly one bcrypt call, against coalesce(link hash, dummy), dummy of the same cost
select is((select count(*) from regexp_matches(p.prosrc, 'extensions\.crypt\(', 'g')), 1::bigint, 'T9 get_shared_results calls extensions.crypt exactly once (no branch skips the bcrypt)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_shared_results';
select ok(p.prosrc ~ 'coalesce\(v_link\.password_hash, c_dummy_hash\)', 'T9 the bcrypt compares against coalesce(link.password_hash, c_dummy_hash)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_shared_results';
select ok(p.prosrc ~ 'c_dummy_hash constant text := ''\$2a\$06\$[./A-Za-z0-9]{53}''', 'T9 c_dummy_hash is a bcrypt hash of cost 6 — the cost gen_salt(''bf'') stores')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_shared_results';
select ok(p.prosrc ~ 'pg_advisory_xact_lock\(hashtext\(encode\(v_hash, ''hex''\)\)\)', 'T9 the per-token advisory lock is taken')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_shared_results';
select ok(p.prosrc !~ 'raise exception', 'T9 get_shared_results never raises (a raise would roll back the recorded attempt)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_shared_results';
select ok(p.prosrc !~* 'btrim|ltrim|rtrim\(p_password|lower\(p_password', format('T9 %s never trims or case-folds the password', p.proname))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('create_share_link', 'get_shared_results') order by p.proname;

-- ============================================================================
-- fixtures — brands A (owner + analyst) and B (owner); campaigns with reported_* counts; one contact each.
-- ============================================================================
create function pg_temp.fx() returns void language plpgsql as $$
declare
  ba uuid; bb uuid;
  owner_a uuid := '00000000-0000-4000-8000-0000000000f1';
  analyst_a uuid := '00000000-0000-4000-8000-0000000000f2';
  owner_b uuid := '00000000-0000-4000-8000-0000000000f3';
begin
  insert into public.brands (code, name) values ('SHARETEST-A', 'Share Test Brand A') returning id into ba;
  insert into public.brands (code, name) values ('SHARETEST-B', 'Share Test Brand B') returning id into bb;
  perform set_config('share.brand_a', ba::text, true);
  perform set_config('share.brand_b', bb::text, true);
  perform set_config('share.owner_a', owner_a::text, true);
  perform set_config('share.analyst_a', analyst_a::text, true);
  perform set_config('share.owner_b', owner_b::text, true);

  insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (owner_a,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-share-owner-a@tenancy.test',   '{}', '{}', now(), now()),
         (analyst_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-share-analyst-a@tenancy.test', '{}', '{}', now(), now()),
         (owner_b,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-share-owner-b@tenancy.test',   '{}', '{}', now(), now());
  insert into public.app_users (email, brand_id, role, auth_user_id)
  values ('fixture-share-owner-a@tenancy.test',   ba, 'owner',   owner_a),
         ('fixture-share-analyst-a@tenancy.test', ba, 'analyst', analyst_a),
         ('fixture-share-owner-b@tenancy.test',   bb, 'owner',   owner_b);

  insert into public.contacts (brand_id, external_id, email, country, status, consent_marketing)
  values (ba, 'SH-A1', 'sh-a1@x.test', 'KE', 'active', true),
         (bb, 'SH-B1', 'sh-b1@x.test', 'KE', 'active', true);

  -- KIL-0016's real counts on campaign A1 (opens > sent: the unclamped 119.16 must come through untouched)
  insert into public.campaigns (id, brand_id, external_id, name, channel, sent_at, spend, reported_sent, reported_delivered, reported_bounced, reported_opens, reported_clicks) values
    ('00000000-0000-4000-8000-00000000c101', ba, 'CMP-share-A1', 'Share Campaign A1', 'email', '2026-03-01T09:00:00Z', 1234.56, 10640, 10214, 426, 12679, 1183),
    ('00000000-0000-4000-8000-00000000c102', ba, 'CMP-share-A2', 'Share Campaign A2', 'sms',   '2026-04-01T09:00:00Z', null,    0,     0,     0,   0,     0),
    ('00000000-0000-4000-8000-00000000c103', ba, 'CMP-share-A3', 'Share Campaign A3', 'email', '2026-05-01T09:00:00Z', null,    100,   90,    10,  50,    5),
    ('00000000-0000-4000-8000-00000000c1b1', bb, 'CMP-share-B1', 'Share Campaign B1', 'email', '2026-03-01T09:00:00Z', null,    200,   180,   20,  100,   10);
end $$;
select pg_temp.fx();

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- one unlock attempt: the status of the single row get_shared_results returns (and proves it is a single row)
create function pg_temp.unlock(p_token text, p_password text) returns text language plpgsql as $$
declare v_status text; v_rows bigint;
begin
  select count(*), min(r.status) into v_rows, v_status from public.get_shared_results(p_token, p_password) r;
  if v_rows <> 1 then return format('%s rows', v_rows); end if;
  return v_status;
end $$;
-- called while the role is authenticated / anon: default privileges (0000) leave temp functions to postgres only
grant execute on function pg_temp.as_postgres(), pg_temp.unlock(text, text) to public;

-- ============================================================================
-- R: the analyst — not_owner on both owner RPCs, nothing written; a user with no app_users row likewise.
-- ============================================================================
select pg_temp.as_user(current_setting('share.analyst_a'));
select is(current_user::text, 'authenticated', 'R0 running as authenticated (analyst of brand A)');
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c101', 'correct-horse') $$, 'P0001', 'not_owner', 'R1 analyst → not_owner on create_share_link');
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c1b1', 'correct-horse') $$, 'P0001', 'not_owner', 'R1 analyst → not_owner even for brand B''s campaign (role check first)');
select throws_ok($$ select public.revoke_share_link('00000000-0000-4000-8000-00000000c101') $$, 'P0001', 'not_owner', 'R2 analyst → not_owner on revoke_share_link');
select is((select count(*) from public.v_share_links), 0::bigint, 'R3 analyst sees no links yet');
select pg_temp.as_postgres();
select pg_temp.as_user('00000000-0000-4000-8000-0000000000fe');
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c101', 'correct-horse') $$, 'P0001', 'not_owner', 'R4 a user with no app_users row (null role) → not_owner, never a silent pass');
select pg_temp.as_postgres();
select is((select count(*) from public.share_links), 0::bigint, 'R5 nothing was written');

-- ============================================================================
-- O: the owner of brand A — the error contract in order, then the links.
-- ============================================================================
select pg_temp.as_user(current_setting('share.owner_a'));
select is(public.current_app_role(), 'owner'::public.app_role, 'O0 running as the owner of brand A');

-- invalid_input: password null / 7 chars / expiry in the past — before the brand check
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c101', null) $$, 'P0001', 'invalid_input', 'O1 null password → invalid_input');
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c101', 'abcdefg') $$, 'P0001', 'invalid_input', 'O1 7-char password → invalid_input');
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c101', '       ') $$, 'P0001', 'invalid_input', 'O1 7 spaces → invalid_input (length, not content)');
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c101', 'correct-horse', now() - interval '1 second') $$, 'P0001', 'invalid_input', 'O1 expires_at in the past → invalid_input');
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c1b1', 'abcdefg') $$, 'P0001', 'invalid_input', 'O1 invalid_input precedes the brand check');
-- not_in_brand: brand B's campaign, an unknown id, null
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c1b1', 'correct-horse') $$, 'P0001', 'not_in_brand', 'O2 brand B''s campaign → not_in_brand');
select throws_ok($$ select public.create_share_link('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e', 'correct-horse') $$, 'P0001', 'not_in_brand', 'O2 unknown campaign → not_in_brand');
select throws_ok($$ select public.create_share_link(null, 'correct-horse') $$, 'P0001', 'not_in_brand', 'O2 null campaign → not_in_brand');
select is((select count(*) from public.v_share_links), 0::bigint, 'O3 every refusal wrote nothing');

-- the links: L1 (success / revoke), L2 (expiry), L3 (rate limit), L4 (8 chars with spaces — never trimmed)
do $$ begin   -- a DO block so the raw tokens never appear in the TAP output
  perform set_config('share.token1', public.create_share_link('00000000-0000-4000-8000-00000000c101', 'correct-horse'), true);
  perform set_config('share.token2', public.create_share_link('00000000-0000-4000-8000-00000000c103', 'password-2', now() + interval '1 day'), true);
  perform set_config('share.token3', public.create_share_link('00000000-0000-4000-8000-00000000c101', 'limit-pass'), true);
  perform set_config('share.token4', public.create_share_link('00000000-0000-4000-8000-00000000c102', '       x'), true);
end $$;
select ok(current_setting('share.token1') ~ '^[A-Za-z0-9_-]{43}$', 'O4 the token is 43 URL-safe chars (32 random bytes, base64url, no padding)');
select ok(current_setting('share.token4') ~ '^[A-Za-z0-9_-]{43}$', 'O4 ''       x'' (8 chars with spaces) is accepted: a token was returned');
select isnt(current_setting('share.token1'), current_setting('share.token3'), 'O4 two links on the same campaign get different tokens');

-- what the owner can and cannot read: column-level grants, RLS, the view
select throws_ok($$ select * from public.share_links $$, '42501', null, 'O5 select * from share_links → 42501 for authenticated');
select throws_ok($$ select token_hash from public.share_links $$, '42501', null, 'O5 select token_hash → 42501');
select throws_ok($$ select password_hash from public.share_links $$, '42501', null, 'O5 select password_hash → 42501');
select throws_ok($$ select count(*) from public.share_links where password_hash like '$2a$%' $$, '42501', null, 'O5 a hash column in a predicate → 42501 (no oracle through WHERE)');
select is((select count(*) from public.share_links), 4::bigint, 'O5 count(*) over the granted columns: four own links');
select is((select count(*) from public.share_links where brand_id = current_setting('share.brand_a')::uuid), 4::bigint, 'O5 select of granted columns works: all four carry brand A');
select is((select count(*) from public.v_share_links), 4::bigint, 'O6 v_share_links: four own links');
select is((select string_agg(distinct status, ',') from public.v_share_links), 'active', 'O6 all four are active');
select ok((select bool_and(created_by = current_setting('share.owner_a')::uuid) from public.v_share_links), 'O6 created_by = auth.uid() of the owner');
select is((select count(*) from public.v_share_links where expires_at is not null), 1::bigint, 'O6 only L2 carries an expiry');
select ok((select bool_and(revoked_at is null) from public.v_share_links), 'O6 nothing is revoked yet');
select throws_ok($$ insert into public.share_links (brand_id, campaign_id, token_hash, password_hash, created_by) values ('00000000-0000-4000-8000-00000000c101', '00000000-0000-4000-8000-00000000c101', '\x00', 'x', '00000000-0000-4000-8000-00000000c101') $$, '42501', null, 'O7 a plain insert into share_links → 42501');
select throws_ok($$ update public.share_links set revoked_at = now() $$, '42501', null, 'O7 a plain update → 42501');
select throws_ok($$ delete from public.share_links $$, '42501', null, 'O7 a plain delete → 42501');
select throws_ok($$ select count(*) from internal.share_attempts $$, '42501', null, 'O7 internal.share_attempts is unreachable for authenticated');

-- revoke: unknown / brand B's → not_in_brand; own → revoked; again → no-op
select throws_ok($$ select public.revoke_share_link('4c4f3b6e-2c1a-4e0f-9f5e-0b1d2a3c4d5e') $$, 'P0001', 'not_in_brand', 'O8 revoke of an unknown id → not_in_brand');
select throws_ok($$ select public.revoke_share_link(null) $$, 'P0001', 'not_in_brand', 'O8 revoke of null → not_in_brand');
select pg_temp.as_postgres();
do $$ begin
  perform set_config('share.link1', (select id::text from public.share_links where token_hash = sha256(convert_to(current_setting('share.token1'), 'UTF8'))), true);
  perform set_config('share.link2', (select id::text from public.share_links where token_hash = sha256(convert_to(current_setting('share.token2'), 'UTF8'))), true);
  perform set_config('share.link3', (select id::text from public.share_links where token_hash = sha256(convert_to(current_setting('share.token3'), 'UTF8'))), true);
end $$;
select ok((select bool_and(password_hash ~ '^\$2a\$06\$[./A-Za-z0-9]{53}$') from public.share_links), 'O9 (as postgres) every stored password_hash is bcrypt cost 6 — the dummy hash''s cost');
select ok((select bool_and(token_hash = sha256(convert_to(t, 'UTF8'))) from unnest(array[current_setting('share.token1'), current_setting('share.token2'), current_setting('share.token3'), current_setting('share.token4')]) t join public.share_links l on l.token_hash = sha256(convert_to(t, 'UTF8'))), 'O9 (as postgres) token_hash = sha256(token) for every link');
select is((select count(*) from public.share_links l where l.password_hash = extensions.crypt('correct-horse', l.password_hash)), 1::bigint, 'O9 (as postgres) exactly one link unlocks with correct-horse (L1)');
select is((select count(*) from public.share_links l where l.password_hash = extensions.crypt('       x', l.password_hash)), 1::bigint, 'O9 (as postgres) the spaces password was stored untrimmed (L4 unlocks with the spaces)');
select is((select count(*) from public.share_links l where l.password_hash = extensions.crypt('x', l.password_hash)), 0::bigint, 'O9 (as postgres) the trimmed form does not unlock anything');

-- ============================================================================
-- B: the owner of brand B — own link works; brand A's link / campaign are not_in_brand; sees only own rows.
-- ============================================================================
select pg_temp.as_user(current_setting('share.owner_b'));
do $$ begin perform set_config('share.tokenb', public.create_share_link('00000000-0000-4000-8000-00000000c1b1', 'brand-b-pass'), true); end $$;
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c101', 'correct-horse') $$, 'P0001', 'not_in_brand', 'B1 owner of B: brand A''s campaign → not_in_brand');
select throws_ok(format($$ select public.revoke_share_link(%L) $$, current_setting('share.link1')), 'P0001', 'not_in_brand', 'B2 owner of B: brand A''s link id → not_in_brand');
select is((select count(*) from public.v_share_links), 1::bigint, 'B3 owner of B sees exactly one link');
select is((select brand_id from public.v_share_links), current_setting('share.brand_b')::uuid, 'B3 ... carrying brand B');
select is((select count(*) from public.share_links where brand_id = current_setting('share.brand_a')::uuid), 0::bigint, 'B3 no brand A row through the granted columns either');
select pg_temp.as_postgres();
select ok((select revoked_at is null from public.share_links where id = current_setting('share.link1')::uuid), 'B2 (as postgres) brand A''s link was not revoked by B');

-- ============================================================================
-- N: the stranger (anon) — permission denied on every table and owner RPC; get_shared_results is the only door.
-- ============================================================================
set local role anon;
select is(current_user::text, 'anon', 'N0 running as anon');
select throws_ok($$ select count(*) from public.share_links $$, '42501', null, 'N1 anon: share_links → 42501');
select throws_ok($$ select count(*) from public.v_share_links $$, '42501', null, 'N1 anon: v_share_links → 42501');
select throws_ok($$ select count(*) from public.campaigns $$, '42501', null, 'N1 anon: campaigns → 42501');
select throws_ok($$ select count(*) from public.contacts $$, '42501', null, 'N1 anon: contacts → 42501');
select throws_ok($$ select count(*) from public.v_campaign_performance $$, '42501', null, 'N1 anon: v_campaign_performance → 42501');
select throws_ok($$ select count(*) from public.metric_rules $$, '42501', null, 'N1 anon: metric_rules → 42501');
select throws_ok($$ select count(*) from internal.share_attempts $$, '42501', null, 'N1 anon: internal.share_attempts → 42501');
select throws_ok($$ select public.create_share_link('00000000-0000-4000-8000-00000000c101', 'correct-horse') $$, '42501', null, 'N2 anon: create_share_link → 42501');
select throws_ok(format($$ select public.revoke_share_link(%L) $$, current_setting('share.link1')), '42501', null, 'N2 anon: revoke_share_link → 42501');

-- share_denied: wrong token (43 well-formed chars, empty, null), wrong password, empty password, null password
select is(pg_temp.unlock(repeat('A', 43), 'correct-horse'), 'share_denied', 'N3 unknown token → share_denied (one row)');
select is(pg_temp.unlock('', 'correct-horse'), 'share_denied', 'N3 empty token → share_denied');
select is(pg_temp.unlock(null, null), 'share_denied', 'N3 null token + null password → share_denied (coalesced, no error)');
select is(pg_temp.unlock(current_setting('share.token1'), 'wrong-horse'), 'share_denied', 'N3 right token, wrong password → share_denied');
select is(pg_temp.unlock(current_setting('share.token1'), ''), 'share_denied', 'N3 right token, empty password → share_denied');
select is(pg_temp.unlock(current_setting('share.token1'), null), 'share_denied', 'N3 right token, null password → share_denied');
select is(pg_temp.unlock(current_setting('share.token1'), ' correct-horse'), 'share_denied', 'N3 a leading space is a different password (never trimmed)');
select is(pg_temp.unlock(current_setting('share.token1'), 'Correct-horse'), 'share_denied', 'N3 case matters (never folded)');
select is(pg_temp.unlock(current_setting('share.tokenb'), 'correct-horse'), 'share_denied', 'N3 brand B''s token with brand A''s password → share_denied');
select ok((select bool_and(r.campaign_name is null and r.channel is null and r.sent_at is null and r.reported_sent is null and r.reported_delivered is null
                       and r.reported_bounced is null and r.reported_opens is null and r.reported_clicks is null and r.delivered_rate is null
                       and r.bounce_rate is null and r.open_rate is null and r.click_rate is null and r.unsubscribe_rate is null and r.captions is null)
           from public.get_shared_results(current_setting('share.token1'), 'wrong-horse') r), 'N3 a share_denied row carries nothing but the status');

-- timing: the unknown-token path runs the same bcrypt as the wrong-password path (cost 6 ≈ 4–5 ms here; a short-circuit
-- that skipped the dummy crypt would answer in well under 0.1 ms). Each call is measured with clock_timestamp.
create temp table t_timing as
select 'unknown_token' as path, extract(epoch from (clock_timestamp() - t0)) * 1000 as ms
  from (select clock_timestamp() as t0, (select r.status from public.get_shared_results(repeat('B', 43), 'correct-horse') r)) x
union all
select 'wrong_password', extract(epoch from (clock_timestamp() - t0)) * 1000
  from (select clock_timestamp() as t0, (select r.status from public.get_shared_results(current_setting('share.token1'), 'wrong-horse-2') r)) x;
select cmp_ok(ms, '>=', 1.0::numeric, format('N3 timing: the %s path paid for a bcrypt (>= 1 ms)', path)) from t_timing order by path;

-- ok: L1 with the right password — the campaign's reported row + captions, no ids / spend / contacts
create temp table t_ok as select * from public.get_shared_results(current_setting('share.token1'), 'correct-horse');
select is((select count(*) from t_ok), 1::bigint, 'N4 the right password → exactly one row');
select is((select status from t_ok), 'ok', 'N4 status = ok');
select is((select campaign_name from t_ok), 'Share Campaign A1', 'N4 campaign_name is the campaign''s name');
select is((select channel from t_ok), 'email', 'N4 channel');
select is((select sent_at from t_ok), '2026-03-01T09:00:00Z'::timestamptz, 'N4 sent_at');
select is((select row(reported_sent, reported_delivered, reported_bounced, reported_opens, reported_clicks)::text from t_ok), row(10640::bigint, 10214::bigint, 426::bigint, 12679::bigint, 1183::bigint)::text, 'N4 the five reported counts, as bigint');
select is((select row(delivered_rate, bounce_rate, open_rate, click_rate)::text from t_ok), row(96.00::numeric, 4.00::numeric, 119.16::numeric, 11.12::numeric)::text, 'N4 rates = v_campaign_performance (D-5): 96.00 / 4.00 / 119.16 unclamped / 11.12');
select is((select unsubscribe_rate from t_ok), null, 'N4 unsubscribe_rate is null on a reported row (null, not 0)');
select is((select jsonb_typeof(captions) from t_ok), 'object', 'N5 captions is a jsonb object');
select set_eq($$ select jsonb_object_keys(captions) from t_ok $$, array['delivered_rate', 'bounce_rate', 'open_rate', 'click_rate', 'unsubscribe_rate', 'source'], 'N5 captions keys = the five rates + source');
select is((select captions ->> 'source' from t_ok), 'as reported by the source', 'N5 captions.source');
select is((select captions ->> 'open_rate' from t_ok), '`open rate = opens ÷ sent` (**total** opens — can exceed 100%, caption says so). Seed campaigns use `reported_*`; portal sends use ingested events, deduplicated per contact per type for delivered/bounced, total for opened/clicked', 'N5 captions.open_rate = metric_rules.rule_text verbatim');
select set_eq($$ select column_name::text from information_schema.columns where table_name = 't_ok' $$,
  array['status', 'campaign_name', 'channel', 'sent_at', 'reported_sent', 'reported_delivered', 'reported_bounced', 'reported_opens', 'reported_clicks', 'delivered_rate', 'bounce_rate', 'open_rate', 'click_rate', 'unsubscribe_rate', 'captions'],
  'N6 the ok row has no id, brand, spend, token, hash or contact column');
select is(pg_temp.unlock(current_setting('share.token4'), '       x'), 'ok', 'N6 L4 unlocks with the untrimmed spaces password');
select is(pg_temp.unlock(current_setting('share.token4'), 'x'), 'share_denied', 'N6 ... and not with the trimmed one');
select is((select reported_sent from public.get_shared_results(current_setting('share.token4'), '       x')), 0::bigint, 'N6 a sent = 0 campaign answers ok with zero counts');
select is((select open_rate from public.get_shared_results(current_setting('share.token4'), '       x')), null, 'N6 ... and null rates (nullif denominator, never an error)');
select is(pg_temp.unlock(current_setting('share.tokenb'), 'brand-b-pass'), 'ok', 'N6 brand B''s link unlocks brand B''s campaign');
select is((select campaign_name from public.get_shared_results(current_setting('share.tokenb'), 'brand-b-pass')), 'Share Campaign B1', 'N6 ... by name');

-- the rate limit on L3: ten wrong passwords → share_denied, the 11th → rate_limited, the right password too
select is((select string_agg(distinct pg_temp.unlock(current_setting('share.token3'), 'wrong-' || i), ',') from generate_series(1, 10) i), 'share_denied', 'N7 ten wrong passwords → share_denied each time');
select is(pg_temp.unlock(current_setting('share.token3'), 'wrong-11'), 'rate_limited', 'N7 the 11th → rate_limited');
select is(pg_temp.unlock(current_setting('share.token3'), 'limit-pass'), 'rate_limited', 'N7 the right password is refused while limited');
select is(pg_temp.unlock(current_setting('share.token1'), 'correct-horse'), 'ok', 'N7 the limit is per token: L1 still unlocks');
select ok((select bool_and(r.campaign_name is null and r.captions is null) from public.get_shared_results(current_setting('share.token3'), 'limit-pass') r), 'N7 a rate_limited row carries nothing but the status');
reset role;

-- the ledger, as postgres: 10 rows for L3, 0 for the unknown token, and the L1 failures above
select is((select count(*) from internal.share_attempts where token_hash = sha256(convert_to(current_setting('share.token3'), 'UTF8'))), 10::bigint, 'N8 share_attempts holds exactly 10 rows for the limited token (the 11th+ are not recorded)');
select is((select count(*) from internal.share_attempts where token_hash = sha256(convert_to(repeat('A', 43), 'UTF8'))), 0::bigint, 'N8 0 rows for the unknown token (attempts only for existing links)');
select is((select count(*) from internal.share_attempts where token_hash = sha256(convert_to('', 'UTF8'))), 0::bigint, 'N8 0 rows for the empty token');
select is((select count(*) from internal.share_attempts where token_hash = sha256(convert_to(current_setting('share.token1'), 'UTF8'))), 7::bigint, 'N8 7 rows for L1 (wrong ×3, empty, null, leading-space, case)');
select is((select count(*) from internal.share_attempts where token_hash = sha256(convert_to(current_setting('share.token4'), 'UTF8'))), 1::bigint, 'N8 1 row for L4 (the trimmed guess)');
-- the prune: ageing the ledger beyond 15 minutes lifts the limit and the next call deletes the stale rows
update internal.share_attempts set attempted_at = now() - interval '16 minutes' where token_hash = sha256(convert_to(current_setting('share.token3'), 'UTF8'));
set local role anon;
select is(pg_temp.unlock(current_setting('share.token3'), 'limit-pass'), 'ok', 'N9 after 15 minutes the limit lifts: the right password unlocks L3');
reset role;
select is((select count(*) from internal.share_attempts where token_hash = sha256(convert_to(current_setting('share.token3'), 'UTF8'))), 0::bigint, 'N9 the stale attempts were pruned by the call itself');
-- a mixed ledger: 9 stale + 9 fresh rows never counts as limited (only the last 15 minutes count)
insert into internal.share_attempts (token_hash, attempted_at)
select sha256(convert_to(current_setting('share.token3'), 'UTF8')), now() - interval '16 minutes' from generate_series(1, 9);
insert into internal.share_attempts (token_hash, attempted_at)
select sha256(convert_to(current_setting('share.token3'), 'UTF8')), now() from generate_series(1, 9);
set local role anon;
select is(pg_temp.unlock(current_setting('share.token3'), 'wrong-again'), 'share_denied', 'N9 9 fresh failures (+ 9 stale) → still share_denied (the 10th fresh)');
select is(pg_temp.unlock(current_setting('share.token3'), 'limit-pass'), 'rate_limited', 'N9 ... and now 10 fresh → rate_limited');
reset role;
select is((select count(*) from internal.share_attempts where token_hash = sha256(convert_to(current_setting('share.token3'), 'UTF8'))), 10::bigint, 'N9 the ledger holds exactly the 10 fresh rows');

-- ============================================================================
-- V: revoked, expired, campaign gone — share_denied; the view's status follows.
-- ============================================================================
select pg_temp.as_user(current_setting('share.owner_a'));
select lives_ok(format($$ select public.revoke_share_link(%L) $$, current_setting('share.link1')), 'V1 owner revokes L1');
select is((select status from public.v_share_links where id = current_setting('share.link1')::uuid), 'revoked', 'V1 v_share_links.status = revoked');
select ok((select revoked_at is not null from public.v_share_links where id = current_setting('share.link1')::uuid), 'V1 revoked_at is set');
select lives_ok(format($$ select public.revoke_share_link(%L) $$, current_setting('share.link1')), 'V2 a second revoke is a no-op (no error)');
select pg_temp.as_postgres();
do $$ begin perform set_config('share.revoked_at1', (select revoked_at::text from public.share_links where id = current_setting('share.link1')::uuid), true); end $$;
select pg_temp.as_user(current_setting('share.owner_a'));
select lives_ok(format($$ select public.revoke_share_link(%L) $$, current_setting('share.link1')), 'V2 a third revoke is still a no-op');
select is((select revoked_at::text from public.v_share_links where id = current_setting('share.link1')::uuid), current_setting('share.revoked_at1'), 'V2 revoked_at was not re-stamped');
select pg_temp.as_postgres();
set local role anon;
select is(pg_temp.unlock(current_setting('share.token1'), 'correct-horse'), 'share_denied', 'V3 a revoked link → share_denied even with the right password');
reset role;
select is((select count(*) from internal.share_attempts where token_hash = sha256(convert_to(current_setting('share.token1'), 'UTF8'))), 8::bigint, 'V3 ... and the attempt is recorded (the link exists)');

-- expiry: L2 is active now, expired once expires_at is moved into the past
set local role anon;
select is(pg_temp.unlock(current_setting('share.token2'), 'password-2'), 'ok', 'V4 L2 (expires tomorrow) unlocks');
reset role;
update public.share_links set expires_at = now() - interval '1 hour' where id = current_setting('share.link2')::uuid;
set local role anon;
select is(pg_temp.unlock(current_setting('share.token2'), 'password-2'), 'share_denied', 'V4 an expired link → share_denied');
reset role;
select pg_temp.as_user(current_setting('share.owner_a'));
select is((select status from public.v_share_links where id = current_setting('share.link2')::uuid), 'expired', 'V4 v_share_links.status = expired');
select is((select string_agg(status, ',' order by status) from public.v_share_links), 'active,active,expired,revoked', 'V4 the owner''s four links: active (L3, L4), expired (L2), revoked (L1)');
select pg_temp.as_postgres();

-- campaign gone: a link whose campaign moved brand is share_denied (the campaign must exist in the link's brand)
update public.share_links set brand_id = current_setting('share.brand_b')::uuid where id = current_setting('share.link3')::uuid;
delete from internal.share_attempts where token_hash = sha256(convert_to(current_setting('share.token3'), 'UTF8'));
set local role anon;
select is(pg_temp.unlock(current_setting('share.token3'), 'limit-pass'), 'share_denied', 'V5 a link whose campaign is not in the link''s brand → share_denied');
reset role;
update public.share_links set brand_id = current_setting('share.brand_a')::uuid where id = current_setting('share.link3')::uuid;

-- ============================================================================
-- E: Epic 3 follow-ups riding in 0011 — per-rate metric_rules alternatives and v_signups_30d NOT MATERIALIZED.
-- ============================================================================
select is((select count(*) from public.metric_rules), 9::bigint, 'E1 still nine metric_rules rows (upsert, no duplicates)');
select is((select alternative_text from public.metric_rules where key = 'open_rate'), 'Opens ÷ delivered; unique opens', 'E1 open_rate keeps the PRD alternative');
select is((select count(*) from public.metric_rules where key in ('delivered_rate', 'bounce_rate', 'click_rate', 'unsubscribe_rate') and alternative_text = 'Opens ÷ delivered; unique opens'), 0::bigint, 'E1 no other rate row carries the open-rate alternative any more');
select is((select alternative_text from public.metric_rules where key = 'bounce_rate'), 'Bounced ÷ delivered; counting every bounce event instead of one per contact', 'E1 bounce_rate alternative names ITS rate');
select is((select count(distinct alternative_text) from public.metric_rules where key like '%_rate'), 5::bigint, 'E1 the five rate alternatives are all different');
select ok((select bool_and(alternative_text ~ '÷') from public.metric_rules where key like '%_rate'), 'E1 each rate alternative is a rejected formula (contains ÷)');
select ok(pg_get_viewdef('public.v_signups_30d'::regclass) ~* 'not materialized', 'E2 v_signups_30d is defined with NOT MATERIALIZED');
select ok(exists (select 1 from pg_class c join pg_options_to_table(c.reloptions) o on true where c.oid = 'public.v_signups_30d'::regclass and o.option_name = 'security_invoker' and o.option_value in ('true', 'on', '1')), 'E2 v_signups_30d is still security_invoker');
select columns_are('public', 'v_signups_30d', array['brand_id', 'day', 'signups', 'window_start', 'window_end', 'future_dated_count'], 'E2 v_signups_30d columns unchanged');
select ok(has_table_privilege('authenticated', 'public.v_signups_30d', 'select') and not has_table_privilege('anon', 'public.v_signups_30d', 'select'), 'E2 v_signups_30d grants unchanged');
select is((select count(*) from public.v_signups_30d where brand_id = current_setting('share.brand_a')::uuid), 30::bigint, 'E2 v_signups_30d: still 30 rows per brand');
select is((select sum(signups) from public.v_signups_30d where brand_id = current_setting('share.brand_a')::uuid), 0::numeric, 'E2 the fixture contact (no signup_at) is not counted');
-- the point of NOT MATERIALIZED: the signup_at bounds sit in the scan's own predicate (Filter / Index Cond), not in a
-- Join Filter against a materialised one-row CTE (0005's plan: "Rows Removed by Join Filter: 81394"). Plan shape only —
-- whether the scan is an index scan is the planner's call on the data at hand (on the real load: 30 ms → 0.8 ms).
create function pg_temp.plan_of(p_sql text) returns text language plpgsql as $$
declare v text := ''; r record;
begin
  for r in execute 'explain (costs off) ' || p_sql loop v := v || r."QUERY PLAN" || E'\n'; end loop;
  return v;
end $$;
-- Story 6.2: the assertion pins the property, not the join method — after the suppression backfill rewrote 36k contact
-- rows the planner switched to a merge join whose day-equality lands in a Join Filter; the signup_at bounds still sit in
-- the scan's own predicate, which is what NOT MATERIALIZED buys.
select ok(pg_temp.plan_of('select * from public.v_signups_30d') !~ 'Join Filter:[^\n]*signup_at (>=|<)', 'E3 v_signups_30d plan: no Join Filter carries the signup_at window bounds (the window CTE is inlined)');
select ok(pg_temp.plan_of('select * from public.v_signups_30d') ~ '(Index Cond|Filter): [^\n]*signup_at >=', 'E3 ... the window bounds are in the scan''s own predicate');
select ok(pg_temp.plan_of('select * from public.v_signups_30d') ~ '(Filter|Index Cond): .*signup_at >= ', 'E3 the signup_at lower bound is a scan predicate on contacts');
select ok(pg_temp.plan_of('select * from public.v_signups_30d') !~ 'CTE Scan', 'E3 no CTE Scan: nothing is materialised');
select is(current_user::text, 'postgres', 'Z1 role restored before finish');

select * from finish();
rollback;
