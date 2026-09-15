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
| `pnpm test` | Vitest (`tests/**/*.test.ts`) against the local stack — `tests/isolation.test.ts` needs `.env.test` (below); the dispatch half of `tests/send-concurrency.test.ts` needs `dispatch-send` served against the provider mock (see *Dispatch*) and skips loudly otherwise |
| `pnpm test:db` | pgTAP suites in `supabase/tests/` |
| `pnpm lint` | `eslint .` (Next 16 removed `next lint`) — includes the `lib/supabase/admin` boundary (see *Continuous integration*) |
| `pnpm seed` | Loads the seed data in one command (see *Seed load counts*): users → stage all eleven files → import contacts ×4 → campaigns ×3 → events ×3 → send log ×1 (Kilele, last), one `import_runs` row per file, one summary line per file, exit code 1 if any importer raises. Flags: `--only=users\|stage\|import\|all` (default `all`), `--sample=N`, `--file=<basename>`, `--entity=contacts\|campaigns\|events\|send_log` (import step); the stage and import steps need `DATABASE_URL` |
| `pnpm schema:dump` | Regenerates `schema.sql` from `supabase/migrations/*.sql` |
| `pnpm gen:types` | Regenerates `lib/database.types.ts` from the local database |
| `pnpm check:functions` | `deno check` over `supabase/functions/*/index.ts` (the Edge Function sources are excluded from `tsc --noEmit`); skips with a note when `deno` is not on PATH |
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

## Dispatch (Story 4.3)

A confirmed send reaches the provider through the Edge Function `supabase/functions/dispatch-send` — once, even if the server dies mid-way or the provider is slow. The portal (Story 4.4) invokes it with the owner's session after `confirm_send`; the function authenticates the caller itself (`verify_jwt = false`, because the sweep signs with a shared secret and `sb_secret_` keys are not JWTs):

| Caller | Header | Load | Refusals |
|---|---|---|---|
| portal | `Authorization: Bearer <user jwt>` | user-scoped client (RLS proves the brand) | 401 no/invalid session · 403 `not_owner` (analyst) · 404 `not_in_brand` (another brand's send) · 400 `invalid_input` |
| `dispatch-sweep` (pg_cron) | `x-cron-secret: <CRON_SECRET>` | service-role client | 401 wrong secret · 404 `not_found` |

Then: pre-check (`status in (confirmed, dispatched) and batch_id is null`, else `200 { skipped, reason }`) → **the lease** (`dispatch_take_lease`: 10 min, `dispatch_attempts + 1`, cap 3, CAS — zero rows → `200 { skipped: true }`) → `202 { send_id, status: 'dispatched', dispatch_attempts }` → in `EdgeRuntime.waitUntil`: the snapshot in `contact_id` order (`dispatch_recipients`, one jsonb row), `sha256(external_ids joined by '\n')` must equal `sends.body_sha256` (else `failed` / `body_hash_mismatch`, no POST), `POST /v1/messages` with `Idempotency-Key: send-<send_id>` and a 60 s timeout. 2xx → `dispatch_record_result` (`accepted_count = count(distinct accepted ∩ send_recipients.external_id)`, `reporting` when it equals `recipient_count` else `partial`, `provider_batches` row); 4xx → `dispatch_mark_failed` (`failure_reason = provider_<status>: <body>`); 5xx / timeout / network → the send **stays `dispatched`** under its lease and is never re-POSTed by that invocation. One JSON log line per step (`{ fn, send_id, step, ok, ms }`) in the function logs. All four `dispatch_*` functions are `security invoker`, granted to `service_role` only (`0008_dispatch.sql`).

**The sweep** (`0009_cron_dispatch.sql`): pg_cron job `dispatch-sweep`, every 5 min, `internal.dispatch_sweep()` — (a) `dispatched`, no `batch_id`, lease expired, 3 attempts → `partial` (unknown outcome, FR-19); (b) `net.http_post` to `<functions_url>/dispatch-send` with the Vault `cron_secret` for `confirmed|dispatched` sends with no `batch_id`, a null/expired lease, < 3 attempts, confirmed more than 2 min ago. **Created disabled** — enable after the provider probe (Story 6.1) confirms a replayed `Idempotency-Key` returns the same `batch_id`:

```sql
select cron.alter_job(jobid, active := true) from cron.job where jobname = 'dispatch-sweep';
```

**Secrets.** Hosted: `supabase secrets set PROVIDER_BASE_URL=https://dispatcher-production-72fc.up.railway.app PROVIDER_API_KEY=… CRON_SECRET=…` (the same three live in the git-ignored `supabase/.env` for a local serve against the **real** provider — only ever for Story 6.1's deliberate probe). `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform. Deploy with `supabase functions deploy dispatch-send` (`verify_jwt = false` comes from `supabase/config.toml`).

**Vault (manual, per environment — never in a migration).** The sweep reads two secrets:

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'functions_url', 'base URL of the Edge Functions');
select vault.create_secret('<the CRON_SECRET set above>', 'cron_secret', 'x-cron-secret for dispatch-send');
```

Without them step (a) still runs and step (b) logs a warning and queues nothing.

**Local loop — the real provider is never called.** `tests/provider-mock.ts` is the provider for CI and development (D-14): `POST /v1/messages` (401 without a key; honours `Idempotency-Key` — a replayed key returns the identical response incl. `batch_id`), `GET /v1/messages/:batch_id/events` (≤ 1000 per page, opaque `next_cursor`, `has_more`, shuffled within a page, ~10 % duplicated across pages — Epic 6's poller is built against this), and a control surface: `POST /__mock/reset`, `POST /__mock/config` (`{ status, reject_ids, latency_ms, page_size, blank_body, events_status, events_fail_next, events_retry_after }`), `GET /__mock/calls`, `GET /__mock/reads`, `POST /__mock/batches/:batch_id` (Story 6.3: a programmed report stream). Vitest's `globalSetup` starts it on `PROVIDER_MOCK_PORT` (8787) for every `pnpm test`; standalone: `pnpm tsx tests/provider-mock.ts`.

```bash
supabase start
supabase functions serve dispatch-send --env-file supabase/mock.env --no-verify-jwt   # PROVIDER_BASE_URL=http://host.docker.internal:8787
pnpm test                                                                              # tests/send-concurrency.test.ts, dispatch half
```

`supabase/mock.env` is committed (no secrets: the mock accepts any key, `CRON_SECRET=local-cron-secret` guards only the local serve). The dispatch suite signs in as the KILELE owner, KILELE analyst and KAROO owner — `.env.test` needs `TEST_KAROO_OWNER_EMAIL/_PASSWORD` too (a local password set with the Admin API, like the KILELE owner's). Measured locally: KIL-0016's 50,064 recipients → `reporting` in ~0.5 s (recipients 124 ms, hash 7 ms, POST 75 ms, record 86 ms).

## Polling the reports (Story 6.3)

Delivery reports are fetched on a schedule and shown honestly. `0013_cron_poll.sql`:

| Job | Schedule | What |
|---|---|---|
| `poll-events-5m` | `*/5 * * * *` | `internal.request_poll(48)` — batches dispatched in the last two days |
| `poll-events-hourly` | `0 * * * *` | `internal.request_poll(168)` — the last week (late / re-appended items, probe row c) |
| `poll-log-reconcile` | `*/5 * * * *` | rows still `requested` / `running` after 10 min → `failed` / `no_response` |
| `dispatch-sweep` | `*/5 * * * *` | **enabled here** (0009 created it disabled): the probe showed a replayed `Idempotency-Key` returns the same `batch_id` (row a); `DISPATCH_RETRY_ENABLED=on` is set in the same step, so a provider 5xx / timeout leaves the send `dispatched` under its lease for the sweep instead of `partial` at once |

`internal.request_poll(window_hours)` (security invoker, cron only — nothing in `internal` is definer) inserts `internal.poll_log (status = 'requested')` **first**, then `net.http_post(<functions_url>/poll-events, x-cron-secret, { poll_log_id, window_hours }, timeout 60 s)` with both values from Vault and stores `net_request_id`; a missing Vault secret marks the row `failed` / `missing_secret` and queues nothing.

**`supabase/functions/poll-events`** (`verify_jwt = false`; `x-cron-secret` only) opens a **direct Postgres connection** over the platform-injected `SUPABASE_DB_URL` (`_shared/db.ts`, `npm:postgres`) — `internal.*` is unexposed to PostgREST and a transaction-scoped advisory lock has to survive the provider round-trips. `poll_log → running` (CAS from `requested`; a re-delivered request answers 409), then every `provider_batches` row whose send was dispatched inside the window, **whatever `sends.status`** (a `partial` send still gets reports), oldest-polled first; per batch one transaction: `pg_try_advisory_xact_lock(hashtext(batch_id))` (false → skip) and ≤ 10 pages by the probe's cursor rules — `since` carries only the stored `next_cursor` (never an event id: the real provider ignores one and replays the stream, which ingest's `(batch_id, event_id)` dedupe absorbs), page → `internal.ingest_provider_events` → **compare-and-set** cursor update (`next_cursor is not distinct from <value read before the page>`; the last non-null cursor is kept even when the closing page says `null`), stop on an empty page / null cursor / unchanged cursor / `has_more = false`, never on `has_more` alone; `has_more = true` + null cursor → `cursor_contract_violation`. 401 → `auth_error` (run aborted); 429 / 503 → `Retry-After` (header → body `retry_after` → 5 s): ≤ 10 s inside the 50-s budget is waited out, otherwise the run ends `rate_limited` / `deferred` with the cursor untouched; 404 / other 4xx / 5xx / timeout (20 s) → `provider_error` for that batch, next batch. No new batch after 50 s. Every run ends with `internal.complete_sends()` and `poll_log (status, finished_at, batches, pages, inserted, duplicates, error)`; one JSON log line per step.

**The pages.** `/campaigns` and `/campaigns/[id]` read `v_last_sync` (`Reports last synced 3 minutes ago`, the UTC instant in the title; the placeholder while the brand has no portal send) and `last_poll_status()`: a newest run outside `ok / requested / running` adds the muted line "Report sync has not succeeded since {last success | the portal went live}"; a failed read of either renders the destructive "Sync status unavailable" — three distinct states, never a fake "synced". Portal sends show live delivered / bounced / opened / clicked / unsubscribed counts and the view's rates beneath their campaign (list) and inside the send's history card (detail); a send with no report yet reads "No reports yet", not zeros.

**Local loop.** `supabase functions serve --env-file supabase/mock.env --no-verify-jwt` serves both functions; `tests/ingestion.test.ts` builds a synthetic brand + a five-recipient send, records batch `B-ING-<n>`, programs the mock (`POST /__mock/batches/:batch_id { events, page_size, shuffle, duplicate_across_pages, released }`) and runs `poll-events` against it; `POST /__mock/config { events_status, events_fail_next, events_retry_after }` forces 503 / 429 / 401 / 404 on the report stream, `GET /__mock/reads` lists every GET the poller made. The two send suites share a `mkdir` lock (`.vitest-locks/`, git-ignored) so their batches never sit in one poll window. Hosted: `supabase functions deploy poll-events --no-verify-jwt`, `supabase secrets set DISPATCH_RETRY_ENABLED=on`, the two Vault secrets (`functions_url`, `cron_secret`), `supabase db push`; then `select * from internal.poll_log order by id desc limit 5` and `select jobname, active from cron.job`.

## Reachability (Story 7.2)

Vercel Hobby and Supabase Free both go quiet when nobody visits (architecture D-14): Supabase pauses a free project after a week without API activity, and nothing pg_cron does inside the database is documented to count as activity. Two probes keep the API side warm, and one human check is the real control:

| What | Where | How |
|---|---|---|
| `GET /api/health` | `app/api/health/route.ts` | `@supabase/supabase-js` with `NEXT_PUBLIC_SUPABASE_URL` + the **publishable key only** (no session, never `lib/supabase/admin`, no service / provider / database secret — the ESLint boundary below makes an admin import a lint error), `rpc('health_ping')` → `200 {"ok":true,"db":"ok","at":"…"}` or `503 {"ok":false,"code":"db_unreachable"}`, always `Cache-Control: no-store`. Outside the session guard (`proxy.ts` matcher, `tests/proxy-matcher.test.ts`); unauthenticated by design — do **not** create a Vercel `CRON_SECRET` env (name clash with the Supabase Vault secret from Dispatch / Polling). Under Cache Components the route forces request-time rendering with `connection()` rather than `export const dynamic`. |
| `public.health_ping()` | `supabase/migrations/0014_health.sql` | `select 'ok'`, `language sql stable security invoker set search_path = ''`, revoked from `public`, granted to **`anon` only** — the tenancy suite's exact anon set is `{get_shared_results, health_ping}` (`0001_tenancy.test.sql` S5, mirrored in `0011_share.test.sql` T8); `0014_health.test.sql` pins shape, grants and the answer as `anon` / the refusal as `authenticated`. |
| Vercel cron | `vercel.json` | `{"crons":[{"path":"/api/health","schedule":"0 6 * * *"}]}` — once a day (Hobby: at most daily, may run up to an hour late). Listed under Vercel → Settings → Cron Jobs after the deploy. |
| pg_cron | `0009` / `0013` | `dispatch-sweep`, `poll-events-5m`, `poll-events-hourly`, `poll-log-reconcile` keep the database busy every five minutes (unchanged by this story). |

```bash
curl -i https://vg-campaign-portal.vercel.app/api/health     # HTTP/2 200, cache-control: no-store, {"ok":true,"db":"ok","at":"…"}
```

### Call-day checklist

The morning of the call, in this order (five minutes; everything below is read-only):

1. **Project not paused** — Supabase Dashboard → project `qaocabdpaxetofqcfgsa` → it must read *Active*; if it shows *Paused*, click **Restore** and wait for *Active* (a couple of minutes), then continue.
2. **`/api/health` returns 200** — `curl -i https://vg-campaign-portal.vercel.app/api/health` → `200` + `"db":"ok"` (a `503` means the database did not answer: go back to step 1). Vercel → Settings → Cron Jobs still lists `/api/health` at `0 6 * * *`.
3. **Google sign-in** — open https://vg-campaign-portal.vercel.app/login, *Continue with Google* as `joegmes@gmail.com` → lands on the Kilele Rides dashboard with the *Owner* badge.
4. **Share link + password opens** — the published Kilele campaign's `/share/<token>` from the submission note + its password → the results card renders (a wrong password says so, a revoked link says so).
5. **Six logins** — each of `kilele.owner`, `kilele.analyst`, `karoo.owner`, `karoo.analyst`, `marrakech.owner`, `marrakech.analyst` `@vg-eval.test` (passwords in the hosted `credentials.<host>.txt` / the submission email) opens its own portal: its brand name in the header, its own campaigns, the owner / analyst badge.
6. **The poller is alive** — Supabase Dashboard → SQL editor (`internal` is not exposed through the Data API, so this is the only place):

   ```sql
   select status, requested_at, finished_at, error from internal.poll_log order by requested_at desc limit 3;
   ```

   The newest row must be `ok` (or `requested` / `running` if a run is in flight) with `requested_at` inside the last hour; `failed` / `missing_secret` means the Vault secrets are gone (see *Polling the reports*), `no_response` means pg_net could not reach the function. The same answer through the app: `select * from public.last_poll_status();` as any signed-in user, and the *Reports last synced …* line on `/campaigns`.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request, on a fresh `ubuntu-latest` runner, **without a single secret**: the whole run targets the local Supabase stack that `supabase start` boots on the runner (the CLI's well-known demo keys, read at run time from `supabase status -o env`), and the provider is `tests/provider-mock.ts`. No real provider batch is ever dispatched, no hosted project is ever touched, and `SUPABASE_SERVICE_ROLE_KEY` / `PROVIDER_API_KEY` / `DATABASE_URL` never appear in the workflow file.

| Step | Fails when |
|---|---|
| `pnpm install --frozen-lockfile` | the lockfile is out of date |
| `pnpm lint` (`eslint .`) | any ESLint error — including the service boundary: `lib/supabase/admin` imported anywhere but `scripts/**` and `tests/**`, whatever the spelling (`eslint.config.mjs`, `no-restricted-imports`; proven by adding `import "@/lib/supabase/admin"` to the health route and watching `pnpm lint` fail; `tests/health.test.ts` re-proves it through ESLint's API) |
| `pnpm exec tsc --noEmit` | a type error anywhere the app compiles (`supabase/functions` is Deno — `pnpm check:functions`) |
| `pnpm schema:dump && git diff --exit-code -- schema.sql` | **schema drift**: `schema.sql` no longer equals the concatenation of `supabase/migrations/*.sql` (byte-deterministic, `LC_ALL=C` order, no timestamps) — a migration was edited or added without `pnpm schema:dump` in the same commit |
| `supabase start` → `supabase db reset && supabase test db` | a migration does not apply from empty, or any pgTAP suite fails (the isolation test included) |
| `pnpm seed` | the seed data in `docs/data/` does not load through the importers against the runner's stack (users → stage → import) |
| `scripts/ci-env.sh` | writes the runner's `.env.test` (local URL + publishable key + the six logins from the seed's `credentials.127.0.0.1-54321.txt`) |
| `supabase functions serve --env-file supabase/mock.env --no-verify-jwt` | the Edge Functions do not come up (the step waits for `dispatch-send` to answer `400 invalid_input`) |
| `pnpm test` | any Vitest suite fails — the integration suites (`isolation`, `send-concurrency`, `ingestion`, `share-*`, `send-actions`, `health`) **fail instead of skipping under `CI`**; the provider mock starts in Vitest's `globalSetup` on 8787, where the served functions reach it through `host.docker.internal` |

Pinned versions: Node from `.nvmrc`, pnpm 12, Supabase CLI 2.117.0 (the version the repo was developed against). Iterations so far: run 1 failed on a suite race (`share-link`'s `afterAll` signed the shared KILELE owner out **globally** and killed the dispatch suite's session — fixed with `scope: "local"`); the drift step was proven to fail by appending a comment to a migration without regenerating (`git diff --exit-code` → 1), then restored.

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
- **Two `dispatch-send` invocations at once for one send** (Story 4.3, `tests/send-concurrency.test.ts` against the served function + the mock) — both load the send as `confirmed`; `dispatch_take_lease` admits exactly one (`202`, attempts 1), the other gets `200 { skipped: true, reason: 'lease_unavailable' }`; the send reaches `reporting` with one `provider_batches` row and the mock saw one distinct `Idempotency-Key` (`send-<id>`). A third call → `skipped` / `batch_recorded`; the KAROO owner → `404 not_in_brand`; the KILELE analyst → `403 not_owner`; no auth, a garbage bearer and a wrong cron secret → `401`. A tampered `body_sha256` → `failed` / `body_hash_mismatch` with **no** provider call; a mock `422` → `failed` / `provider_422: …` and the campaign is free to confirm again; a mock `503` → the send stays `dispatched` with a live lease, attempts 1, and a further call is `skipped` — nothing is re-POSTed until the sweep. pgTAP mutation drills on `0008`/`0009` (each in a rolled-back transaction): dropping `batch_id is null` from the lease → `L6`/`Z1`; dropping the CAS from `dispatch_mark_failed` → `M2`/`M3` (6 lines); ordering the recipients by `external_id` → `R1`/`R3`; granting a `dispatch_*` function to `authenticated` → `G2`/`N1`; dropping the sweep's 2-min age → `V2` (the just-confirmed send is re-invoked); dropping `attempts >= 3` from the cap → `W3`; letting the sweep ignore a live lease → `V6`.
- **The send flow from the portal, as two roles** (Story 4.4, local stack: `pnpm dev` against `127.0.0.1:54321`, `supabase functions serve dispatch-send --env-file supabase/mock.env`, `tests/provider-mock.ts` on 8787; real password sessions for the KILELE owner and analyst, the server actions called by `curl` with the `Next-Action` header) — the analyst's `/campaigns/[id]` renders no Send button and no dialog; their `previewSendAction` works (RLS lets an analyst read the count) but `confirmSendAction` returns `{ ok: false, code: 'not_owner' }` and `dispatchSendAction` maps the function's `403` to the same code — nothing is written. The owner's confirm with a stale count returns `count_mismatch` with `hint = "33562"` and the copy "The list changed since you looked — 33,562 now. Confirm again."; a malformed id → `invalid_input`; another brand's campaign → `not_in_brand`. With the mock delayed by 4 s, `confirmSendAction` for KIL-0001 (33,562 recipients) returned in **801 ms** — the send was already `dispatched` (the lease) and reached `reporting` / `mock-1` / 33,562 accepted ~4 s later while the page polled every 3 s; so the action never waits for the provider. Two concurrent confirms ("two tabs") for KIL-0020 → one `sends` row, both responses carry its id, one dispatch attempt, one `Idempotency-Key` at the mock. Three recipients on the mock's `reject_ids` → `partial`, "Partially sent — 45,291 of 45,294 accepted"; a forced `422` → `failed` with `provider_422: …` shown as the failure reason and the campaign free to confirm again. With the function **stopped**, confirm still returned `{ ok: true }` in 688 ms and the send stayed `confirmed` (`dispatch_invoke_failed` in the server log); after 30 s the owner's history shows "Dispatch didn't start" + Retry, and `dispatchSendAction` took it to `reporting` — a second Retry answers `dispatched: false, reason: 'batch_recorded'`. Found along the way: `POST /__mock/reset` restarts the mock's `batch_id` counter, so a second send got `mock-1` again and `dispatch_record_result` hit `provider_batches_batch_id_key` — the send stayed `dispatched` under its lease (the sweep's case). A mock artefact, not a provider behaviour, but it is what a provider reusing a batch id would look like. Every test send was deleted afterwards (service role); only Story 4.5's seed send-log rows remain.
- **Publish and revoke a share link, as two roles** (Story 5.2, local stack: `pnpm dev` against `127.0.0.1:54321`, real password sessions for the KILELE owner, the KILELE analyst and the KAROO owner, the server actions called by `curl` with the `Next-Action` header, then the RPCs called raw through PostgREST) — the analyst's `/campaigns/[id]` renders no "Publish results" button, no share dialog and no Revoke on any row (the rows themselves are visible: `v_share_links` is a read for the whole brand); a direct `createShareLinkAction` call as the analyst returns `{ ok: false, code: 'not_owner' }`, and so does `revokeShareLinkAction`; the same two RPCs POSTed to `/rest/v1/rpc/create_share_link` / `revoke_share_link` with the analyst's JWT answer `P0001 not_owner`; with the anon key → `42501 permission denied for function create_share_link`; `GET /rest/v1/share_links?select=token_hash` as the analyst → `42501` (the column grant excludes the hashes). The owner: `1234567`, seven spaces, `expires_at: ""`, a malformed campaign id → `invalid_input` from zod **before any RPC call**; a past expiry passes zod and the RPC refuses it with the same code; the KAROO owner's campaign → `not_in_brand`; `'       x'` (seven spaces + x) is accepted, stored untrimmed, and the stranger's door unlocks with `'       x'` and refuses `'x'` (`tests/share-actions.test.ts`); the URL comes back once as `http://localhost:3052/share/<43-char token>` and, with an `x-forwarded-host: vg-campaign-portal.vercel.app` header, as `https://vg-campaign-portal.vercel.app/share/<token>`. Revoke: analyst → `not_owner`, KAROO owner on a KILELE link → `not_in_brand` (the row stays `active`), the KILELE owner → the row re-renders `revoked` with its `revoked_at` and without a Revoke button; a second revoke is a no-op. The KAROO owner opening the KILELE campaign page gets the not-found tree and zero link rows. Found along the way: **`next dev` logs every server-function call with its arguments** (`└─ ƒ createShareLinkAction({…"password":"…"})`) — the share password sat in the dev terminal; `logging: { serverFunctions: false }` in `next.config.ts` turns that off (dev-only; production never printed it). The token itself never appeared in any log line (it is only in the action's return value). Every link created was deleted afterwards.
- **`tests/isolation.test.ts` with RLS disabled on `brands`** (`alter table public.brands disable row level security`) → `brands: exactly the analyst's own brand` fails with `expected [ 'KILELE', 'KAROO', 'MARRAKECH' ] to deeply equal [ 'KILELE' ]`; re-enabled → 6/6 pass. Anonymous PostgREST selects on every table return `42501` (permission denied), not empty arrays.
- **The same 20 provider events, four ways** (Story 6.2, `supabase/tests/0012_events_ingest.test.sql`) — in order, reversed, shuffled, and every event twice: `contacts.suppressed_at` / `suppressed_reason`, the stored events and the `v_campaign_performance` portal row are byte-identical across the four runs (`results_eq`); a `bounced` at T2 followed by a `delivered` at T3 leaves the contact suppressed at T2; a `complained` at T3 arriving before a `bounced` at T2 still ends at T2 / `bounced` (the earlier moment wins, whatever arrived first). The provider's forged event for a real KAROO-style contact (`recipient_id` of another brand's contact, `brand_code` lying about the brand) is dropped and counted — brand B's contact stays contactable; so is a real Kilele contact who was not in the batch. A `weird` type, a key-less element, a bare string and a number in the array all insert without aborting the page. Mutation drill: deleting the `when (…)` clause from the trigger fails T1 only (the function guards the rule itself); widening the recipient lookup to the whole brand fails I1 / I7 / V2 (the real Kilele contact who was not in the batch gains an event); resolving recipients by `external_id` across brands would be what lets the forged event suppress the Karoo contact (I6).
- **The messy stream, released in two halves across two poll runs** (Story 6.3, `tests/ingestion.test.ts` against the served `poll-events` + the mock) — twelve events (delivered ×5, bounced ×2, opened ×3 with a repeat, unsubscribed ×1, one `weird`) served shuffled, ~10 % duplicated across pages of four, six released for run 1 and all twelve for run 2: `events`, `contacts.suppressed_at` and the `v_campaign_performance` row equal a clean single-run ingest (`toEqual`); run 1 stopped on the open-but-empty page with `has_more` still true (not on `has_more`), kept its cursor, and every `since` the poller sent was the mock's opaque cursor — never an event id; the closing page's `null` did not wipe the cursor; a third run inserted 0. A 503 with `Retry-After: 1` was waited out inside one run (`ok`, 12 inserted, the same page re-read); `Retry-After: 30` ended the run `deferred` with the cursor and `last_ok_at` untouched and the next run `ok`; 401 → `auth_error`, 404 → `provider_error`, each with `complete_sends()` and a finished `poll_log` row; a batch dispatched three days ago is outside the 48-h window and inside the 168-h one; a `partial` send's batch is still polled. Found along the way: `postgres.js` JSON-encodes a parameter cast `::jsonb` itself, so a pre-stringified page arrived double-encoded (`jsonb_typeof = 'string'` → `invalid_input`); and the story's "security definer" for `request_poll` would have failed three suites' "nothing in `internal` is definer" pins — pg_cron runs the job as `postgres` anyway, so it is invoker like `dispatch_sweep`.

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

**Hosted full load pending: needs DB password.** `0004_import_campaigns_events.sql` is pushed (`supabase migration list`: `0000–0004` local = remote). The seed itself runs over the Supavisor **session** pooler with the project's database password (`SUPABASE_DB_PASSWORD` is not in this environment); exact command, from the repo root with Node 22:

```bash
# hosted — one-time engineer-run job over the session pooler (port 5432, needed for COPY and the long import calls)
NEXT_PUBLIC_SUPABASE_URL=https://qaocabdpaxetofqcfgsa.supabase.co \
SUPABASE_SERVICE_ROLE_KEY="$(supabase projects api-keys --project-ref qaocabdpaxetofqcfgsa --reveal -o json | jq -r '.[] | select(.type=="secret") | .api_key')" \
DATABASE_URL="postgresql://postgres.qaocabdpaxetofqcfgsa:${SUPABASE_DB_PASSWORD}@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" \
pnpm seed
```

Expected output: the tables above (the hosted `contacts` start empty, so the four contacts runs report the first-load numbers from *Import — contacts*). Run it twice and paste both `Import summary` tables here in place of this paragraph.

### Import — send log (local, 2026-09-15)

`supabase/migrations/0010_send_log.sql` (`0006_sends.sql` is frozen on hosted — amendment S20) adds `internal.import_send_log(run_id)`, the last importer in the D-3 order (it needs the brand's campaigns). Reject `wrong_column_count` (`ncols <> 5`) / `blank_batch_key`; collapse by `batch_key` — the last row (highest `row_no`) wins and every superseded row gets one warn `duplicate_batch_key` and is never judged further; then on the surviving row reject `unknown_campaign` (looked up in the **file** brand only), `unparseable_queued_at` (`internal.normalize_signup_at`, ISO-8601 UTC), `unparseable_recipient_count` (`internal.normalize_int`). Insert `sends(brand_id, campaign_id, source = 'seed_send_log', batch_key, status = 'complete', recipient_count, confirmed_at = dispatched_at = queued_at_utc)` with `on conflict (batch_key) do nothing` — the unique constraint on `sends.batch_key` is the idempotency key, `already_present = candidates − inserted`. The file's `status` column is always `sent` and is not stored; `confirmed_by` / `body_sha256` / `batch_id` / `accepted_count` stay null. `complete` is terminal, so a seed send never blocks a later portal send of the same campaign (FR-21). Send-log batches are send **history**, never a rate denominator: `v_campaign_performance` still reads the campaign's `reported_*` — `BATCH-0007` carries 9,800 recipients while KIL-0016 reports `reported_sent` 10,640, and the page keeps 10,640 (delivered rate 95.00%, caption "as reported by the source").

`pnpm seed` twice (users → stage → the 11 imports, 19.7 s then 19.9 s, both exit 0); the send-log line each time:

```
import kilele-send-log.csv  staged 9  loaded 7  inserted 7  rejected 0  routed 0  warnings 2   (first run)
import kilele-send-log.csv  staged 9  loaded 7  inserted 0  rejected 0  routed 0  warnings 2   (second run — already_present 7)
```

9 staged rows → **7 sends** (`BATCH-0001`…`BATCH-0007`, one per Kilele campaign KIL-0012 / KIL-0044 / KIL-0007 / KIL-0021 / KIL-0031 / KIL-0009 / KIL-0016, `recipient_count` and `confirmed_at = dispatched_at` byte-for-byte the CSV's values); `BATCH-0003` ×3 (CSV lines 3, 6, 7 — byte-identical) collapsed to one send (line 7 wins) with 2 `duplicate_batch_key` warnings on rows 3 and 6 (`row_no` = the CSV line, header = 1); **0 rejected** (every campaign resolves in KILELE, every stamp and count parses). The second run inserted 0 (`already_present 7`), `select count(*) from sends where source = 'seed_send_log'` = 7 before and after; the per-brand verification table now ends with `seed_sends` = KILELE 7 / KAROO 0 / MARRAKECH 0. pgTAP `supabase/tests/0010_send_log.test.sql` (68 cases) pins the function's shape and grant surface, every reject / warn reason with its `detail`, the collapse (last row wins, a superseded row is only warned even when its own values are bad), the inserted row's fields, idempotency with the same and with a fresh `run_id` (zero rejects in the second run), a pending portal send next to a complete seed send, the campaign's `reported_*` untouched, another brand's file, and RLS on the result.

### Events ingest + suppression backfill (Story 6.2, local, 2026-09-15)

`supabase/migrations/0012_events_ingest.sql` adds the monotonic suppression trigger (`trg_events_insert_suppress`: an ingested `bounced` / `unsubscribed` / `complained` event sets `contacts.suppressed_at = coalesce(occurred_at, now())` when null and only ever moves it **earlier** — never cleared, never later, same value whatever the arrival order) and **backfills it from the seed events loaded in Epic 2** (the trigger did not exist then — amendment S4). This is the re-measure the "Contactable" tile promised since Story 3.1 (its rule already said "no ingested bounced / unsubscribed / complained event"; the number could not honour it until now):

| | KILELE | KAROO | MARRAKECH |
|---|---|---|---|
| contactable before the backfill (Story 3.1) | 51,298 | 5,760 | 449 |
| **contactable after** | **36,446** | **501** | **230** |
| contacts flipped by the backfill | **14,852** | 5,259 | 219 |
| contacts carrying `suppressed_at` (bounced / unsubscribed / complained) | 23,538 (11,315 / 601 / 11,622) | 11,951 | 438 |

Kilele's 14,852 is exactly the "~14,852 contactable contacts with a terminal seed event" that Stories 3.1 and 4.1 flagged as the least-sure figure. Consequently the recipient preview of `KIL-0016` (email, untargeted) reads **35,547** recipients (was 50,064): excluded `not_contactable` 45,759, `no_address` 899, `country_mismatch_or_unknown` 0 — still summing to the 82,205 non-deleted Kilele contacts; `KIL-0001` (KE-targeted) 23,678 / 45,759 / 899 / 11,869. The dispatch suite's timing line now reads `35547 recipients → reporting in ~0.5 s`. The count is computed by the migration itself (`raise notice 'suppression backfill …'` per brand) — nothing in `metric_rules` is consulted or changed.

Ingest (`internal.ingest_provider_events(send_id, batch_id, events jsonb)`) follows the probe (`docs/provider-api.md`, `## Probe 2026-09-15`): tenancy from the send's snapshot only (`brand_code` in the payload is never read); a recipient is resolved **only** through the send's `send_recipients` — the provider forges one event per batch for a real contact who was not in the batch, and those are dropped and counted (`foreign_recipient`), so a Kilele batch can never suppress a Karoo contact; dedupe on `(batch_id, event_id)` (stored `event_id = <batch_id>:<provider id>`, raw payload kept); an unknown `type` inserts as `unknown`; `occurred_at` is stored verbatim even when it is in the future; a poison element (a string, a number, no ids, a null type) never aborts the page. `internal.recipient_state` reads by precedence (`unsubscribed | complained > bounced > delivered`), not by time — `delivered` is re-appended after `opened` and after `bounced`. `v_campaign_performance` now emits one `source = 'portal'` row per dispatched portal send beneath the campaign's `reported` row (`sent = accepted_count`; delivered / bounced / unsubscribed distinct per contact, opens / clicks total; `dispatched_at` appended as the last column); seed send-log sends get no row. `internal.poll_log` + `poll_status` (`… provider_error, deferred`), `public.v_last_sync` and `public.last_poll_status()` are the sync surfaces Story 6.3 fills. pgTAP `supabase/tests/0012_events_ingest.test.sql` (160 cases): the same 20 events in order, reversed, shuffled and doubled → identical suppression / events / performance rows; `bounced` at T2 then `delivered` at T3 stays suppressed at T2; the earlier of `bounced` T2 / `complained` T3 wins whatever arrives first; the three forged recipients are dropped; the trigger's `WHEN` clause pinned (the seed load never fires it).

**Carried-in fixes in the same migration** (append-only migrations, `create or replace`): S19 — a seed event that follows a routed contact is stored as `<file brand>:<event_id>` (seed ids overlap 100 % across brands; the bare id collided with the target brand's native event), `normalize_int` / `normalize_spend` match `[0-9]` only (PG `\d` matches Unicode digits and the cast aborted the whole import), a campaign never parents itself, `import_runs.finished_at = clock_timestamp()`, `unknown_campaign` only for a non-blank pointer and `campaign_not_followed` for a followed row's pointer; 4.5 review — `import_send_log` rejects `unsupported_status` (status ≠ `sent`) and `repeated_header`, warns `batch_key_taken`; Epic 4 review (D-7) — `public.dispatch_mark_partial(send, reason)` (service-role CAS `confirmed|dispatched → partial`), the sweep stamps `dispatch_outcome_unknown_after_3_attempts` and turns candidates older than 24 h `partial` / `dispatch_expired` instead of re-POSTing them, `dispatch_record_result` answers a colliding `batch_id` with `failed` / `duplicate_batch_id: <id>` instead of a rolled-back 2xx. The `dispatch-send` Edge Function's 5xx / timeout branch now calls `dispatch_mark_partial` (`provider_<status>_outcome_unknown` / `provider_unreachable_outcome_unknown`) while the secret `DISPATCH_RETRY_ENABLED` is not `on` — it is unset until Story 6.3 enables the sweep in the same step (probe row a).

## Performance

_NFR-3: every portal page answers in under 2 s at the full load. **Local production build, full data** — `next build` + `next start` against the local stack with the complete seed load (Kilele 82,205 live contacts), signed in as the Kilele analyst, `curl -w '%{time_total}'`, one warm-up then ten timed requests per URL (Story 3.3). **Hosted re-measure pending seed load**: the hosted project has no contacts until the seed runs there, so a hosted timing today would measure an empty view — re-run the three URLs against https://vg-campaign-portal.vercel.app once it exists and replace this table._

| URL (Kilele analyst) | p50 | max of 10 |
|---|---|---|
| `/contacts` (page 1 of 1,645) | 48 ms | 53 ms |
| `/contacts?q=ami` (6,306 matches, 127 pages) | 153 ms | 165 ms |
| `/contacts?contactable=true&page=800` (page 800 of 1,026) | 57 ms | 58 ms |

`explain analyze` of the `q=ami` page query as the analyst, under RLS through the `security_invoker` view: **72.9 ms** (brand-scoped scans; no extra index added — the trigram / `text_pattern_ops` indexes from `0002` are not what a contains-search uses, and the budget has 10× headroom). Same build, same session (3.2 / 3.4 review runs): `/dashboard` p50 42 ms / max 50 ms, `/campaigns` p50 42 ms / max 50 ms, `/campaigns/<id>` p50 31 ms / max 35 ms. `next dev` requests are 0.1–0.7 s and are not the measurement.

## Mobile (Story 7.1)

_NFR-4: every screen usable at 400 px — confirm and share especially. Checked headless (Chromium via Playwright in a scratch directory, not a project dependency) at **400 × 800**, `isMobile` + touch, against `pnpm dev` on the local stack with real sessions; the structural contract lives in `tests/mobile-nav.test.ts` and `tests/mobile-routes.test.ts`, the screenshots in the git-ignored `screenshots/`._

- Below `md` the header keeps brand + role badge and a 44 × 44 px menu button; the links, email and sign-out move into a left `Sheet` (`components/ui/sheet.tsx`, a dependency-free native `<dialog>` with the shadcn API — no new package, like `dialog` / `tooltip` / `popover`). It closes on navigation, on Escape, on the backdrop and on ×.
- Every table (`contacts`, `campaigns`, `imports` ×2, dashboard performance) declares a pixel `min-w-[…]` and scrolls inside the `Table` primitive's own `overflow-x-auto` wrapper; the portal `<main>` is `min-w-0`, so `document.documentElement.scrollWidth === window.innerWidth === 400` on every route (`/login`, `/dashboard` for Kilele and for Marrakech's empty chart, `/contacts` and `?q=zzzz`, `/campaigns`, `/campaigns/[id]` as owner and as the wrong brand, `/imports?run=`, `/share/<token>` before and after unlocking, the root 404).
- Tiles stack (`grid-cols-1 sm:grid-cols-2`); the signups SVG scales to the card (`w-full min-w-0`) with its axis text hidden below `sm` (each bar keeps its `<title>`); the send-confirm and share-link dialogs are `max-h-[90dvh] overflow-y-auto` with stacked full-width buttons (596 px and 398 px tall at 400 × 800, confirm / submit visible); every `<input>` is 16 px below `md` (no iOS focus zoom); the viewport meta stays Next's default (`width=device-width, initial-scale=1`, no `maximum-scale`).
- Copy on `/campaigns/[id]` is a plain `onClick` → `navigator.clipboard.writeText` → toast "Link copied"; when the clipboard is unavailable (no secure context, permission denied) the URL is selected in its read-only input and a toast + inline note say "Copy manually".
- Three states per route, simulated without stopping the shared stack: a reverse proxy in front of `127.0.0.1:54321` that refuses every PostgREST call except `app_users` — dashboard → four `RetryAlert`s and no number, `/contacts` and `/imports` → their `error.tsx`, `/campaigns` → list + portal-sends alerts and "Sync status unavailable", `/campaigns/[id]` → "This campaign could not be loaded"; one Retry after the proxy heals recovers every route. Empty: `/contacts?q=zzzz`, Marrakech's "0 signups in the last 30 days — last signup …", `/campaigns/<other brand's id>` → the not-found tree; `/nope` → `app/not-found.tsx` (404, muted, a way back). Skeleton: each `loading.tsx` is the streamed Suspense fallback in every response. With the RPC refused, `/share/<token>` with the right password still answers the one sentence.

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

| `public.sends`, `public.send_recipients`, `public.provider_batches`, enums `send_status` / `send_source`, `internal.recipient_classification(campaign)`, `public.recipient_preview(campaign)` | `0006_sends.sql` | send records + the exact recipient preview (Story 4.1); `authenticated` holds SELECT only |
| `public.confirm_send(campaign, expected_count)` | `0007_confirm_send.sql` | confirm exactly once (Story 4.2): owner-only, brand-checked, freezes the snapshot + `body_sha256` |
| `public.dispatch_take_lease(send)`, `dispatch_recipients(send)`, `dispatch_record_result(send, batch_id, accepted_ids[], rejected_count)`, `dispatch_mark_failed(send, reason)` | `0008_dispatch.sql` | the Edge Function's four service-role-only functions (Story 4.3): the 10-min lease with the attempts cap, the one-row ordered snapshot, the 2xx outcome (`accepted ∩ recipients`, `reporting`/`partial`, `provider_batches`), the 4xx outcome — every transition CAS on `status = 'dispatched' and batch_id is null` |
| `internal.dispatch_sweep()`, cron job `dispatch-sweep` (`*/5 * * * *`, disabled by 0009, **enabled by 0013**) | `0009_cron_dispatch.sql` | pg_cron + pg_net sweep (Story 4.3): 3 attempts + expired lease → `partial`; re-invokes `dispatch-send` for stale `confirmed|dispatched` sends with the Vault `cron_secret`; enable after the Story 6.1 probe |
| `internal.import_send_log(run_id uuid) → jsonb` | `0010_send_log.sql` | the seed send-log importer (Story 4.5): reject `wrong_column_count` / `blank_batch_key`, collapse by `batch_key` (last row wins, `duplicate_batch_key` warn per superseded row), reject `unknown_campaign` (file brand only) / `unparseable_queued_at` / `unparseable_recipient_count`; inserts `sends` with `source = 'seed_send_log'`, `status = 'complete'`, `confirmed_at = dispatched_at = queued_at`, `on conflict (batch_key) do nothing`; run last by `pnpm seed` as `postgres`; not exposed |
| `internal.trg_events_suppress()` + trigger `trg_events_insert_suppress` on `events` | `0012_events_ingest.sql` | AFTER INSERT `when (contact_id is not null and type in (bounced, unsubscribed, complained))`: `contacts.suppressed_at = coalesce(occurred_at, now())` set when null, moved only earlier (same moment: unsubscribed > complained > bounced), never cleared (Story 6.2, D-4 / S10); the migration backfills the seed events (S4) |
| `internal.ingest_provider_events(send_id, batch_id, events jsonb) → (inserted, duplicates, foreign_recipient, unknown_type, last_event_id)` | `0012_events_ingest.sql` | one page of a provider batch: advisory lock per batch (`send_in_progress`), brand / campaign from the send, recipients only through the send's `send_recipients` (anyone else dropped + counted), `type` via `normalize_event_type` (`unknown` kept), `occurred_at` verbatim, `event_id = <batch_id>:<provider id>`, `on conflict do nothing`; not exposed |
| `internal.recipient_state(send_id, contact_id) → text`, `internal.complete_sends() → int`, `internal.try_timestamptz(text)` | `0012_events_ingest.sql` | terminal state by precedence (unsubscribed / complained > bounced > delivered); `reporting → complete` 24 h after `dispatched_at`; lenient ISO-8601 reader (null, never an error) |
| `internal.poll_log`, enum `internal.poll_status` (`requested, running, ok, failed, auth_error, rate_limited, provider_error, deferred`) | `0012_events_ingest.sql` | one row per poll run (Story 6.3 writes it); unexposed schema, no grant, no `brand_id` (poller health is global) |
| `public.v_last_sync`, `public.last_poll_status()` | `0012_events_ingest.sql` | `(brand_id, max(last_ok_at))` over `provider_batches` (`security_invoker`); the newest run's `(status, finished_at)` — secdef over `internal.poll_log`, `authenticated` only, in both tenancy allow-lists |
| `public.v_campaign_performance` (recreated) | `0012_events_ingest.sql` | Story 3.1's `reported` row per campaign **plus** one `source = 'portal'` row per dispatched portal send (`sent = accepted_count`, distinct-per-contact delivered / bounced / unsubscribes, total opens / clicks, rates over `sent`, `dispatched_at` appended); seed send-log sends get no row |
| `public.dispatch_mark_partial(send, reason)` | `0012_events_ingest.sql` | service-role CAS `confirmed\|dispatched` (no `batch_id`) `→ partial` + `failure_reason` — the Edge Function's 5xx / timeout exit while `DISPATCH_RETRY_ENABLED` ≠ `on`, and the sweep's cap (`dispatch_outcome_unknown_after_3_attempts`) / 24-h ceiling (`dispatch_expired`) stamp (Epic 4 review, D-7) |
| `internal.request_poll(window_hours) → bigint`, cron jobs `poll-events-5m` (`*/5`, 48 h), `poll-events-hourly` (`0 *`, 168 h), `poll-log-reconcile` (`*/5`) | `0013_cron_poll.sql` | one poll run: `poll_log (requested)` first, then `net.http_post <functions_url>/poll-events` with the Vault `cron_secret` and `{ poll_log_id, window_hours }` (60 s), `net_request_id` stored; missing Vault secret → `failed` / `missing_secret`; reconcile: `requested` / `running` older than 10 min → `failed` / `no_response`; also `cron.alter_job(dispatch-sweep, active := true)` (probe row a) |

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
