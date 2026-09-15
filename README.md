# Client Campaign Portal

A multi-tenant campaign portal for three brands (Kilele Rides, Karoo Coaches, Marrakech Express) built for the Velocity Growth Growth-Engineer build task. Each brand's marketing team signs in, sees only its own contacts, campaigns and dashboard, sends a campaign through the messaging provider, watches delivery reports come back, and can publish one campaign's results behind a password-protected link.

**Live:** https://vg-campaign-portal.vercel.app

## Stack

- **Next.js 16.3** (App Router, `proxy.ts` for session refresh) on **Vercel**
- **Supabase**: Postgres 17 with row-level security, Auth (email + password, Google), Cron (pg_cron + pg_net), Edge Functions
- **Tailwind CSS + shadcn/ui**
- **Vitest** (app-level tests) + **pgTAP** via `supabase test db` (database-level tests)
- Node 22 (`.nvmrc`), pnpm, Supabase CLI ≥ 2.117 (`brew install supabase/tap/supabase`), Docker (for the local stack)

The deployed app uses only the publishable key; the service-role key and the provider key never reach Vercel or the browser.

## Local development

```bash
nvm use                      # Node 22
pnpm install
cp .env.example .env.local   # fill NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
supabase start               # local Postgres/Auth/Functions in Docker
pnpm dev                     # http://localhost:3000
```

| Command | What it does |
|---|---|
| `pnpm test` | Vitest (`tests/**/*.test.ts`) against the local stack |
| `pnpm test:db` | pgTAP suites in `supabase/tests/` |
| `pnpm seed` | Loads the seed data (see *Seed load counts*) |
| `pnpm schema:dump` | Regenerates `schema.sql` from `supabase/migrations/*.sql` |
| `pnpm gen:types` | Regenerates `lib/database.types.ts` from the local database |
| `supabase db push` | Applies migrations to the hosted project |

`schema.sql` at the repo root is the reproducible database definition: it is the concatenation of every migration, in order.

## Manual Auth settings

Sign-in is an allow-list (architecture D-9): the seven logins exist before anyone signs in, sign-ups are off, and Google can only ever attach to one of the pre-created, already-confirmed emails. Nothing in the app creates users.

### The seven logins

`supabase/seed.sql` inserts the `app_users` rows (`auth_user_id` null) with `on conflict (email) do nothing`, so it is safe to re-run and never resets a linked row:

| email | brand | role |
|---|---|---|
| `kilele.owner@vg-eval.test` | KILELE | owner |
| `kilele.analyst@vg-eval.test` | KILELE | analyst |
| `karoo.owner@vg-eval.test` | KAROO | owner |
| `karoo.analyst@vg-eval.test` | KAROO | analyst |
| `marrakech.owner@vg-eval.test` | MARRAKECH | owner |
| `marrakech.analyst@vg-eval.test` | MARRAKECH | analyst |
| `joegmes@gmail.com` (Google demo) | KILELE | owner |

`pnpm seed` (`scripts/seed/users.ts`) then, for every `app_users` row: lowercases the email, looks the auth user up (`listUsers` match — `getUserByEmail` is not in supabase-js 2.116), creates it with `auth.admin.createUser({ email, password, email_confirm: true })` and a 32-char random password if absent, and writes `app_users.auth_user_id`. Existing users are skipped, never recreated or password-reset. Passwords go only to the git-ignored `credentials.txt` (`email<TAB>password<TAB>brand<TAB>role`, mode 0600; lines for pre-existing users are preserved). The console shows only `created` / `exists` / `linked` — never a password or key. Running it twice is a no-op.

```bash
# LOCAL — seed.sql runs on `supabase db reset`; the local service key comes from `supabase status`
eval "$(supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" pnpm seed

# HOSTED — `supabase db push` never runs seed.sql, so apply it once through the Management API
# (one statement per call; comments stripped), then provision with the project's sb_secret_ key.
supabase db query --linked "$(grep -v '^--' supabase/seed.sql | tr '\n' ' ' | sed 's/;[[:space:]]*$//')"
NEXT_PUBLIC_SUPABASE_URL=https://qaocabdpaxetofqcfgsa.supabase.co \
SUPABASE_SERVICE_ROLE_KEY="$(supabase projects api-keys --project-ref qaocabdpaxetofqcfgsa --reveal -o json | jq -r '.[] | select(.type=="secret") | .api_key')" \
pnpm seed
```

Shell variables take precedence over `.env.local` (dotenv never overrides), so the same `.env.local` serves the app and both seed targets; always check which `NEXT_PUBLIC_SUPABASE_URL` is in effect before running `pnpm seed`. Whichever target ran last wrote its passwords to `credentials.txt` — keep the hosted copy for the submission email.

### Hosted project (Dashboard → Authentication)

| Setting | Value | Status |
|---|---|---|
| Sign In / Providers → "Allow new users to sign up" | **OFF** | applied via `supabase config push` (`auth.enable_signup = false`) |
| Providers → Email | **ON** (confirmations stay on; unused — users are created confirmed) | already on |
| URL Configuration → Site URL | `https://vg-campaign-portal.vercel.app` | applied via `supabase config push` |
| URL Configuration → Redirect URLs | `https://vg-campaign-portal.vercel.app/**`, `http://localhost:3000/**` | applied via `supabase config push` |
| Providers → Google | **ON**, Client ID + Client Secret from Google Cloud (below) | **manual — pending** |

The three pushed values were applied from a minimal `config.toml` that declared only them; `supabase config push` leaves undeclared properties untouched, but always run `supabase config diff --project-ref qaocabdpaxetofqcfgsa` first — the full local `supabase/config.toml` also declares local-only defaults (OTP length, MFA, pooler sizes, storage) that must not be pushed.

Google, step by step (cannot be scripted — needs the Google Cloud Console UI):

1. Google Cloud Console → APIs & Services → OAuth consent screen: External, add the app name and support email, publish it (testing mode would limit sign-in to listed test users).
2. Credentials → Create credentials → OAuth client ID → Web application. Authorised redirect URI: `https://qaocabdpaxetofqcfgsa.supabase.co/auth/v1/callback` (add `http://127.0.0.1:54321/auth/v1/callback` too if you want Google on the local stack).
3. Supabase Dashboard → Authentication → Sign In / Providers → Google: enable, paste the Client ID and Client Secret, save. The secret stays in the dashboard — never in the repo or Vercel.
4. Check: signing in with Google as `joegmes@gmail.com` lands in KILELE; any other Google account is refused (sign-ups OFF). Google links to the pre-created user only because it was created with `email_confirm: true`.

### Local equivalents (`supabase/config.toml`)

| Hosted setting | `config.toml` |
|---|---|
| Allow new users to sign up = OFF | `[auth] enable_signup = false` |
| Email provider ON | `[auth.email] enable_signup = true` |
| Site URL | `[auth] site_url = "http://localhost:3000"` |
| Redirect URLs | `[auth] additional_redirect_urls = ["http://localhost:3000/**"]` |
| Google provider | `[auth.external.google]` — `enabled = false` by default; `client_id = "env(GOOGLE_CLIENT_ID)"`, `secret = "env(GOOGLE_CLIENT_SECRET)"` read from the git-ignored `supabase/.env`; set `enabled = true` once both are there (`skip_nonce_check = true` is required for local Google) |

`config.toml` changes take effect on the next `supabase start` / `supabase db reset`.

## Exposed schemas

The Data API (PostgREST) exposes only `public` and `graphql_public` — `supabase/config.toml` `[api] schemas = ["public", "graphql_public"]` locally, and the same list under Project Settings → Data API → Exposed schemas on the hosted project.

`internal` (plpgsql helpers) and `staging` (raw seed rows) are created by `supabase/migrations/0000_grants.sql` with no `usage` for `public`, `anon` or `authenticated`. **They must never be added to the hosted Data API exposed schemas.** Nothing is ever created in `graphql_public`.

`0000_grants.sql` also revokes Supabase's default privileges in `public`: new functions carry no `execute` for `public`/`anon`/`authenticated`, new tables and sequences carry nothing for `anon`/`authenticated`. Every grant is therefore explicit and visible in `schema.sql`.

## What we tried to break

_Grows with every attack test that lands._

- **anon reads `brands`** — `set role anon; select * from public.brands;` → `ERROR: permission denied for table brands`. The role holds no privilege on the table (RLS is not what stops it — there is nothing to filter); `0000_grants.sql` revoked the default table grant before the table existed and `0001_tenancy.sql` grants `select` to `authenticated` only.
- **anon calls the isolation primitive** — `set role anon; select public.current_brand_id();` → `ERROR: permission denied for function current_brand_id`. Default `execute` for `public`/`anon`/`authenticated` was revoked in `0000_grants.sql`; `0001_tenancy.sql` re-revokes explicitly and grants `execute` to `authenticated` only (same for `current_app_role()`, and `app_users` behaves like `brands`).
- **authenticated without a linked `app_users` row** — `set role authenticated; select count(*) from public.brands;` → `0`. Allowed, but `auth.uid()` is null, `current_brand_id()` returns null, and the forced-RLS policy `id = (select current_brand_id())` matches nothing. Zero rows, never a default brand.
- **RLS switched off on `brands`** — `alter table public.brands disable row level security;` then `pnpm test:db` → `not ok 2 - S1 RLS enabled+forced: public.brands`, and the behavioural block leaks: `not ok 22 - B3 brands shows exactly one row (have: 3, want: 1)`, `not ok 23 - B4 the visible brand is KILELE (have: KAROO,KILELE,MARRAKECH)`. Caught by `supabase/tests/0001_tenancy.test.sql`, which enumerates every table in `public` from the catalog — a new table with no RLS fails the same line.
- **Policy rewritten to `using (true)`** — `drop policy brands_select_own_brand on public.brands; create policy brands_select_own_brand on public.brands for select to authenticated using (true);` → `not ok 3 - S2 policy references current_brand_id/auth.uid: public.brands` plus the same B3/B4 leak (three brands visible as brand A's owner). A dropped policy fails S2 identically.
- **`grant select on public.brands to anon`** → `not ok 6 - S4 anon has no table privilege: public.brands`. The structural block runs as `postgres` before any role switch, so a grant is caught even though anon never queries anything in the test.
- **A new `public` function with no explicit `revoke`** — `create function public.f_probe() returns int language sql security definer as $$ select 1 $$;` → `not ok 9 - S5 anon executes exactly the allow-list (Extra records: f_probe)`, same for S6 (`authenticated`) and `not ok 11 - S7 security definer functions are exactly the allow-list`. Finding: Postgres grants `execute` to `PUBLIC` on every new function, and a per-schema `alter default privileges … revoke` (what `0000_grants.sql` does) cannot subtract from that global default — so every function needs its own `revoke execute … from public, anon` (Story 1.2's helpers have it). The allow-list `set_eq` assertions are what make forgetting it fail the build.

## Seed load counts

_Filled in after the seed load._

## Table / function inventory

_Filled in as migrations land._

## Repo layout

```
app/                Next.js routes (portal, public share page, auth)
components/         UI components (shadcn primitives under components/ui)
lib/supabase/       browser / server / proxy clients
supabase/migrations   schema, policies, functions — the source of truth
supabase/tests        pgTAP suites (isolation, sends, events, share)
supabase/functions    Edge Functions (dispatch-send, poll-events)
scripts/seed        one-time seed loader (local machine only)
tests/              Vitest integration tests
docs/               the brief, provider API notes, synthetic seed data
```
