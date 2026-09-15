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
| `pnpm test` | Vitest (`tests/**/*.test.ts`) against the local stack — `tests/isolation.test.ts` needs `.env.test` (below) |
| `pnpm test:db` | pgTAP suites in `supabase/tests/` |
| `pnpm seed` | Loads the seed data (see *Seed load counts*): `--only=users\|stage\|all` (default `all`), `--sample=N`, `--file=<basename>`; the stage step needs `DATABASE_URL` |
| `pnpm schema:dump` | Regenerates `schema.sql` from `supabase/migrations/*.sql` |
| `pnpm gen:types` | Regenerates `lib/database.types.ts` from the local database |
| `supabase db push` | Applies migrations to the hosted project |

`schema.sql` at the repo root is the reproducible database definition: it is the concatenation of every migration, in order.

`tests/isolation.test.ts` signs in as the KILELE analyst through PostgREST and asserts it sees only KILELE rows in every exposed table. It reads the git-ignored `.env.test`: `TEST_KILELE_ANALYST_EMAIL` / `TEST_KILELE_ANALYST_PASSWORD` (a **local-stack** password — `credentials.txt` holds whichever target `pnpm seed` ran last, so set a local one with the Admin API if needed) and, when `.env.local` points at the hosted project, `TEST_SUPABASE_URL` / `TEST_SUPABASE_PUBLISHABLE_KEY` for the local stack. Without `.env.test` the suite skips with a warning.

## Sign-in

`/login` offers email + password and "Continue with Google"; both are server actions (`app/(public)/login/actions.ts`). `proxy.ts` refreshes the Supabase session on every matched request and sends anonymous requests to `/login`; its matcher excludes `/share`, `/api/health`, `/login`, `/auth` and Next internals (`tests/proxy-matcher.test.ts`). `app/(portal)/layout.tsx` loads the caller's `app_users` row once per render (`lib/current-user.ts` — `role` is the single source for hiding owner controls) and signs out any session that has no row via `/auth/signout?reason=no_access`. The Google round-trip returns to `/auth/callback`: a refused account (sign-ups OFF) arrives as `?error=…` and lands on `/login?reason=not_allowed`; a pre-created one arrives as `?code=…` and lands on `/dashboard`.

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

`0000_grants.sql` also runs `alter default privileges in schema public revoke …` for functions, tables and sequences. What that actually does: it strips Supabase's own per-schema default grants to `anon`/`authenticated` (verified in `pg_default_acl`) — nothing more. Postgres's built-in default (`execute` to `PUBLIC` on every new function) is global and a per-schema revoke cannot subtract from it, so that line never protected functions (Story-Time Amendment S17, found by the 1.3 probe below). The real control is therefore explicit: every function carries its own `revoke execute … from public, anon, authenticated` + `grant execute … to authenticated` (or nothing), and the tenancy suite's S5/S6 `set_eq` allow-lists fail the build if one is missing. The schema-less `alter default privileges for role postgres revoke execute on functions from public` that fixes the default itself landed in `0002_core_tables.sql` (Story 2.1). Every grant is explicit and visible in `schema.sql`.

## What we tried to break

_Grows with every attack test that lands._

- **anon reads `brands`** — `set role anon; select * from public.brands;` → `ERROR: permission denied for table brands`. The role holds no privilege on the table (RLS is not what stops it — there is nothing to filter); `0000_grants.sql` revoked the default table grant before the table existed and `0001_tenancy.sql` grants `select` to `authenticated` only.
- **anon calls the isolation primitive** — `set role anon; select public.current_brand_id();` → `ERROR: permission denied for function current_brand_id`. Not because of `0000_grants.sql` (its per-schema function-default revoke is a no-op against the built-in `PUBLIC` execute default — see "Exposed schemas" and the `f_probe` entry below): `0001_tenancy.sql` revokes `execute` from `public`/`anon` on each helper explicitly and grants it to `authenticated` only, and the tenancy suite's S5/S6 keep it that way (same for `current_app_role()`, and `app_users` behaves like `brands`). Since `0002_core_tables.sql` the default itself is also revoked (schema-less `for role postgres`).
- **authenticated without a linked `app_users` row** — `set role authenticated; select count(*) from public.brands;` → `0`. Allowed, but `auth.uid()` is null, `current_brand_id()` returns null, and the forced-RLS policy `id = (select current_brand_id())` matches nothing. Zero rows, never a default brand.
- **RLS switched off on `brands`** — `alter table public.brands disable row level security;` then `pnpm test:db` → `not ok 2 - S1 RLS enabled+forced: public.brands`, and the behavioural block leaks: `not ok 22 - B3 brands shows exactly one row (have: 3, want: 1)`, `not ok 23 - B4 the visible brand is KILELE (have: KAROO,KILELE,MARRAKECH)`. Caught by `supabase/tests/0001_tenancy.test.sql`, which enumerates every table in `public` from the catalog — a new table with no RLS fails the same line.
- **Policy rewritten to `using (true)`** — `drop policy brands_select_own_brand on public.brands; create policy brands_select_own_brand on public.brands for select to authenticated using (true);` → `not ok 3 - S2 policy references current_brand_id/auth.uid: public.brands` plus the same B3/B4 leak (three brands visible as brand A's owner). A dropped policy fails S2 identically.
- **`grant select on public.brands to anon`** → `not ok 6 - S4 anon has no table privilege: public.brands`. The structural block runs as `postgres` before any role switch, so a grant is caught even though anon never queries anything in the test.
- **A new `public` function with no explicit `revoke`** — `create function public.f_probe() returns int language sql security definer as $$ select 1 $$;` → `not ok 9 - S5 anon executes exactly the allow-list (Extra records: f_probe)`, same for S6 (`authenticated`) and `not ok 11 - S7 security definer functions are exactly the allow-list`. Finding: Postgres grants `execute` to `PUBLIC` on every new function, and a per-schema `alter default privileges … revoke` (what `0000_grants.sql` does) cannot subtract from that global default — so every function needs its own `revoke execute … from public, anon` (Story 1.2's helpers have it). The allow-list `set_eq` assertions are what make forgetting it fail the build.
- **Column-level grants, `truncate`, and an unpinned `search_path`** (1.3 review follow-ups) — `grant select (id, code) on public.brands to anon` passed the whole-table S4 check; now `not ok 53 - S4c anon has no column privilege SELECT: public.brands`. `grant update (role) on public.app_users to authenticated` (self-promotion to owner via a PostgREST PATCH) → `not ok 68 - S4d authenticated has no column write privilege UPDATE: public.app_users`. `grant truncate on public.brands to authenticated` (`truncate` ignores RLS) → `not ok 17 - S4b …`. `alter function public.current_brand_id() reset search_path` → `not ok 78 - S7b security definer function pins search_path: public.current_brand_id()`. S4c/S4d/S7b are appended after B9 so the numbers above stay stable; Story 5.1's `share_links` SELECT columns go into `t_column_grant_exceptions`.

- **Six password logins, one wrong password** — each `*.owner@` / `*.analyst@vg-eval.test` login lands on `/dashboard` with its own brand name (Kilele Rides / Karoo Coaches / Marrakech Express) and an `Owner` / `Analyst` badge; a wrong password and an unknown email both re-render `/login` with the same inline "Email or password is incorrect." (the allow-list is not probeable through the form). Emails are trimmed and lowercased before `signInWithPassword`, so `  KILELE.OWNER@VG-EVAL.TEST  ` signs in.
- **Signed-out `/dashboard`, `/`, `/campaigns/1`** → `307 /login`; **`/share/x` and `/api/health` signed out** → not redirected (404 until Epics 5/7 add them), and `/login`, `/auth/*`, `/_next/*` never bounce — the matcher regex is pinned by `tests/proxy-matcher.test.ts`. `/` with a session → `307 /dashboard`.
- **Valid session, no `app_users` row** (local only: `delete from app_users where email = 'marrakech.analyst@vg-eval.test'`, sign in) → `/dashboard` → `307 /auth/signout?reason=no_access` → `303 /login?reason=no_access` ("Your account has no brand access. Contact Velocity Growth."), session cookie cleared (`Max-Age=0`). Row restored afterwards; 7 linked rows.
- **Google refusal path** — `/auth/callback?error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed…` (what Auth sends for an unlisted Google account with sign-ups OFF) → `307 /login?reason=not_allowed` ("This Google account is not on the allow-list for this portal."), no session created; any other `error_code` → `reason=oauth_failed`; a bare `/auth/callback` → `/login`. With the Google provider still OFF, the button reaches Supabase's `/authorize`, which answers `400 validation_failed` — the live `joegmes@gmail.com` → KILELE Owner check waits on the Google Cloud OAuth client (Manual Auth settings).
- **`tests/isolation.test.ts` with RLS disabled on `brands`** (`alter table public.brands disable row level security`) → `brands: exactly the analyst's own brand` fails with `expected [ 'KILELE', 'KAROO', 'MARRAKECH' ] to deeply equal [ 'KILELE' ]`; re-enabled → 6/6 pass. Anonymous PostgREST selects on every table return `42501` (permission denied), not empty arrays.

## Seed load counts

`pnpm seed --only=stage` reads the eleven files in `docs/data/` through the per-file dialects in `scripts/seed/dialects.ts` (delimiter, encoding, header map, decimal-comma columns, hard-coded `as_of` / `file_rank`) and COPYs them into `staging.stage_*` over `DATABASE_URL` — the Supavisor **session** pooler (port 5432) for the hosted project, `postgresql://postgres:postgres@127.0.0.1:54322/postgres` against `supabase start`. TypeScript only *parses* (BOM, NUL bytes, RFC-4180 quoting, trim, reorder into canonical column order, `221,09` → `221.09`); every keep/reject rule is SQL (Stories 2.3/2.4). One staging row per CSV **record** (a quoted `notes` spanning two lines is one row, `row_no` = its first line), blank lines skipped, ragged records kept with their `ncols`, NULs stripped and flagged `had_nul`, the repeated header at Kilele line 40007 staged as an ordinary record. Re-staging a file deletes that file's rows first (never `truncate`), with a fresh `run_id` per file.

### Smoke (`pnpm seed --only=stage --sample=10`)

Run 2026-09-15 against the **local** stack (`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`). **Hosted COPY smoke pending: needs DB password** — the linked session-pooler URL is `postgresql://postgres.qaocabdpaxetofqcfgsa@aws-1-eu-west-1.pooler.supabase.com:5432/postgres`; put it (with the password) in `.env.local` as `DATABASE_URL` and re-run the same command; the table below is what it prints (files with fewer than 10 records stage all of them).

```
table            source_file                           count  min_ncols  max_ncols  had_nul
---------------  ------------------------------------  -----  ---------  ---------  -------
stage_contacts   karoo-contacts.csv                       10         13         13        0
stage_contacts   kilele-contacts-delta-2026-09-01.csv     10         13         13        0
stage_contacts   kilele-contacts.csv                      10         13         13        0
stage_contacts   marrakech-contacts.csv                   10         13         13        0
stage_campaigns  karoo-campaigns.csv                      10         13         13        0
stage_campaigns  kilele-campaigns.csv                     10         13         13        0
stage_campaigns  marrakech-campaigns.csv                   6         13         13        0
stage_events     karoo-events.csv                         10          6          6        0
stage_events     kilele-events.csv                        10          6          6        0
stage_events     marrakech-events.csv                     10          6          6        0
stage_send_log   kilele-send-log.csv                       9          5          5        0
```

### Full staging (local, 2026-09-15)

`pnpm seed --only=stage` — 489,192 rows in ~5 s. Parse summary and verification query as printed:

```
file                                  records  staged  blank_lines  ragged  had_nul  multi_line
------------------------------------  -------  ------  -----------  ------  -------  ----------
kilele-contacts.csv                     83993   83993            7      70        3          12
kilele-contacts-delta-2026-09-01.csv     4180    4180            0       0        0           0
karoo-contacts.csv                      13042   13042            8      46        0           0
marrakech-contacts.csv                    957     957            3      15        0           0
kilele-campaigns.csv                       46      46            0       0        0           0
karoo-campaigns.csv                        19      19            0       0        0           0
marrakech-campaigns.csv                     6       6            0       0        0           0
kilele-events.csv                      312000  312000            0       0        0           0
karoo-events.csv                        74000   74000            0       0        0           0
marrakech-events.csv                      940     940            0       0        0           0
kilele-send-log.csv                         9       9            0       0        0           0

table            source_file                           count   min_ncols  max_ncols  had_nul
---------------  ------------------------------------  ------  ---------  ---------  -------
stage_contacts   karoo-contacts.csv                     13042          7         13        0
stage_contacts   kilele-contacts-delta-2026-09-01.csv    4180         13         13        0
stage_contacts   kilele-contacts.csv                    83993          7         13        3
stage_contacts   marrakech-contacts.csv                   957          7         13        0
stage_campaigns  karoo-campaigns.csv                       19         13         13        0
stage_campaigns  kilele-campaigns.csv                      46         13         13        0
stage_campaigns  marrakech-campaigns.csv                    6         13         13        0
stage_events     karoo-events.csv                       74000          6          6        0
stage_events     kilele-events.csv                     312000          6          6        0
stage_events     marrakech-events.csv                     940          6          6        0
stage_send_log   kilele-send-log.csv                        9          5          5        0
```

Spot checks on `stage_contacts` (`kilele-contacts.csv`): `where had_nul` → `row_no` 5495, 23776, 61367 and no `\0` survives in any cell; `where cols[1] = 'external_id'` → 40007; `ncols` histogram 13: 83,923 / 9: 51 / 7: 19; `cols[13] where row_no = 750` = `VIP customer⏎follow up next quarter`; `=IMPORTXML(1,1)` staged verbatim. `karoo-contacts.csv`: `Ann–Marie Botha` decoded from windows-1252 `0x96`, 13-column rows in canonical order, ragged rows in raw order. `marrakech-campaigns.csv` `spend` `221,09` → `221.09`; the delta file carries `as_of 2026-09-01 / file_rank 20`, everything else `2026-08-01 / 10`. Re-staging `marrakech-contacts.csv` alone left the other files' rows untouched and replaced its 957 rows under a new `run_id`. The import counts (kept / rejected / warned) land here with Story 2.4.

## Table / function inventory

_Grows as migrations land. Every `public` table: RLS enabled + forced, one `select` policy `brand_id = (select current_brand_id())` (or the row's own `auth.uid()`), `SELECT` to `authenticated` only, nothing to `anon`; writes only through RPCs / service role._

| Object | Migration | Purpose / key |
|---|---|---|
| `public.brands`, `public.app_users`, `current_brand_id()`, `current_app_role()` | `0001_tenancy.sql` | tenancy primitives (Story 1.2) |
| `public.contacts` | `0002_core_tables.sql` | normalised contacts; natural key `(brand_id, external_id)`; `status`/`consent_marketing`/`country`/`signup_at` nullable (unknown = `null`); `suppressed_at`/`suppressed_reason` set by Story 6.2's trigger; `deleted_at`/`suppressed_until` explicit; indexes `(brand_id, signup_at)`, `(brand_id, email text_pattern_ops)`, trigram on `full_name` |
| `public.campaigns` | `0002_core_tables.sql` | seed campaigns + `reported_*` counts; natural key `(brand_id, external_id)`; `parent_external_id` raw pointer + `parent_campaign_id` self-FK; index `(brand_id, sent_at desc)` |
| `public.events` | `0002_core_tables.sql` | seed + provider events in one vocabulary (`event_type` enum, `event_source` = `seed`/`provider`); natural key `(brand_id, source, event_id)`; `contact_id`/`campaign_id`/`send_id` nullable; indexes `(brand_id, contact_id, type)`, `(brand_id, campaign_id, type)` |
| `public.normalize_event_type(text)` | `0002_core_tables.sql` | `bounce/open/click/unsubscribe/complaint` (and canonical spellings) → enum, case-insensitive after `btrim`, anything else (incl. `null`) → `unknown`; executable by no exposed role |
| `staging.stage_contacts`, `stage_campaigns`, `stage_events`, `stage_send_log` | `0002_core_tables.sql` | raw CSV records (`cols text[]`, `ncols`, `source_file`, `file_brand`, `row_no`, `had_nul`, `as_of`, `file_rank`, `run_id`) in the unexposed `staging` schema — no policy, no grant |

`0002_core_tables.sql` also opens with the schema-less `alter default privileges for role postgres revoke execute on functions from public` (Story-Time Amendment S17): a bare `create function public.f_probe()` now yields `has_function_privilege('anon', …) = false` — the per-schema line in `0000_grants.sql` could not subtract Postgres's built-in `PUBLIC` execute default. `supabase/tests/0002_core_tables.test.sql` re-runs that probe on every `pnpm test:db`.

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
