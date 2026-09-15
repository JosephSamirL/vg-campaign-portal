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
| `pnpm seed` | Loads the seed data in one command (see *Seed load counts*): users → stage all eleven files → import contacts ×4 → campaigns ×3 → events ×3, one `import_runs` row per file, one summary line per file, exit code 1 if any importer raises. Flags: `--only=users\|stage\|import\|all` (default `all`), `--sample=N`, `--file=<basename>`, `--entity=contacts\|campaigns\|events` (import step; `send_log` arrives with Story 4.5); the stage and import steps need `DATABASE_URL` |
| `pnpm schema:dump` | Regenerates `schema.sql` from `supabase/migrations/*.sql` |
| `pnpm gen:types` | Regenerates `lib/database.types.ts` from the local database |
| `supabase db push` | Applies migrations to the hosted project |

`schema.sql` at the repo root is the reproducible database definition: it is the concatenation of every migration, in order.

`tests/isolation.test.ts` signs in as the KILELE analyst through PostgREST and asserts it sees only KILELE rows in every exposed table. It reads the git-ignored `.env.test`: `TEST_KILELE_ANALYST_EMAIL` / `TEST_KILELE_ANALYST_PASSWORD` (a **local-stack** password — from `credentials.127.0.0.1-54321.txt`, or set one with the Admin API) and `TEST_SUPABASE_URL` / `TEST_SUPABASE_PUBLISHABLE_KEY` for the local stack (`http://127.0.0.1:54321`; placeholders in `.env.example`). It never falls back to `.env.local`. Without `.env.test` the suite skips with a loud console message and a `todo`; under `CI` it fails instead; a non-local `TEST_SUPABASE_URL` is refused unless `ALLOW_HOSTED_TESTS=1`.

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

`pnpm seed` (`scripts/seed/users.ts`) then, for every `app_users` row: lowercases the email, looks the auth user up (`listUsers` match — `getUserByEmail` is not in supabase-js 2.116), creates it with `auth.admin.createUser({ email, password, email_confirm: true })` and a 32-char random password if absent, and writes `app_users.auth_user_id`. Existing users are skipped, never recreated or password-reset. Passwords go only to the git-ignored per-target `credentials.<host>.txt` (`credentials.127.0.0.1-54321.txt` for the local stack, `credentials.qaocabdpaxetofqcfgsa.supabase.co.txt` for hosted; `email<TAB>password<TAB>brand<TAB>role`, mode 0600). Each line is appended the moment `createUser` succeeds — before the link step — so a failure later in the run can never lose a password; the link asserts exactly one `app_users` row was updated before logging `linked`. The console shows the target host, then only `created` / `exists` / `linked` — never a password or key. Running it twice is a no-op.

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

Shell variables take precedence over `.env.local` (dotenv never overrides), so the same `.env.local` serves the app and both seed targets; the script prints the target host first, and each target writes its own `credentials.<host>.txt`, so a local run can never overwrite the hosted logins. The legacy single `credentials.txt` from the first hosted run (also git-ignored) still holds the hosted passwords — keep it (or the hosted per-host file) for the submission email.

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

Spot checks on `stage_contacts` (`kilele-contacts.csv`): `where had_nul` → `row_no` 5495, 23776, 61367 and no `\0` survives in any cell; `where cols[1] = 'external_id'` → 40007; `ncols` histogram 13: 83,923 / 9: 51 / 7: 19; `cols[13] where row_no = 750` = `VIP customer⏎follow up next quarter`; `=IMPORTXML(1,1)` staged verbatim. `karoo-contacts.csv`: `Ann–Marie Botha` decoded from windows-1252 `0x96`, 13-column rows in canonical order, ragged rows in raw order. `marrakech-campaigns.csv` `spend` `221,09` → `221.09`; the delta file carries `as_of 2026-09-01 / file_rank 20`, everything else `2026-08-01 / 10`. Re-staging `marrakech-contacts.csv` alone left the other files' rows untouched and replaced its 957 rows under a new `run_id`.

### Import — contacts (local, 2026-09-15)

`pnpm seed --only=import --entity=contacts` calls `internal.import_contacts(run_id)` once per staged contacts file, in `DIALECTS` order (Kilele base → Kilele delta → Karoo → Marrakech), and prints the `summary` jsonb each call returns (also stored on `import_runs`). Every rule is SQL (`supabase/migrations/0003_import.sql`): reject `wrong_column_count` / `repeated_header` / `blank_external_id` / `bad_signup_at` / `unknown_brand_code`; route rows whose `brand_code` names another brand (`routed_from` = the file's brand, `file_rank − 1` so the home brand's own row of the same `as_of` always wins; one count-only `route` issue per target brand in the *source* file's report, never row detail); warn on blank `brand_code`, unknown consent / status / country, missing or invalid email / phone, stripped NUL bytes, superseded in-file duplicates (last row wins) and delta rows that followed a routed contact; upsert source columns only where `(as_of, file_rank)` is strictly newer — `suppressed_at` / `suppressed_reason` are never in the SET list.

First load (empty `contacts`), as printed:

```
file                                  staged  rejected  routed  candidates  inserted  updated  unchanged  loaded  duplicates  warnings  warned_rows  ms
------------------------------------  ------  --------  ------  ----------  --------  -------  ---------  ------  ----------  --------  -----------  ----
kilele-contacts.csv                    83993        71     312       81144     81144        0          0   81144        2778     27378        25125  5067
kilele-contacts-delta-2026-09-01.csv    4180         0       0        4180      1680     2500          0    4180           0         0            0   246
karoo-contacts.csv                     13042        46      88       12494     12494        0          0   12494         502       502          502   770
marrakech-contacts.csv                   957        15       0         918       918        0          0     918          24        24           24    63

brand      contacts  routed_in
---------  --------  ---------
KAROO         12718        312
KILELE        82600         88
MARRAKECH       918          0
```

Kilele base: `rejected 71` = 70 ragged records + the repeated header at line 40007; `routed 312` (`brand_code = KAROO`); `duplicates 2778`; `inserted 81144` (of which 312 landed in KAROO, so KILELE held 80,832 after the base file). Delta: `updated 2500`, `inserted 1680` (the delta blanks `deleted_at` / `suppressed_until` on the base rows that had them — a blank is a supplied value). Karoo: 46 ragged rejected, 88 rows routed to KILELE, 502 duplicates. Marrakech: 15 ragged rejected, 24 duplicates. Totals match the architecture's expected post-load counts (S16): **KILELE 82,600 / KAROO 12,718 / MARRAKECH 918**. Warnings for the Kilele base (`v_import_issue_groups`): `consent_unknown` 9,810, `phone_missing` 8,491, `country_unknown` 3,014, `duplicate_external_id` 2,778, `email_missing` 1,810, `email_invalid` 1,431, `phone_invalid` 41, `nul_bytes_stripped` 3 — 27,378 warnings on 25,125 distinct rows. Stored values: `status` active 84,011 / unsubscribed 7,253 / bounced 3,356 / pending 1,616 (no other spellings, no sentinel); `country` KE 58,135 / ZA 12,718 / UG 4,338 / TZ 4,304 / ET 4,304 / RW 4,301 / SS 4,298 / MA 918 / null 2,920; `consent_marketing` true 65,413 / false 21,331 / null 9,492; every email lower-cased; no `E+` phone survives. Neither `blank_brand_code` nor `followed_routed_contact` occurs in the real files (every blank-code row is also ragged; no routed id collides with a home-brand id) — both are exercised by `supabase/tests/0003_import.test.sql` only.

Idempotency: running the same command again (same `run_id`s — the report is rewritten, contacts untouched) printed `inserted 0, updated 0` and `unchanged = candidates` for all four files (81,144 / 4,180 / 12,494 / 918) with every other count identical, in 4.2 s / 0.19 s / 0.62 s / 0.06 s; re-staging `kilele-contacts.csv` (fresh `run_id`) and importing it after the delta gave the same `inserted 0, updated 0, unchanged 81144`. Per-brand counts unchanged after both. The Kilele base import runs in ~5 s locally (the temp table is `analyze`d once `target_brand_id` is set — without that the follow-up joins against 80k+ contacts degraded to 25–70 s nested loops). Hosted load: below.

### Import — campaigns and events (local, 2026-09-15)

`supabase/migrations/0004_import_campaigns_events.sql` (`0003_import.sql` is frozen — it was pushed to hosted after Story 2.3, amendment S18) adds `internal.normalize_spend` (`221,09` and `221.09` → `221.09`), `internal.normalize_int` (digits only, int4 range) and the two importers. `internal.import_campaigns(run_id)`: reject `wrong_column_count` (`ncols <> 13`) / `repeated_header` / `blank_external_id`; warn `duplicate_external_id` (last row wins), `channel_unknown` (lower-trimmed value not `email` / `sms`, still stored), `target_country_unknown`, `spend_unparseable`, `reported_count_unparseable` (one per offending column, `detail.column` names it), `sent_at_unparseable` (each → `null`; a *blank* is just `null`, not warned), `nul_bytes_stripped`; upsert source columns only where `(as_of, file_rank)` is strictly newer; then a second pass over the whole brand resolves `parent_campaign_id` from `parent_external_id` **within the brand only** (idempotent — `is distinct from`; a pointer that no longer resolves is cleared) and warns `parent_not_in_brand` when the pointer exists only in another brand, `parent_unknown` when nowhere — both leave `parent_campaign_id null`. `internal.import_events(run_id)`: reject `wrong_column_count` (`ncols <> 6`) / `repeated_header` / `blank_event_id` / `unknown_contact` (no contact with that `external_id` in the file's brand) — unless that contact was *routed out* of the file's brand (`routed_from` = the file brand), in which case the event is stored under the contact's brand with warn `event_follows_routed_contact`; warn `unknown_campaign` (`campaign_id null`, kept for contactability, never counted in campaign performance), `type_unknown` (`public.normalize_event_type` → `unknown`, still stored), `occurred_at_unparseable`, `duplicate_event_id` (in-file, last row wins), `nul_bytes_stripped`; campaigns are looked up in the **file** brand only (Karoo's `CMP-014` is not Kilele's `CMP-014`) and an event that followed a routed contact never gets a cross-brand campaign pointer; insert `source = 'seed'`, `raw = {"cols": [...]}`, `on conflict (brand_id, source, event_id) do nothing`; the summary adds `already_present = candidates − inserted`. Nothing here sets `suppressed_at` (Story 6.2 backfills it from these rows).

First load (empty `campaigns` / `events`, contacts already loaded), as printed by `pnpm seed --only=import --entity=campaigns` then `--entity=events`:

```
file                     staged  loaded  rejected  routed  warnings  inserted  updated  unchanged  duplicates  warned_rows  already_present  ms
-----------------------  ------  ------  --------  ------  --------  --------  -------  ---------  ----------  -----------  ---------------  --
kilele-campaigns.csv         46      44         0       0         2        44        0          0           2            2                0  19
karoo-campaigns.csv          19      19         0       0         1        19        0          0           0            1                0   4
marrakech-campaigns.csv       6       6         0       0         0         6        0          0           0            0                0   3
kilele-events.csv        312000  303588         0       0      8412    303588        0          0        8412         8412                0  11631
karoo-events.csv          74000   69100         0       0      4900     69100        0          0        4900         4900                0   2745
marrakech-events.csv        940     940         0       0       633       940        0          0           0          633                0     55
```

Campaign issues, in full: Kilele `duplicate_external_id` ×2 (`CMP-014` at row 6 and `KIL-0044` at row 10 — each pair is byte-identical, so 46 staged → 44 campaigns); Karoo `parent_not_in_brand` ×1 (`CMP-014 → KIL-0007`, row 3 — `KIL-0007` exists in KILELE only, so the pointer is kept raw and `parent_campaign_id` stays null; it reads as `parent_not_in_brand` rather than `parent_unknown` only because Kilele's campaigns are imported first). No campaign has a resolved `parent_campaign_id` in the seed. 8 Kilele campaigns carry `target_country = 'KE'`; every `channel` is `email` or `sms`; Marrakech's `spend` came through the decimal comma (`MAR-0001` = `221.09`); every `sent_at` parsed. Event issues, in full: `duplicate_event_id` 8,412 (Kilele) / 4,900 (Karoo) / 0; `unknown_campaign` 0 / 0 / 633 (Marrakech — loaded with `campaign_id null`); `unknown_contact`, `event_follows_routed_contact`, `type_unknown`, `occurred_at_unparseable`: 0 everywhere (every event's contact is in its file brand — including the 1,680 Kilele contacts that exist only in the delta, which is why events run after all four contacts files). Stored Kilele event types after de-duplication: `opened` 90,442 / `clicked` 72,747 / `complained` 68,546 / `bounced` 68,523 / `unsubscribed` 3,330 (before de-duplication: 92.9k / 74.8k / 70.5k / 70.4k / 3.4k, as the Dev Notes expected). Every `occurred_at` parsed (microsecond ISO stamps), every `channel` is `email` / `sms`, every row keeps `raw.cols`.

### Full load — `pnpm seed` twice (local, 2026-09-15)

`pnpm seed` with no flags ran users → stage (11 files, 489,192 rows) → import (contacts ×4 → campaigns ×3 → events ×3), each file under a fresh `run_id`, in **27.0 s** the first time (campaigns / events from empty tables; contacts already loaded so their runs report `unchanged`) and **18.5 s** the second (Kilele events 13.3 s → 7.1 s: the second pass only probes the unique index). Both exited 0. Table counts before and after the second run are identical — `contacts` 96,236 / `campaigns` 69 / `events` 373,628 — and the second set of ten `import_runs` all report `inserted 0, updated 0` (contacts / campaigns: `unchanged = candidates`; events: `already_present = candidates`). Per brand:

| | KILELE | KAROO | MARRAKECH |
|---|---|---|---|
| contacts loaded (rows in table) | **82,600** (80,832 base + 1,680 delta + 88 routed in from Karoo) | **12,718** (12,406 own + 312 routed in from Kilele) | **918** |
| contacts rejected / routed out / routed in | 71 / 312 / 88 (base; delta 0 / 0 / 0 — 2,500 updated, 1,680 inserted) | 46 / 88 / 312 | 15 / 0 / 0 |
| campaigns | **44** (46 staged, 2 duplicate warnings; 8 `KE`) | **19** (1 `parent_not_in_brand`) | **6** (`spend` from decimal comma) |
| events inserted / in-file duplicates / `unknown_campaign` | **303,588** / 8,412 / 0 | **69,100** / 4,900 / 0 | **940** / 0 / 633 |
| `unknown_contact`, `event_follows_routed_contact` | 0, 0 | 0, 0 | 0, 0 |

Every number equals the architecture's expected table (S16 / Story 2.4 Dev Notes) — no deviation. Least-sure candidates for the submission note: the 633 Marrakech events whose `campaign_external_id` names no Marrakech campaign (loaded, `campaign_id null`, excluded from campaign performance); the two byte-identical Kilele campaign pairs collapsed to one row each; Karoo `CMP-014` whose parent pointer `KIL-0007` lives in Kilele (pointer dropped); the 8,412 / 4,900 duplicate event ids (byte-identical rows, one kept). Each has a pgTAP case in `supabase/tests/0004_import_campaigns_events.test.sql` (134 cases: both normalisers, every reject / warn reason, cross-brand parent, follow-a-routed-contact, `campaign_id` never resolved by `external_id` alone, idempotency with a fresh and with the same `run_id`).

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
| `public.import_runs` | `0003_import.sql` | one row per imported staged file (`id` = the staging `run_id`, `brand_id`, `brand_code`, `source_file`, `entity`, `started_at`, `finished_at`, `summary` jsonb `{staged, rejected, routed, candidates, inserted, updated, unchanged, loaded, duplicates, warnings, warned_rows}`); index `(brand_id, started_at desc)` |
| `public.import_issues`, enum `issue_severity` (`reject` / `warn` / `route`) | `0003_import.sql` | the marketer-facing report: `brand_id` = the **source** file's brand (not null), `run_id` (cascade), `row_no` (null for `route`), `reason` (stable lower_snake code), `detail` = only the offending value `{"value": …}` or `{"to": <CODE>, "count": N}` — never a whole row; index `(run_id, severity, reason, row_no)` |
| `public.v_import_issue_groups` | `0003_import.sql` | `(run_id, brand_id, severity, reason, n)` — per-run issue groups for `/imports` (Story 2.5); `security_invoker` |
| `internal.normalize_consent / _status / _country / _brand_code / _signup_at / _email / _phone(text)` | `0003_import.sql` | the PRD FR-7 normalisers, `immutable`, `search_path` pinned, `btrim` + `lower` first; unknown is `null`, never a sentinel; `normalize_signup_at` pins `timezone = 'UTC'` (ISO-8601 incl. date-only, and `dd/mm/yyyy HH:MI`); not exposed |
| `internal.import_contacts(run_id uuid) → jsonb` | `0003_import.sql` | the contacts importer (FR-8: reject / route / warn / last-duplicate-wins / strictly-newer upsert that never touches `suppressed_at`); run by `pnpm seed --only=import` as `postgres`; not exposed |
| `internal.normalize_spend(text) → numeric`, `internal.normalize_int(text) → int` | `0004_import_campaigns_events.sql` | `221,09` / `221.09` → `221.09`; digits-only int4; blank or anything else → `null`; `immutable`, `search_path` pinned; not exposed |
| `internal.import_campaigns(run_id uuid) → jsonb` | `0004_import_campaigns_events.sql` | the campaigns importer (reject / warn / last-duplicate-wins / strictly-newer upsert of source columns) + the second pass that resolves `parent_campaign_id` within the brand only (`parent_not_in_brand` / `parent_unknown` → null + warn); not exposed |
| `internal.import_events(run_id uuid) → jsonb` | `0004_import_campaigns_events.sql` | the events importer: contact must be in the file brand (or have been routed out of it — the event follows it, `event_follows_routed_contact`), campaign looked up in the file brand only (`unknown_campaign` → `campaign_id null`, kept for contactability), `type` via `public.normalize_event_type`, `raw = {"cols": […]}`, `source = 'seed'`, `on conflict do nothing` (`already_present` in the summary); never sets `suppressed_at` (Story 6.2); not exposed |

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
