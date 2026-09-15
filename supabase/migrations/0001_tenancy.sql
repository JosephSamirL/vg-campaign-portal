-- 0001_tenancy.sql — tenancy primitives (architecture D-1, amendments #5, #10).
-- brands + app_users exist before any auth user; current_brand_id()/current_app_role()
-- are THE isolation primitive every later policy calls as (select …).
create extension if not exists citext with schema extensions;

create type public.app_role as enum ('owner', 'analyst');

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null
);

-- Brand rows live here, not in seed.sql: seed.sql runs only on local `db reset`, never on `db push`.
insert into public.brands (code, name) values
  ('KILELE', 'Kilele Rides'),
  ('KAROO', 'Karoo Coaches'),
  ('MARRAKECH', 'Marrakech Express')
on conflict (code) do nothing;

-- Email-keyed allow-list; auth_user_id is linked later (Story 1.4 script), never by a trigger on auth.users.
create table public.app_users (
  email extensions.citext primary key,
  brand_id uuid not null references public.brands(id),
  role public.app_role not null,
  auth_user_id uuid unique references auth.users(id)
);

-- No JWT → auth.uid() null → both helpers return null → policies match nothing. Never coalesce to a default brand.
create or replace function public.current_brand_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select brand_id from public.app_users where auth_user_id = auth.uid();
$$;

-- named current_app_role because current_role is reserved
create or replace function public.current_app_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select role from public.app_users where auth_user_id = auth.uid();
$$;

-- Explicit allow-list even though 0000_grants.sql revoked the defaults: schema.sql readers must see it.
revoke execute on function public.current_brand_id(), public.current_app_role() from public, anon;
grant execute on function public.current_brand_id(), public.current_app_role() to authenticated;

alter table public.brands enable row level security;
alter table public.brands force row level security;
alter table public.app_users enable row level security;
alter table public.app_users force row level security;

-- select-only; no write policies. (select …) wraps the helper so it runs once per query (initplan).
create policy brands_select_own_brand on public.brands
  for select to authenticated using (id = (select public.current_brand_id()));
create policy app_users_select_self on public.app_users
  for select to authenticated using (auth_user_id = (select auth.uid()));

grant select on public.brands, public.app_users to authenticated;
