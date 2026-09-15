-- 0001_tenancy.test.sql — THE isolation test (architecture D-2, Step-3 amendments #1, #3, #7).
--
-- Catalog-driven: every table / view / function in every schema listed in t_exposed_schemas is
-- enumerated from pg_catalog and asserted against. Only the allow-lists below are constants.
-- Later stories ONLY append to: the allow-list inserts, t_view_exceptions, fixtures(), and the
-- per-RPC negatives block at the end. Never edit the assertions.
--
-- Runs as postgres via `supabase test db` (pg_prove). Everything is inside one transaction that
-- is rolled back, so fixture users never persist.
--
-- Catalog blocks order by the object name, never by the ok() text (`order by 1` sorts "ok 10" before
-- "ok 6" once a block crosses test #10 and pg_prove rejects the out-of-sequence TAP — Story 2.1).
-- Postgres postpones the volatile ok() until after the Sort, so numbering follows the output order.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===== allow-list constants — later stories extend here =====
create temp table t_exposed_schemas(nspname text);
insert into t_exposed_schemas values ('public');

create temp table t_allow_anon_exec(fn text);          -- 5.1: get_shared_results; 7.2: health_ping
insert into t_allow_anon_exec values ('get_shared_results');  -- Story 5.1: the stranger's only door (secdef, volatile, returns a status row)

create temp table t_allow_auth_exec(fn text);
insert into t_allow_auth_exec values ('current_brand_id'), ('current_app_role');
insert into t_allow_auth_exec values ('is_contactable');   -- Story 3.1: security invoker, inlinable predicate (D-4)
insert into t_allow_auth_exec values ('recipient_preview');   -- Story 4.1: secdef, brand-checked, raises not_in_brand / invalid_input
insert into t_allow_auth_exec values ('confirm_send');        -- Story 4.2: secdef, owner-only + brand-checked; the only write path into sends
insert into t_allow_auth_exec values ('create_share_link'), ('revoke_share_link'), ('get_shared_results');  -- Story 5.1 (0011_share.sql): owner RPCs + the public door

create temp table t_allow_secdef(fn text);
insert into t_allow_secdef values ('current_brand_id'), ('current_app_role');
insert into t_allow_secdef values ('recipient_preview');      -- Story 4.1 (internal.recipient_classification has no grant and lives in internal: in neither list)
insert into t_allow_secdef values ('confirm_send');           -- Story 4.2 (0007_confirm_send.sql)
insert into t_allow_secdef values ('create_share_link'), ('revoke_share_link'), ('get_shared_results');  -- Story 5.1 (0011_share.sql)

create temp table t_view_exceptions(relname text);     -- views without brand_id; each needs its own assertion

-- Column-level grants a role may hold (S4c/S4d). Empty until Story 5.1 adds the share_links
-- SELECT columns for anon, e.g. insert into t_column_grant_exceptions values ('anon', 'share_links', 'SELECT').
create temp table t_column_grant_exceptions(rolname text, relname text, privilege text);
-- Story 5.1 (S2): share_links has NO table-level SELECT for authenticated — only a column-level grant on the seven
-- non-hash columns so the security_invoker v_share_links can read them; token_hash / password_hash / `select *`
-- stay refused. anon holds nothing on it (get_shared_results is security definer).
insert into t_column_grant_exceptions values ('authenticated', 'share_links', 'SELECT');

-- readable after the role switch to authenticated (pgTAP grants its own temp tables the same way)
grant select on t_exposed_schemas, t_allow_anon_exec, t_allow_auth_exec, t_allow_secdef, t_view_exceptions, t_column_grant_exceptions to public;

-- ===== fixtures — later stories append rows for their tables =====
-- KILELE owner = user A, KAROO analyst = user B. Emails are fixture-<x>@tenancy.test, never a real
-- allow-list email (app_users PK is citext). auth.users rows must exist before app_users rows (FK).
create function pg_temp.fixtures() returns void language plpgsql as $$
declare
  ua uuid := '00000000-0000-4000-8000-00000000000a';
  ub uuid := '00000000-0000-4000-8000-00000000000b';
  ba uuid;
  bb uuid;
begin
  select id into ba from public.brands where code = 'KILELE';
  select id into bb from public.brands where code = 'KAROO';
  perform set_config('tenancy.brand_a', ba::text, true);
  perform set_config('tenancy.brand_b', bb::text, true);
  perform set_config('tenancy.user_a', ua::text, true);
  perform set_config('tenancy.user_b', ub::text, true);

  insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (ua, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-a@tenancy.test', '{}', '{}', now(), now()),
         (ub, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-b@tenancy.test', '{}', '{}', now(), now());

  insert into public.app_users (email, brand_id, role, auth_user_id)
  values ('fixture-a@tenancy.test', ba, 'owner', ua),
         ('fixture-b@tenancy.test', bb, 'analyst', ub);

  -- Story 2.1+: insert one row per brand into every new tenant table here
  -- Story 2.1: contacts / campaigns / events — one row per brand; the event links to that brand's own contact + campaign.
  insert into public.contacts (brand_id, external_id, full_name, email, signup_at)
  values (ba, 'CT-A1', 'Fixture Contact A', 'ct-a1@tenancy.test', now()),
         (bb, 'CT-B1', 'Fixture Contact B', 'ct-b1@tenancy.test', now());
  insert into public.campaigns (brand_id, external_id, name, channel, sent_at)
  values (ba, 'CMP-A1', 'Fixture Campaign A', 'email', now()),
         (bb, 'CMP-B1', 'Fixture Campaign B', 'email', now());
  insert into public.events (brand_id, source, event_id, type, contact_id, campaign_id, occurred_at)
  values (ba, 'seed', 'EV-A1', 'opened',
          (select id from public.contacts where brand_id = ba and external_id = 'CT-A1'),
          (select id from public.campaigns where brand_id = ba and external_id = 'CMP-A1'), now()),
         (bb, 'seed', 'EV-B1', 'opened',
          (select id from public.contacts where brand_id = bb and external_id = 'CT-B1'),
          (select id from public.campaigns where brand_id = bb and external_id = 'CMP-B1'), now());
  -- Story 2.3: import_runs / import_issues — one finished run + one warn issue per brand
  -- (v_import_issue_groups exposes brand_id, so brand_counts() covers it: own = 1 group, other = 0).
  insert into public.import_runs (id, brand_id, brand_code, source_file, entity, finished_at, summary)
  values ('00000000-0000-4000-8000-0000000000a1', ba, 'KILELE', 'fixture-a.csv', 'contacts', now(), '{"staged": 1}'),
         ('00000000-0000-4000-8000-0000000000b1', bb, 'KAROO', 'fixture-b.csv', 'contacts', now(), '{"staged": 1}');
  insert into public.import_issues (brand_id, run_id, source_file, row_no, severity, reason, detail)
  values (ba, '00000000-0000-4000-8000-0000000000a1', 'fixture-a.csv', 2, 'warn', 'consent_unknown', '{"value": "maybe"}'),
         (bb, '00000000-0000-4000-8000-0000000000b1', 'fixture-b.csv', 2, 'warn', 'consent_unknown', '{"value": "maybe"}');
  -- Story 3.1: metric_rules is shared (no brand_id; nine rows seeded by 0005_metrics.sql itself), so
  -- brand_counts() never enumerates it — B7/B8 do not apply; B10 below asserts the shared read instead.
  -- The four views (v_dashboard_totals, v_signups_30d, v_campaign_performance, v_contacts) expose brand_id
  -- and are fed by the contacts / campaigns / brands fixtures above: own > 0 (1 / 30 / 1 / 1), other = 0.
  -- Story 4.1: sends / send_recipients / provider_batches — one finished portal send per brand, one recipient
  -- (that brand's own contact) and one provider batch each. status 'complete' keeps the partial unique index
  -- (one active send per campaign) free for the per-RPC blocks of Stories 4.2+.
  perform set_config('tenancy.campaign_a', (select id from public.campaigns where brand_id = ba and external_id = 'CMP-A1')::text, true);
  perform set_config('tenancy.campaign_b', (select id from public.campaigns where brand_id = bb and external_id = 'CMP-B1')::text, true);
  insert into public.sends (id, brand_id, campaign_id, status, source, recipient_count, batch_id)
  values ('00000000-0000-4000-8000-0000000000a4', ba, current_setting('tenancy.campaign_a')::uuid, 'complete', 'portal', 1, 'FIX-BATCH-A'),
         ('00000000-0000-4000-8000-0000000000b4', bb, current_setting('tenancy.campaign_b')::uuid, 'complete', 'portal', 1, 'FIX-BATCH-B');
  insert into public.send_recipients (send_id, brand_id, contact_id, external_id, address)
  values ('00000000-0000-4000-8000-0000000000a4', ba, (select id from public.contacts where brand_id = ba and external_id = 'CT-A1'), 'CT-A1', 'ct-a1@tenancy.test'),
         ('00000000-0000-4000-8000-0000000000b4', bb, (select id from public.contacts where brand_id = bb and external_id = 'CT-B1'), 'CT-B1', 'ct-b1@tenancy.test');
  insert into public.provider_batches (send_id, brand_id, batch_id)
  values ('00000000-0000-4000-8000-0000000000a4', ba, 'FIX-BATCH-A'),
         ('00000000-0000-4000-8000-0000000000b4', bb, 'FIX-BATCH-B');
  -- Story 5.1: share_links — one active link per brand on that brand's own campaign (fixed ids for the per-RPC
  -- block). brand_counts() covers share_links through the granted brand_id column (count(*), never select *)
  -- and v_share_links through its brand_id. internal.share_attempts has no brand_id and lives outside public.
  insert into public.share_links (id, brand_id, campaign_id, token_hash, password_hash, created_by)
  values ('00000000-0000-4000-8000-0000000000a5', ba, current_setting('tenancy.campaign_a')::uuid,
          sha256(convert_to('fixture-token-a', 'UTF8')), extensions.crypt('fixture-pass-a', extensions.gen_salt('bf')), ua),
         ('00000000-0000-4000-8000-0000000000b5', bb, current_setting('tenancy.campaign_b')::uuid,
          sha256(convert_to('fixture-token-b', 'UTF8')), extensions.crypt('fixture-pass-b', extensions.gen_salt('bf')), ub);
end $$;

-- Supabase's documented RLS-test pattern: request.jwt.claims + role authenticated, transaction-local.
create function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Own / other row counts for every relation in the exposed schemas that has a brand_id column.
-- Never switches role itself: it counts as whoever calls it.
create function pg_temp.brand_counts() returns table(rel text, own bigint, other bigint) language plpgsql as $$
declare r record;
begin
  for r in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'brand_id' and not a.attisdropped
    where c.relkind in ('r', 'p', 'v', 'm')
      and n.nspname in (select nspname from t_exposed_schemas)
    order by 1, 2
  loop
    rel := r.nspname || '.' || r.relname;
    execute format('select count(*) from %I.%I where brand_id = %L', r.nspname, r.relname, current_setting('tenancy.brand_a')) into own;
    execute format('select count(*) from %I.%I where brand_id = %L', r.nspname, r.relname, current_setting('tenancy.brand_b')) into other;
    return next;
  end loop;
end $$;

-- Story 2.1 (S17): 0002_core_tables.sql revokes the PUBLIC execute default for every function postgres
-- creates — pg_temp helpers included — so the two helpers the authenticated block calls need an explicit grant.
grant execute on function pg_temp.brand_counts(), pg_temp.as_postgres() to public;

-- ============================================================================
-- Structural assertions — as postgres, before any role switch.
-- One TAP line per catalog row so a failure names the offending object.
-- ============================================================================

-- S1: every table has RLS enabled AND forced (forced binds the owner too).
select ok(c.relrowsecurity and c.relforcerowsecurity, format('S1 RLS enabled+forced: %I.%I', n.nspname, c.relname))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, c.relname;

-- S2: every table has >= 1 policy whose qual / with_check references current_brand_id or auth.uid.
-- pg_policies.qual is null for with-check-only policies, hence the coalesce concat.
select ok(
  exists (
    select 1 from pg_policies p
    where p.schemaname = n.nspname and p.tablename = c.relname
      and coalesce(p.qual, '') || coalesce(p.with_check, '') ~ '(current_brand_id|auth\.uid)'
  ),
  format('S2 policy references current_brand_id/auth.uid: %I.%I', n.nspname, c.relname))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, c.relname;

-- S3: every view runs with security_invoker (otherwise it reads the base tables as its owner, bypassing RLS).
select ok(
  exists (
    select 1 from pg_options_to_table(c.reloptions) o
    where o.option_name = 'security_invoker' and o.option_value in ('true', 'on', '1')
  ),
  format('S3 view security_invoker: %I.%I', n.nspname, c.relname))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'v'
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, c.relname;

-- S3b: every view exposes brand_id (so brand_counts() covers it) or is listed in t_view_exceptions
-- (and then owes its own assertion below the per-RPC negatives block).
select ok(
  exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'brand_id' and not a.attisdropped)
  or c.relname in (select relname from t_view_exceptions),
  format('S3b view has brand_id or is an exception: %I.%I', n.nspname, c.relname))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'v'
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, c.relname;

-- S4: anon holds no privilege at all on any table or view.
-- has_table_privilege with a comma list is true if ANY of the listed privileges is held.
select ok(
  not has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'),
  format('S4 anon has no table privilege: %I.%I', n.nspname, c.relname))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm')
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, c.relname;

-- S4b: authenticated never writes a table or view directly (writes go through RPCs).
-- TRUNCATE included: it ignores RLS, so a stray grant would let one tenant wipe every brand.
select ok(
  not has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE'),
  format('S4b authenticated has no write privilege: %I.%I', n.nspname, c.relname))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm')
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, c.relname;

-- S5: the functions anon may execute are exactly t_allow_anon_exec.
select set_eq(
  $$ select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prokind = 'f' and n.nspname in (select nspname from t_exposed_schemas)
       and has_function_privilege('anon', p.oid, 'execute') $$,
  $$ select fn from t_allow_anon_exec $$,
  'S5 anon executes exactly the allow-list');

-- S6: the functions authenticated may execute are exactly t_allow_auth_exec.
select set_eq(
  $$ select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prokind = 'f' and n.nspname in (select nspname from t_exposed_schemas)
       and has_function_privilege('authenticated', p.oid, 'execute') $$,
  $$ select fn from t_allow_auth_exec $$,
  'S6 authenticated executes exactly the allow-list');

-- S7: the security definer functions are exactly t_allow_secdef.
select set_eq(
  $$ select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prokind = 'f' and n.nspname in (select nspname from t_exposed_schemas)
       and p.prosecdef $$,
  $$ select fn from t_allow_secdef $$,
  'S7 security definer functions are exactly the allow-list');

-- S8: nothing is published to realtime (a subscription would stream rows around RLS-less channels).
select is(
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime'),
  0::bigint,
  'S8 supabase_realtime publication is empty');

-- S9: no storage buckets exist (no object paths to leak across brands).
select is((select count(*) from storage.buckets), 0::bigint, 'S9 storage.buckets is empty');

-- S10: guard — the enumeration actually saw the tenancy tables. A test that enumerates nothing passes vacuously.
select cmp_ok(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname in (select nspname from t_exposed_schemas)),
  '>=', 2::bigint,
  'S10 guard: at least two tables enumerated in the exposed schemas');

-- S11: internal / staging are not usable by anon or authenticated (they must never be exposed).
select ok(
  not has_schema_privilege(r.rolname, s.nspname, 'usage'),
  format('S11 %s has no usage on schema %s', r.rolname, s.nspname))
from (values ('anon'), ('authenticated')) r(rolname)
cross join (values ('internal'), ('staging')) s(nspname)
order by r.rolname, s.nspname;

-- ============================================================================
-- Behavioural block — as brand A's owner (user A). FR-32: brand B rows = 0 everywhere.
-- ============================================================================
select pg_temp.fixtures();
select pg_temp.as_user(current_setting('tenancy.user_a')::uuid);

select is(current_user::text, 'authenticated', 'B0 running as authenticated');
select is(public.current_brand_id(), current_setting('tenancy.brand_a')::uuid, 'B1 current_brand_id() is brand A');
select is(public.current_app_role(), 'owner'::public.app_role, 'B2 current_app_role() is owner');
select is((select count(*) from public.brands), 1::bigint, 'B3 brands shows exactly one row');
-- string_agg (not a scalar subquery) so a leak reports the extra codes instead of aborting the transaction.
select is((select string_agg(code, ',' order by code) from public.brands), 'KILELE', 'B4 the visible brand is KILELE');
select is((select count(*) from public.app_users), 1::bigint, 'B5 app_users shows exactly one row');
select is((select string_agg(auth_user_id::text, ',') from public.app_users), current_setting('tenancy.user_a'), 'B6 the visible app_users row is our own');

select cmp_ok(own, '>', 0::bigint, 'B7 own rows > 0: ' || rel) from pg_temp.brand_counts();
select is(other, 0::bigint, 'B8 other-brand rows = 0: ' || rel) from pg_temp.brand_counts();

-- per-RPC cross-brand negatives (Story 4.1+: throws_ok(…, 'not_in_brand'))
-- Each security-definer RPC added to t_allow_secdef gets a call here with brand B's ids, e.g.:
--   select throws_ok($$ select public.create_send('<brand-B campaign id>') $$, 'not_in_brand', 'create_send refuses brand B');

-- Story 3.1: shared tables (no brand_id, policy on auth.uid()) — readable by any signed-in user, exempt from B8.
select cmp_ok((select count(*) from public.metric_rules), '>', 0::bigint, 'B10 shared table readable when signed in: public.metric_rules');

-- Story 4.1: recipient_preview — brand A's campaign answers one reconciled row; brand B's campaign id (which
-- exists — the secdef function bypasses RLS, so only its own brand check stands between A and B) → not_in_brand.
select is((select count(*) from public.recipient_preview(current_setting('tenancy.campaign_a')::uuid)), 1::bigint, 'B11 recipient_preview answers one row for own campaign');
select is((select total_count + not_contactable + no_address + country_mismatch_or_unknown from public.recipient_preview(current_setting('tenancy.campaign_a')::uuid)),
          (select count(*) from public.contacts where deleted_at is null),
          'B11 recipient_preview counts reconcile to own non-deleted contacts');
select throws_ok(format($$ select * from public.recipient_preview(%L) $$, current_setting('tenancy.campaign_b')), 'P0001', 'not_in_brand', 'B12 recipient_preview refuses brand B''s campaign (not_in_brand)');

-- Story 4.2: confirm_send — as brand A's OWNER (the role check passes), brand B's real campaign id → not_in_brand,
-- and no send was written for it. The fixture send on campaign B is 'complete', so the partial unique index is
-- not what refuses here — the brand check is. (User B is an analyst: confirm_send would stop at not_owner.)
select throws_ok(format($$ select public.confirm_send(%L, 1) $$, current_setting('tenancy.campaign_b')), 'P0001', 'not_in_brand', 'B13 confirm_send refuses brand B''s campaign (not_in_brand)');
select throws_ok(format($$ select public.confirm_send(%L, null) $$, current_setting('tenancy.campaign_b')), 'P0001', 'not_in_brand', 'B13 confirm_send: the brand check precedes the count check');

select pg_temp.as_postgres();
select is((select count(*) from public.sends where campaign_id = current_setting('tenancy.campaign_b')::uuid), 1::bigint, 'B13 confirm_send wrote nothing for brand B''s campaign (only the complete fixture send)');

-- Story 5.1: create_share_link / revoke_share_link — as brand A's OWNER, brand B's real campaign id and brand B's
-- real link id (both exist — the secdef RPCs bypass RLS, so only their own brand checks stand) → not_in_brand;
-- brand B's link stays unrevoked. v_share_links is covered by B7/B8 (own 1, other 0); share_links itself through
-- its granted columns — `select *` is refused (column-level grant only, S2).
select pg_temp.as_user(current_setting('tenancy.user_a')::uuid);
select throws_ok(format($$ select public.create_share_link(%L, 'fixture-pass-x') $$, current_setting('tenancy.campaign_b')), 'P0001', 'not_in_brand', 'B14 create_share_link refuses brand B''s campaign (not_in_brand)');
select throws_ok($$ select public.revoke_share_link('00000000-0000-4000-8000-0000000000b5') $$, 'P0001', 'not_in_brand', 'B15 revoke_share_link refuses brand B''s link (not_in_brand)');
select throws_ok($$ select * from public.share_links $$, '42501', null, 'B16 select * from share_links is refused for authenticated (column-level grant only)');
select throws_ok($$ select token_hash from public.share_links $$, '42501', null, 'B16 token_hash is unreadable for authenticated');
select is((select string_agg(status, ',') from public.v_share_links), 'active', 'B16 v_share_links shows own link only, active');
select pg_temp.as_postgres();
select is((select count(*) from public.share_links where brand_id = current_setting('tenancy.brand_b')::uuid and revoked_at is null), 1::bigint, 'B15 brand B''s link is still active (nothing revoked across brands)');
select is((select count(*) from public.share_links where brand_id = current_setting('tenancy.brand_b')::uuid), 1::bigint, 'B14 no link was created on brand B''s campaign');
select is(current_user::text, 'postgres', 'B9 role restored to postgres before finish');

-- ============================================================================
-- Appended structural assertions (Story 1.3 review follow-ups) — as postgres again.
-- Appended after B9 so every earlier TAP number (quoted in the README mutation drill) is stable.
-- ============================================================================

-- S4c: anon holds no COLUMN-level privilege either (the four column privileges Postgres has:
-- SELECT, INSERT, UPDATE, REFERENCES). has_table_privilege only sees whole-table
-- grants, so `grant select (id, code) on public.brands to anon` slipped past S4. Story 5.1's
-- share_links SELECT columns are the only planned exception (t_column_grant_exceptions).
select ok(
  not has_any_column_privilege('anon', c.oid, pr.privilege)
  or exists (select 1 from t_column_grant_exceptions e
             where e.rolname = 'anon' and e.relname = c.relname and upper(e.privilege) = pr.privilege),
  format('S4c anon has no column privilege %s: %I.%I', pr.privilege, n.nspname, c.relname))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) pr(privilege) -- DELETE is table-level only
where c.relkind in ('r', 'p', 'v', 'm')
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, c.relname, pr.privilege;

-- S4d: authenticated holds no column-level write privilege (`grant update (role) on app_users`
-- would be self-promotion to owner through a PostgREST PATCH).
select ok(
  not has_any_column_privilege('authenticated', c.oid, pr.privilege)
  or exists (select 1 from t_column_grant_exceptions e
             where e.rolname = 'authenticated' and e.relname = c.relname and upper(e.privilege) = pr.privilege),
  format('S4d authenticated has no column write privilege %s: %I.%I', pr.privilege, n.nspname, c.relname))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join (values ('INSERT'), ('UPDATE')) pr(privilege) -- column privileges: DELETE is table-level (S4b)
where c.relkind in ('r', 'p', 'v', 'm')
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, c.relname, pr.privilege;

-- S4e (Story 5.1): a column-level SELECT grant to authenticated WITHOUT a table-level one is exactly the
-- t_column_grant_exceptions list (S4c covers anon; S4d covers authenticated writes; whole-table SELECTs are
-- the normal tenant grant). A stray `grant select (email) on contacts` would surface here.
select ok(
  not (has_any_column_privilege('authenticated', c.oid, 'SELECT') and not has_table_privilege('authenticated', c.oid, 'SELECT'))
  or exists (select 1 from t_column_grant_exceptions e
             where e.rolname = 'authenticated' and e.relname = c.relname and upper(e.privilege) = 'SELECT'),
  format('S4e authenticated column-only SELECT is an exception: %I.%I', n.nspname, c.relname))
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm')
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, c.relname;

-- S7b: every security definer function pins search_path (S7 only checks WHICH functions are
-- secdef; dropping `set search_path = ''` is an isolation-weakening edit it would not notice).
select ok(
  exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%'),
  format('S7b security definer function pins search_path: %I.%s', n.nspname, p.oid::regprocedure))
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef
  and n.nspname in (select nspname from t_exposed_schemas)
order by n.nspname, p.oid::regprocedure::text;

select * from finish();
rollback;
