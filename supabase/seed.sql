-- Seed: the allow-list of logins (Story 1.4, architecture D-1 / D-9).
-- Runs on local `supabase db reset`; applied ONCE to the hosted project by hand
-- (`supabase db push` never runs this file). Auth users are NOT created here —
-- `pnpm seed` (scripts/seed/users.ts) creates them through the Admin API and
-- fills `auth_user_id`. `on conflict (email) do nothing` (never `do update`)
-- keeps re-runs as no-ops and never resets an existing `auth_user_id`.
insert into public.app_users (email, brand_id, role)
select v.email, b.id, v.role::public.app_role
from (values
  ('kilele.owner@vg-eval.test',     'KILELE',    'owner'),
  ('kilele.analyst@vg-eval.test',   'KILELE',    'analyst'),
  ('karoo.owner@vg-eval.test',      'KAROO',     'owner'),
  ('karoo.analyst@vg-eval.test',    'KAROO',     'analyst'),
  ('marrakech.owner@vg-eval.test',  'MARRAKECH', 'owner'),
  ('marrakech.analyst@vg-eval.test','MARRAKECH', 'analyst'),
  ('joegmes@gmail.com',             'KILELE',    'owner')
) as v(email, code, role)
join public.brands b on b.code = v.code
on conflict (email) do nothing;
