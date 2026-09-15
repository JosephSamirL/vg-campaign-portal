# Client Campaign Portal

A multi-tenant campaign portal for three brands (Kilele Rides, Karoo Coaches, Marrakech Express) built for the Velocity Growth Growth-Engineer build task. Each brand's marketing team signs in, sees only its own contacts, campaigns and dashboard, sends a campaign through the messaging provider, watches delivery reports come back, and can publish one campaign's results behind a password-protected link.

**Live:** https://vg-campaign-portal.vercel.app

**Contents** — a. stack, setup, deploy · b. Supabase URL + publishable key · c. inventory · d. key usage · e. where a send is recorded · f. manual Auth settings · g. AI tools · h. time taken · i. seed counts · j. contacts latency · k. what we tried to break · l. mobile audit · m. reachability + call-day checklist. Submission note: `docs/submission-note.md`; email template: `docs/submission-email.md`.

## a. Stack, setup, deploy

- **Next.js 16.3** (App Router, `proxy.ts` for session refresh) on **Vercel**
- **Supabase**: Postgres 17 with row-level security, Auth (email + password, Google), Cron (pg_cron + pg_net), Edge Functions
- **Tailwind CSS + shadcn/ui**
- **Vitest** (app-level tests) + **pgTAP** via `supabase test db` (database-level tests)
- Node 22 (`.nvmrc`), pnpm, Supabase CLI ≥ 2.117 (`brew install supabase/tap/supabase`), Docker (for the local stack)

The deployed app uses only the publishable key; the service-role key and the provider key never reach Vercel or the browser.

### Local: `supabase start` → `pnpm seed` → `pnpm dev`

```bash
nvm use                      # Node 22 (.nvmrc)
pnpm install
supabase start               # local Postgres 17 / Auth / PostgREST / Edge Runtime in Docker; applies supabase/migrations/* + seed.sql
eval "$(supabase status -o env | grep -E '^(API_URL|PUBLISHABLE_KEY|ANON_KEY|SERVICE_ROLE_KEY|SECRET_KEY|DB_URL)=')"
printf 'NEXT_PUBLIC_SUPABASE_URL=%s\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=%s\n' "$API_URL" "${PUBLISHABLE_KEY:-$ANON_KEY}" > .env.local
                             # the LOCAL stack's URL + publishable key — `pnpm dev` reads .env.local; `.env.example` only documents the names
NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-$SECRET_KEY}" DATABASE_URL="$DB_URL" pnpm seed
                             # users → stage the 11 CSVs → import contacts / campaigns / events / send log (~20 s; idempotent)
pnpm dev                     # http://localhost:3000 — sign in with a login from credentials.127.0.0.1-54321.txt
```

To point the app at the hosted project instead, put the README (b) URL + publishable key into `.env.local` (that is all `.env.example` asks for).

Fresh-clone rehearsal (what CI does on every push, in this order — `.github/workflows/ci.yml`):

```bash
git clone https://github.com/JosephSamirL/vg-campaign-portal && cd vg-campaign-portal && nvm use && pnpm install --frozen-lockfile
pnpm lint && pnpm exec tsc --noEmit && pnpm build          # ESLint incl. the admin fence · types · next build
pnpm schema:dump && git diff --exit-code -- schema.sql     # schema.sql = the concatenated migrations
supabase start && supabase db reset && supabase test db    # every migration applies from empty; 15 pgTAP suites, 1,867 assertions
eval "$(supabase status -o env | grep -E '^(API_URL|PUBLISHABLE_KEY|ANON_KEY|SERVICE_ROLE_KEY|SECRET_KEY|DB_URL)=')"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-$SECRET_KEY}" DATABASE_URL="$DB_URL" pnpm seed
bash scripts/ci-env.sh                                     # writes .env.test (local URL + key + the six logins from credentials.127.0.0.1-54321.txt)
supabase functions serve --env-file supabase/mock.env --no-verify-jwt &   # dispatch-send / poll-events against the provider mock
NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="${PUBLISHABLE_KEY:-$ANON_KEY}" pnpm test   # 31 files / 423 cases, 0 skipped
```

Without the seed, `.env.test` and the served functions, `pnpm test` still passes but the integration suites (`isolation`, `send-concurrency`, `ingestion`, `share-*`, `send-actions`, `health`) **skip** with a loud console line — far fewer than 423 cases run. The 423 is what a seeded stack with `.env.test` and the served functions gives (and what CI enforces: under `CI` those suites fail instead of skipping).

### Commands

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

### Hosted: `supabase db push` → `functions deploy` → `secrets set` → Vercel env

```bash
supabase link --project-ref qaocabdpaxetofqcfgsa
supabase db push                                   # migrations 0000–0015 (done; `supabase migration list` shows local = remote)
supabase functions deploy dispatch-send            # verify_jwt = false comes from supabase/config.toml
supabase functions deploy poll-events --no-verify-jwt
supabase secrets set PROVIDER_BASE_URL=https://dispatcher-production-72fc.up.railway.app PROVIDER_API_KEY=<the key from the brief's email> CRON_SECRET=<random> DISPATCH_RETRY_ENABLED=on
# SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL are injected by the platform — never set by hand
# Vault (SQL editor, once): the two secrets the pg_cron jobs read
select vault.create_secret('https://qaocabdpaxetofqcfgsa.supabase.co/functions/v1', 'functions_url', 'base URL of the Edge Functions');
select vault.create_secret('<the CRON_SECRET above>', 'cron_secret', 'x-cron-secret for dispatch-send / poll-events');
# Auth: sign-ups OFF, Site URL, Redirect URLs — `supabase config push` from a minimal config.toml (see (f)); Google provider = dashboard (manual)
# Seed (one-time, engineer's shell): the hosted seed load — see the exact command under (i) "Hosted full load pending"
```

Vercel: project `vg-campaign-portal` connected to the GitHub repo, auto-deploys `main` (production) and every branch (preview); environment variables are **exactly two** — `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`vercel env ls`). `vercel.json` adds the daily `/api/health` cron. Nothing else is configured on Vercel.

### Repo layout

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

## b. Supabase project URL and publishable (anon) key

Public by design — this is the key the browser bundle already ships:

| | |
|---|---|
| Project URL | `https://qaocabdpaxetofqcfgsa.supabase.co` |
| Project ref | `qaocabdpaxetofqcfgsa` (region eu-west-1) |
| Publishable key | `sb_publishable_z3hbM0IYQQIc4dQzC5B4Gg_0FPv9eML` |
| Data API | `https://qaocabdpaxetofqcfgsa.supabase.co/rest/v1/` (exposed schemas: `public`, `graphql_public`) |
| Auth | `https://qaocabdpaxetofqcfgsa.supabase.co/auth/v1/` |
| Edge Functions | `https://qaocabdpaxetofqcfgsa.supabase.co/functions/v1/{dispatch-send,poll-events}` |

The dashboard's *API Keys* page shows this `sb_publishable_…` key and the legacy `anon` JWT side by side — either is "the anon key"; they carry the same `anon` role. `sb_secret_…` (service role) is never handed over and no `sb_secret_` value appears in this repo (only the `.env.example` placeholder and a test dummy — see the sweep under (d)).

Grader rehearsal, straight against Supabase with one of the six logins:

```bash
URL=https://qaocabdpaxetofqcfgsa.supabase.co; PK=<publishable key above>
JWT=$(curl -s "$URL/auth/v1/token?grant_type=password" -H "apikey: $PK" -H 'Content-Type: application/json' \
      -d '{"email":"kilele.analyst@vg-eval.test","password":"<from the email>"}' | jq -r .access_token)
curl "$URL/rest/v1/contacts?select=count" -H "apikey: $PK" -H "Authorization: Bearer $JWT"   # → own-brand count only
curl "$URL/rest/v1/contacts?select=count" -H "apikey: $PK"                                    # anon → 42501 permission denied
curl -X POST "$URL/rest/v1/rpc/confirm_send" -H "apikey: $PK" -H "Authorization: Bearer $JWT" \
     -H 'Content-Type: application/json' -d '{"p_campaign_id":"<any Kilele campaign id>","p_expected_count":1}'   # analyst → P0001 not_owner
```

## c. Inventory — every table, view and function

From the live catalog (`pg_class` / `pg_proc` / `cron.job`, cross-checked against `schema.sql`, 2026-09-16). One line per object. Every `public` table: RLS **enabled + forced**, exactly one `select` policy in one of three shapes — `brand_id = (select current_brand_id())` on every tenant table; `id = (select current_brand_id())` on `brands`; the row's own `auth.uid()` on `app_users` — plus `metric_rules` (shared, no `brand_id`): `auth.uid() is not null`, any signed-in user; `SELECT` granted to `authenticated` only, nothing to `anon`; every view `security_invoker = true`; writes happen only through the listed RPCs or the service role. `internal` and `staging` are not exposed to the Data API and have no grants for `anon` / `authenticated`.

### `public` — tables (12)

| Table | Migration | What it holds |
|---|---|---|
| `public.brands` | `0001` | the three tenants (`code` KILELE / KAROO / MARRAKECH); inserted by the migration |
| `public.app_users` | `0001` | the allow-list: `email` pk, `brand_id`, `role` (`owner` / `analyst`), `auth_user_id`; policy `auth_user_id = auth.uid()` |
| `public.contacts` | `0002` | normalised contacts, natural key `(brand_id, external_id)`, `suppressed_at` / `suppressed_reason` (trigger), `deleted_at`, `suppressed_until`, `routed_from` |
| `public.campaigns` | `0002` | seed campaigns + `reported_*` counts, `parent_campaign_id` (within brand only) |
| `public.events` | `0002` | seed + provider events, natural key `(brand_id, source, event_id)`; trigger `trg_events_insert_suppress` (`0012`) |
| `public.import_runs` | `0003` | one row per imported staged file (`summary` jsonb) |
| `public.import_issues` | `0003` | the marketer-facing reject / warn / route report (`reason`, `row_no`, `detail`) |
| `public.metric_rules` | `0005` | the nine on-screen counting rules (`key`, `label`, `rule_text`, `alternative_text`); shared, signed-in read |
| `public.sends` | `0006` | one row per confirmed send / seed send-log batch: `status` lifecycle, `recipient_count`, `body_sha256`, lease, `batch_id`, `accepted_count` / `rejected_count`, `failure_reason` |
| `public.send_recipients` | `0006` | the frozen recipient snapshot per send (`contact_id`, `external_id`, `address`) |
| `public.provider_batches` | `0006` | the provider `batch_id` per send + the poller's cursor (`next_cursor`, `last_event_id`, `last_polled_at`, `last_ok_at`, `polling`) |
| `public.share_links` | `0011` | `token_hash` (sha256) + `password_hash` (bcrypt) per published campaign; column-level grant hides both hashes |

### `public` — views (7)

| View | Migration | What it shows |
|---|---|---|
| `public.v_contacts` | `0005` | non-deleted contacts with the computed `contactable` flag — the `/contacts` list |
| `public.v_dashboard_totals` | `0005` | `total_customers`, `contactable` per brand |
| `public.v_signups_30d` | `0005` (rewritten `0011`) | 30 zero-filled UTC days per brand + `future_dated_count` |
| `public.v_campaign_performance` | `0005` (recreated `0012`, `0015`) | one `reported` row per campaign + one `portal` row per dispatched send with a `batch_id` (counts, five unclamped rates) |
| `public.v_import_issue_groups` | `0003` | issue counts per run / severity / reason |
| `public.v_share_links` | `0011` | the seven non-hash columns + `status` (`active` / `expired` / `revoked`) |
| `public.v_last_sync` | `0012` | `(brand_id, max(last_ok_at))` — "Reports last synced" |

### `public` — functions (16)

| Function | Migration | Kind | Who may execute | What it does |
|---|---|---|---|---|
| `current_brand_id()` | `0001` | security definer | `authenticated` | **the isolation primitive**: `brand_id` of the caller's `app_users` row, null without a JWT |
| `current_app_role()` | `0001` | security definer | `authenticated` | `owner` / `analyst` of the caller |
| `normalize_event_type(text)` | `0002` | invoker, immutable | nobody exposed | provider / seed spellings → `event_type` enum (`unknown` otherwise) |
| `is_contactable(contacts)` | `0005` | invoker, inlined | `authenticated` | the Contactable rule as one predicate |
| `recipient_preview(uuid)` | `0006` | security definer | `authenticated` | the confirm screen's exact count + excluded-by-reason counts (`not_in_brand`, `invalid_input`) |
| `confirm_send(uuid, int)` | `0007` | security definer | `authenticated` | confirm exactly once: owner-only, brand-checked, `count_mismatch` guard, snapshot + digest, idempotent under concurrency |
| `dispatch_take_lease(uuid)` | `0008` | invoker | `service_role` | the 10-min lease, 3-attempt cap (CAS) |
| `dispatch_recipients(uuid)` | `0008` | invoker | `service_role` | the ordered snapshot as one jsonb row |
| `dispatch_record_result(uuid, text, text[], int)` | `0008` | invoker | `service_role` | the provider 2xx: `accepted ∩ recipients`, `reporting` / `partial`, `provider_batches` row, `duplicate_batch_id` guard |
| `dispatch_mark_failed(uuid, text)` | `0008` | invoker | `service_role` | the provider 4xx → `failed` (CAS) |
| `dispatch_mark_partial(uuid, text)` | `0012` | invoker | `service_role` | 5xx / timeout / cap / 24 h → `partial` with the reason (CAS) |
| `create_share_link(uuid, text, timestamptz)` | `0011` | security definer | `authenticated` | owner-only: 256-bit token (returned once), bcrypt password (≥ 8 chars, untrimmed), optional expiry |
| `revoke_share_link(uuid)` | `0011` | security definer | `authenticated` | owner-only, brand-checked, idempotent |
| `get_shared_results(text, text)` | `0011` | security definer | **`anon`**, `authenticated` | the stranger's door: one aggregate row or `share_denied` / `rate_limited` (10 per 15 min per token; bcrypt on every path) |
| `last_poll_status()` | `0012` (replaced `0015`) | security definer | `authenticated` | `(status, finished_at, requested_at)` of the newest poll run |
| `health_ping()` | `0014` | invoker | **`anon`** only | `select 'ok'` — the keep-alive probe behind `/api/health` |

`anon` may execute exactly `{get_shared_results, health_ping}` and select nothing; the tenancy suite (`0001_tenancy.test.sql` S5/S6/S7) pins these three allow-lists by `set_eq`.

### `internal` — tables (2) and functions (23); not exposed, no grants

| Object | Migration | What it does |
|---|---|---|
| `internal.poll_log` (table) | `0012` | one row per poll run: `status` (`poll_status` enum), `requested_at`, `finished_at`, `batches`, `pages`, `inserted`, `duplicates`, `error`, `net_request_id` |
| `internal.share_attempts` (table) | `0011` | the per-token wrong-password ledger (`token_hash`, `attempted_at`), pruned after 15 min |
| `normalize_consent / _status / _country / _brand_code / _signup_at / _email / _phone(text)` | `0003` | the FR-7 normalisers (7 functions), immutable; unknown → `null` |
| `normalize_spend(text)`, `normalize_int(text)` | `0004` | `221,09` → `221.09`; digits-only int4 |
| `import_contacts(uuid)` | `0003` (replaced `0012`) | the contacts importer: reject / route / warn / last-duplicate-wins / strictly-newer upsert |
| `import_campaigns(uuid)` | `0004` (replaced `0012`) | the campaigns importer + in-brand parent resolution |
| `import_events(uuid)` | `0004` (replaced `0012`) | the events importer (file-brand contact + campaign; follows routed contacts) |
| `import_send_log(uuid)` | `0010` (replaced `0012`) | the send-log importer → `sends` with `source = 'seed_send_log'`, `status = 'complete'` |
| `recipient_classification(uuid)` | `0006` | the shared recipient predicate (`not_contactable` / `no_address` / `country_mismatch_or_unknown` / recipient) |
| `dispatch_sweep()` | `0009` (replaced `0012`, `0015`) | pg_cron: cap → `partial`, 24 h → `partial` / `failed`, re-invoke `dispatch-send` via pg_net with the Vault `cron_secret` |
| `trg_events_suppress()` | `0012` | the AFTER INSERT trigger body: monotonic `contacts.suppressed_at` (earliest terminal event wins) |
| `ingest_provider_events(uuid, text, jsonb)` | `0012` (replaced `0015`) | one page of provider events: advisory lock, recipients only through the send's snapshot, `(batch_id, event_id)` dedupe, poison-safe; returns `(inserted, duplicates, foreign_recipient, unknown_type, last_event_id)` |
| `recipient_state(uuid, uuid)` | `0012` (replaced `0015`) | a recipient's terminal state by precedence (unsubscribed > complained > bounced > delivered) |
| `complete_sends()` | `0012` | `reporting → complete` 24 h after dispatch |
| `try_timestamptz(text)` | `0012` | lenient timestamp reader, null instead of an error |
| `request_poll(int)` | `0013` (replaced `0015`) | pg_cron: insert `poll_log (requested)`, then `net.http_post` to `poll-events` |
| `bounded_event_id(text)` | `0015` | a provider id verbatim ≤ 200 chars, else its sha256 hex |
| `backfill_suppression()` | `0015` | the trigger's rule, set-based and idempotent, over every stored terminal event |

### `staging` — tables (4); not exposed, no grants

`staging.stage_contacts`, `staging.stage_campaigns`, `staging.stage_events`, `staging.stage_send_log` (`0002`) — raw CSV records as `cols text[]` with `ncols`, `source_file`, `file_brand`, `row_no`, `had_nul`, `as_of`, `file_rank`, `run_id`; written only by `pnpm seed` over a direct DB connection.

### `cron.job` (4, all active on hosted)

| Job | Schedule | Command | Migration |
|---|---|---|---|
| `dispatch-sweep` | `*/5 * * * *` | `select internal.dispatch_sweep()` | `0009` (created disabled) / `0013` (enabled) |
| `poll-events-5m` | `*/5 * * * *` | `select internal.request_poll(48)` | `0013` |
| `poll-events-hourly` | `0 * * * *` | `select internal.request_poll(168)` | `0013` |
| `poll-log-reconcile` | `*/5 * * * *` | `requested` / `running` rows older than 10 min → `failed` / `no_response` | `0013` |

Enums: `public.app_role`, `event_type`, `event_source`, `issue_severity`, `send_status` (`pending, confirmed, dispatched, reporting, complete, partial, failed`), `send_source` (`portal, seed_send_log`); `internal.poll_status`. Trigger: `trg_events_insert_suppress` on `public.events`. Edge Functions (Deno, `supabase/functions/`): `dispatch-send`, `poll-events`.

### The same inventory by migration (as it grew, story by story)

_Grows as migrations land. Every `public` table: RLS enabled + forced, one `select` policy — `brand_id = (select current_brand_id())`, or `id = …` for `brands`, `auth.uid()` for `app_users`, `auth.uid() is not null` for `metric_rules` —, `SELECT` to `authenticated` only, nothing to `anon`; writes only through RPCs / service role._

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
| `internal.request_poll(window_hours) → bigint`, cron jobs `poll-events-5m` (`*/5`, 48 h), `poll-events-hourly` (`0 *`, 168 h), `poll-log-reconcile` (`*/5`) | `0013_cron_poll.sql` (replaced in `0015`) | one poll run: `poll_log (requested)` first, then `net.http_post <functions_url>/poll-events` with the Vault `cron_secret` and `{ poll_log_id, window_hours }` (60 s), `net_request_id` stored; missing Vault secret → `failed` / `missing_secret`; an exception from `net.http_post` → `failed` / `http_post: <error>` (the row is never rolled back — 0015); reconcile: `requested` / `running` older than 10 min → `failed` / `no_response`; also `cron.alter_job(dispatch-sweep, active := true)` (probe row a) |
| indexes `idx_send_recipients_send_id_external_id`, `idx_send_recipients_send_id_lower_address` | `0015_ingest_fixes.sql` | the recipient lookups behind `ingest_provider_events` (Epic 6 review [H]) |
| `internal.bounded_event_id(text)`, `internal.backfill_suppression() → int` | `0015_ingest_fixes.sql` | a provider id verbatim up to 200 chars, else its sha256 hex (keeps `<batch_id>:<id>` inside the btree row limit); the suppression trigger's rule set-based over every terminal event (earliest per contact; idempotent; called once by the migration — a no-op where 0012's backfill ran) |
| `internal.ingest_provider_events` / `recipient_state` / `dispatch_sweep` (replaced), `public.v_campaign_performance` (replaced) | `0015_ingest_fixes.sql` | recipients materialised once per call + hash join, the batch must be the send's (`invalid_input`), long ids bounded; `recipient_state` ranks unsubscribed 1 > complained 2 > bounced 3 > delivered 4; the sweep's (a1): never-leased `confirmed` older than 24 h → `failed` / `dispatch_expired`; the view: portal rows only for sends with a `batch_id`, delivered / bounced / unsubscribes = distinct contacts (`contact_id is not null`) |
| `public.last_poll_status()` (replaced) | `0015_ingest_fixes.sql` | now `(status, finished_at, requested_at)` — same grants (`authenticated` only, secdef over `internal.poll_log`); `requested_at` lets the campaigns page warn when the newest run is older than 20 min |

`0002_core_tables.sql` also opens with the schema-less `alter default privileges for role postgres revoke execute on functions from public` (Story-Time Amendment S17): a bare `create function public.f_probe()` now yields `has_function_privilege('anon', …) = false` — the per-schema line in `0000_grants.sql` could not subtract Postgres's built-in `PUBLIC` execute default. `supabase/tests/0002_core_tables.test.sql` re-runs that probe on every `pnpm test:db`.

### Exposed schemas

The Data API (PostgREST) exposes only `public` and `graphql_public` — `supabase/config.toml` `[api] schemas = ["public", "graphql_public"]` locally, and the same list under Project Settings → Data API → Exposed schemas on the hosted project.

`internal` (plpgsql helpers) and `staging` (raw seed rows) are created by `supabase/migrations/0000_grants.sql` with no `usage` for `public`, `anon` or `authenticated`. **They must never be added to the hosted Data API exposed schemas.** Nothing is ever created in `graphql_public`.

`0000_grants.sql` also runs `alter default privileges in schema public revoke …` for functions, tables and sequences. What that actually does: it strips Supabase's own per-schema default grants to `anon`/`authenticated` (verified in `pg_default_acl`) — nothing more. Postgres's built-in default (`execute` to `PUBLIC` on every new function) is global and a per-schema revoke cannot subtract from it, so that line never protected functions (Story-Time Amendment S17, found by the 1.3 probe below). The real control is therefore explicit: every function carries its own `revoke execute … from public, anon, authenticated` + `grant execute … to authenticated` (or nothing), and the tenancy suite's S5/S6 `set_eq` allow-lists fail the build if one is missing. The schema-less `alter default privileges for role postgres revoke execute on functions from public` that fixes the default itself landed in `0002_core_tables.sql` (Story 2.1). Every grant is explicit and visible in `schema.sql`.

## d. Key usage — which key lives where

| Key / secret | Where it lives | Where it never is |
|---|---|---|
| **Publishable key** (`sb_publishable_…`, role `anon`) | the browser bundle and Vercel env (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`), `.env.local`, `/api/health`, the `/share` anon client — **the only key the deployed app holds** | — (public by design) |
| **User JWT** | issued by Supabase Auth at sign-in, carried in the session cookie (`@supabase/ssr`), refreshed by `proxy.ts`; every portal read and every RPC runs as that user under RLS | never minted or stored server-side |
| **Service-role key** (`sb_secret_…`) | (1) the engineer's shell for `pnpm seed` (`SUPABASE_SERVICE_ROLE_KEY`, read only by `scripts/seed/*` through `lib/supabase/admin.ts` — an ESLint fence fails the build if any file outside `scripts/**` imports it — alias, relative, suffixed, `export … from`, dynamic `import()` or `require()`, and inside `lib/**` any `./admin` spelling); (2) `SUPABASE_SERVICE_ROLE_KEY` as injected by the platform into the two Edge Functions (`dispatch-send` uses it for the `dispatch_*` RPCs after authenticating the caller itself) | **not** in Vercel env (`vercel env ls` shows the two `NEXT_PUBLIC_*` only), not in git, not in `.env.example` as a value, never in the browser |
| **Provider key** (issued in the brief's email) | Edge Function secret `PROVIDER_API_KEY` (`supabase secrets set`), read only by `supabase/functions/_shared/provider.ts`; a copy in the git-ignored `supabase/.env` was used once for the deliberate live probe (Story 6.1) | not in Vercel, not in git, not in the browser, not in `docs/provider-api.md`; the submission email carries it |
| **`CRON_SECRET`** | Edge Function secret + Vault `cron_secret` (pg_cron → pg_net → the functions' `x-cron-secret` header) | not in git (`supabase/mock.env` carries the local-only `local-cron-secret`) |
| **`SUPABASE_DB_URL`** | platform-injected into Edge Functions (`poll-events` opens a direct connection for `internal.*`); cannot be set by hand | — |
| **Database password** | only in the engineer's shell for the one-time hosted `pnpm seed` (`DATABASE_URL` over the session pooler) | not in any file |
| **The six + one login passwords** | git-ignored `credentials.<host>.txt` / `credentials.txt` (mode 0600), written by `pnpm seed`; the submission email | never printed by the script, never in git |

Sweep (re-run 2026-09-16, tree **and** full history): a value-shaped `grep -oE` over `git log -p --all` for the three key shapes (`sb_secret_` followed by 20+ key characters, the provider-key prefix followed by 8+, a JWT `eyJhbGciOi…`) returns nothing; the name-shaped `git grep -iE` for `sb_secret_`, the provider-key prefix and `service_role_key=` (excluding `docs/provider-api.md`) hits only the `.env.example` placeholder (`sb_secret_xxx`), a test's deliberate dummy (`tests/health-route.test.ts`: `sb_secret_must_never_be_used`), shell-variable names in `scripts/ci-env.sh` and documentation sentences (this README, `supabase/config.toml`, the `dispatch-send` header comment). `git ls-files` tracks no `.env*` (except `.env.example`), no `credentials*`, no `submission-email.txt`; `git check-ignore` confirms each.

## e. Where a send's progress and results are recorded

Everything after the button is a row you can read with the publishable key and a user JWT (RLS-scoped), or with the SQL editor:

| Where | What you see |
|---|---|
| `public.sends` | one row per confirmed send: `status` (`confirmed → dispatched → reporting → complete`, or `partial` / `failed`), `recipient_count`, `confirmed_by` / `confirmed_at`, `body_sha256` (the digest of the frozen recipient list), `dispatch_attempts` / `dispatch_lease_until` / `dispatched_at`, `batch_id` (the provider's), `accepted_count` / `rejected_count` / `provider_responded_at`, `failure_reason` |
| `public.send_recipients` | the exact recipient snapshot (`contact_id`, `external_id`, `address`) — what was POSTed, in `contact_id` order |
| `public.provider_batches` | the provider `batch_id` per send and the poller's bookkeeping: `next_cursor`, `last_event_id`, `last_polled_at`, `last_ok_at`, `polling` |
| `public.events` (`source = 'provider'`) | every delivery report ingested, `event_id = <batch_id>:<provider id>`, `send_id`, the raw payload in `raw`; deduplicated on `(brand_id, source, event_id)` |
| `public.contacts.suppressed_at` / `suppressed_reason` | the monotonic result of `bounced` / `unsubscribed` / `complained` reports |
| `public.v_campaign_performance` (`source = 'portal'`) | the live counts and rates per dispatched send — what the campaign pages show beneath the campaign's `reported` row |
| `internal.poll_log` + `public.last_poll_status()` + `public.v_last_sync` | every poll run (`ok` / `deferred` / `rate_limited` / `provider_error` / `auth_error` / `failed`, batches, pages, inserted, duplicates, error) and the per-brand "Reports last synced" instant |
| `public.import_runs` / `public.import_issues` | the seed loads (what loaded, what was rejected and why) — `/imports` in the app |
| In the app | `/campaigns/[id]` → the send history card (status badge, timestamps, approver, count, `batch_id`, accepted / rejected, live figures or "No reports yet", `failure_reason`); `/campaigns` → a portal-send row beneath each campaign + "Reports last synced …"; both pages warn when the poller has not succeeded / not run |
| Edge Function logs | one JSON line per step (`auth`, `load`, `lease`, `recipients`, `hash`, `post`, `record_result` / `mark_failed`; the poller's `page`, `ingest`, `finish`) — Supabase Dashboard → Edge Functions → Logs |

**Reconciliation query** (SQL editor, or PostgREST as the brand's user):

```sql
select s.id, s.status, s.recipient_count, s.accepted_count, s.rejected_count, s.confirmed_by, s.confirmed_at,
       s.dispatched_at, s.provider_responded_at, b.batch_id, b.last_ok_at
from public.sends s left join public.provider_batches b on b.send_id = s.id
where s.campaign_id = '<id>' order by s.created_at desc;
-- then: GET https://dispatcher-production-72fc.up.railway.app/v1/messages/<batch_id>/events with the provider key
--       = the same record the poller ingested: select count(*) from public.events where send_id = '<send id>' and source = 'provider';
```

`Idempotency-Key` for every POST is `send-<send id>`, so the provider's own record and ours are joined by the send id as well as by `batch_id`.

### Dispatch (Story 4.3)

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

### Polling the reports (Story 6.3)

Delivery reports are fetched on a schedule and shown honestly. `0013_cron_poll.sql`:

| Job | Schedule | What |
|---|---|---|
| `poll-events-5m` | `*/5 * * * *` | `internal.request_poll(48)` — batches dispatched in the last two days |
| `poll-events-hourly` | `0 * * * *` | `internal.request_poll(168)` — the last week (late / re-appended items, probe row c) |
| `poll-log-reconcile` | `*/5 * * * *` | rows still `requested` / `running` after 10 min → `failed` / `no_response` |
| `dispatch-sweep` | `*/5 * * * *` | **enabled here** (0009 created it disabled): the probe showed a replayed `Idempotency-Key` returns the same `batch_id` (row a); `DISPATCH_RETRY_ENABLED=on` is set in the same step, so a provider 5xx / timeout leaves the send `dispatched` under its lease for the sweep instead of `partial` at once |

`internal.request_poll(window_hours)` (security invoker, cron only — nothing in `internal` is definer) inserts `internal.poll_log (status = 'requested')` **first**, then `net.http_post(<functions_url>/poll-events, x-cron-secret, { poll_log_id, window_hours }, timeout 60 s)` with both values from Vault and stores `net_request_id`; a missing Vault secret marks the row `failed` / `missing_secret` and queues nothing.

**`supabase/functions/poll-events`** (`verify_jwt = false`; `x-cron-secret` only) opens a **direct Postgres connection** over the platform-injected `SUPABASE_DB_URL` (`_shared/db.ts`, `npm:postgres`) — `internal.*` is unexposed to PostgREST and a transaction-scoped advisory lock has to survive the provider round-trips. `poll_log → running` (CAS from `requested`; a re-delivered request answers 409), then every `provider_batches` row whose send was dispatched inside the window, **whatever `sends.status`** (a `partial` send still gets reports), oldest-polled first; per batch one transaction: `pg_try_advisory_xact_lock(hashtext(batch_id))` (false → skip) and ≤ 10 pages by the probe's cursor rules — `since` carries only the stored `next_cursor` (never an event id: the real provider ignores one and replays the stream, which ingest's `(batch_id, event_id)` dedupe absorbs), page → `internal.ingest_provider_events` → **compare-and-set** cursor update (`next_cursor is not distinct from <value read before the page>`; the last non-null cursor is kept even when the closing page says `null`), stop on an empty page / null cursor / unchanged cursor / `has_more = false`, never on `has_more` alone; `has_more = true` + null cursor → `cursor_contract_violation`. 401 → `auth_error` (run aborted); 429 / 503 → `Retry-After` (header → body `retry_after` → 5 s): ≤ 10 s inside the 50-s budget is waited out, otherwise **that batch** is `rate_limited` / `deferred` with its cursor and `last_polled_at` untouched (it heads the next run) and the run goes on — only a 401 aborts a run (Epic 6 review); 404 / other 4xx / 5xx / timeout (20 s) / a malformed 2xx → `provider_error` for that batch, next batch; an exception inside a batch (ingest raising, a deadlock) rolls that batch back, records `provider_error:<batch>:<message>`, bumps `last_polled_at` outside the rolled-back transaction and continues. No new batch after 50 s, and no new **page** either (ten 20-s timeouts must never outlive pg_net's 60 s). Every run ends with `internal.complete_sends()` and `poll_log (status, finished_at, batches, pages, inserted, duplicates, error)` — compare-and-set on `status = 'running'`, so a row `poll-log-reconcile` already closed keeps its verdict; one JSON log line per step.

**The pages.** `/campaigns` and `/campaigns/[id]` read `v_last_sync` (`Reports last synced 3 minutes ago`, the UTC instant in the title; "Reports not synced yet" when the brand has a batch but no page has landed; the placeholder while the brand has no portal send at all) and `last_poll_status()` (`status, finished_at, requested_at`): a newest run outside `ok / requested / running / deferred` adds the muted line "Report sync has not succeeded since {last success | the portal went live}", and a newest run **older than 20 minutes** — whatever its status — adds "Report sync has not run since {then}" (a poller that stopped is visible, not silent); a failed read of either renders the destructive "Sync status unavailable" — never a fake "synced". Portal sends show live delivered / bounced / opened / clicked / unsubscribed counts and the view's rates beneath their campaign (list) and inside the send's history card (detail); a send with no report yet reads "No reports yet", not zeros; a send whose figures the page could not read says "Figures unavailable"; a `partial` with no `batch_id` (nothing was ever submitted) gets no figures block at all.

**Local loop.** `supabase functions serve --env-file supabase/mock.env --no-verify-jwt` serves both functions; `tests/ingestion.test.ts` builds a synthetic brand + a five-recipient send, records batch `B-ING-<n>`, programs the mock (`POST /__mock/batches/:batch_id { events, page_size, shuffle, duplicate_across_pages, released }`) and runs `poll-events` against it; `POST /__mock/config { events_status, events_fail_next, events_retry_after, events_malformed_next, events_null_cursor }` forces 503 / 429 / 401 / 404, a non-JSON 200 or `has_more` with a null cursor on the report stream (`endless: true` in a batch program never closes it — the page-cap drill), `GET /__mock/reads` lists every GET the poller made. The two send suites share a `mkdir` lock (`.vitest-locks/`, git-ignored) so their batches never sit in one poll window. Hosted: `supabase functions deploy poll-events --no-verify-jwt`, `supabase secrets set DISPATCH_RETRY_ENABLED=on`, the two Vault secrets (`functions_url`, `cron_secret`), `supabase db push`; then `select * from internal.poll_log order by id desc limit 5` and `select jobname, active from cron.job`.

## f. Manual Auth settings

`/login` offers email + password and "Continue with Google"; both are server actions (`app/(public)/login/actions.ts`). `proxy.ts` refreshes the Supabase session on every matched request and sends anonymous requests to `/login`; its matcher excludes `/share`, `/api/health`, `/login`, `/auth` and Next internals (`tests/proxy-matcher.test.ts`). `app/(portal)/layout.tsx` loads the caller's `app_users` row once per render (`lib/current-user.ts` — `role` is the single source for hiding owner controls) and signs out any session that has no row via `/auth/signout?reason=no_access`. The Google round-trip returns to `/auth/callback`: a refused account (sign-ups OFF) arrives as `?error=…` and lands on `/login?reason=not_allowed`; a pre-created one arrives as `?code=…` and lands on `/dashboard`.

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

## g. AI tools used

Claude Code (Anthropic's CLI agent, model Claude Opus 5) drove the whole build with the **BMad method** — plainly: the agents did the typing, Joe directed, reviewed and did every GUI-only step (Supabase / Vercel / GitHub accounts, `supabase link`, the Google Cloud console). The chain was:

1. **PRD** (`_bmad-output/planning-artifacts/prds/…/prd.md`) from the brief, the seed files and the provider docs, with a reconcile-against-the-brief pass and a rubric review that surfaced the counting-rule ambiguities (blank consent, routed rows, seed events as suppressions) — each resolved with Joe and written down.
2. **Architecture** (`architecture.md`): the decisions D-1 … D-14 (RLS + `current_brand_id()` as the isolation primitive, SQL-only import rules, the send lease, the share door), then an **adversarial review** and an **edge-case hunt** (`review-architecture-adversarial.md`, `review-architecture-edge-cases.json`) whose findings became the "Step-3" and "Story-Time" amendments.
3. **28 stories** in 7 epics (`epics.md`, one story file each under `_bmad-output/implementation-artifacts/`), every story carrying its own Dev Notes, tests-first tasks and a mutation drill.
4. **Dev / review loops**: each story implemented by a dev agent (red → green → refactor, pgTAP + Vitest), then reviewed by a separate adversarial code-review run (Blind Hunter, Edge Case Hunter, Acceptance Auditor sub-agents) whose Medium / High findings were fixed in a follow-up commit before the story was marked done. Up to three dev agents worked in parallel on one working tree; the provider probe (Story 6.1) was the one deliberate call to the real provider.

No other AI tool was used. Everything the agents produced is in git history (46 commits before this submission pack) and in the story files' Dev Agent Records, including what they got wrong along the way (the 119.17 vs 119.16 slip, the ineffective per-schema default-privilege revoke, the `.bind()` no-JS hang, the dev-log password leak).

## h. Time taken

Wall-clock, from the artifact and commit timestamps — honest framing: this is the human's elapsed time; agent-hours were higher because several agents ran in parallel.

| Phase | When | Wall-clock |
|---|---|---|
| Planning — PRD, reconcile, rubric review, architecture, adversarial + edge-case reviews, epics / 28 stories, sprint plan | 2026-09-14, ~00:00 → 03:40 local (Cairo) | **~4 h** |
| Build — 46 commits from the untouched `create-next-app` starter (`431a43a`, 10:44) to the last review-fix commit (`343e192`, 23:58), Epics 1 → 7, hosted pushes and deploys, the provider probe | 2026-09-15 | **~13 h** |
| Submission pack — this README, `docs/submission-note.md`, `docs/submission-email.md`, the secret sweep, the tag | 2026-09-16 | ~1.5 h |

Not included: the hosted seed load and the Google provider toggle, which are still pending (see `docs/submission-note.md`, "What isn't finished").

## i. Seed counts per brand — loaded / rejected / routed / warned

Summary (local full load, 2026-09-15; the hosted tables stay empty until the hosted `pnpm seed` runs — see *Hosted full load pending* below):

| | KILELE | KAROO | MARRAKECH |
|---|---|---|---|
| contacts loaded | **82,600** | **12,718** | **918** |
| contacts rejected / routed out / routed in | 71 / 312 / 88 | 46 / 88 / 312 | 15 / 0 / 0 |
| contacts warned (rows / warnings, base file) | 25,125 / 27,378 | 502 / 502 | 24 / 24 |
| campaigns loaded (staged) | **44** (46) | **19** (19) | **6** (6) |
| events loaded / in-file duplicates / `unknown_campaign` | **303,588** / 8,412 / 0 | **69,100** / 4,900 / 0 | **940** / 0 / 633 |
| send-log sends (9 staged rows) | **7** | — | — |
| contactable after the Story 6.2 suppression backfill | **36,446** | **501** | **230** |

### Seed load counts

`pnpm seed --only=stage` reads the eleven files in `docs/data/` through the per-file dialects in `scripts/seed/dialects.ts` (delimiter, encoding, header map, decimal-comma columns, hard-coded `as_of` / `file_rank`) and COPYs them into `staging.stage_*` over `DATABASE_URL` — the Supavisor **session** pooler (port 5432) for the hosted project, `postgresql://postgres:postgres@127.0.0.1:54322/postgres` against `supabase start`. TypeScript only *parses* (BOM, NUL bytes, RFC-4180 quoting, trim, reorder into canonical column order, `221,09` → `221.09`); every keep/reject rule is SQL (Stories 2.3/2.4). One staging row per CSV **record** (a quoted `notes` spanning two lines is one row, `row_no` = its first line), blank lines skipped, ragged records kept with their `ncols`, NULs stripped and flagged `had_nul`, the repeated header at Kilele line 40007 staged as an ordinary record. Re-staging a file deletes that file's rows first (never `truncate`), with a fresh `run_id` per file.

#### Smoke (`pnpm seed --only=stage --sample=10`)

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

#### Full staging (local, 2026-09-15)

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

#### Import — contacts (local, 2026-09-15)

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

#### Import — campaigns and events (local, 2026-09-15)

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

#### Full load — `pnpm seed` twice (local, 2026-09-15)

`pnpm seed` with no flags ran users → stage (11 files, 489,192 rows) → import (contacts ×4 → campaigns ×3 → events ×3), each file under a fresh `run_id`, in **27.0 s** the first time (campaigns / events from empty tables; contacts already loaded so their runs report `unchanged`) and **18.5 s** the second (Kilele events 13.3 s → 7.1 s: the second pass only probes the unique index). Both exited 0. Table counts before and after the second run are identical — `contacts` 96,236 / `campaigns` 69 / `events` 373,628 — and the second set of ten `import_runs` all report `inserted 0, updated 0` (contacts / campaigns: `unchanged = candidates`; events: `already_present = candidates`). Per brand:

| | KILELE | KAROO | MARRAKECH |
|---|---|---|---|
| contacts loaded (rows in table) | **82,600** (80,832 base + 1,680 delta + 88 routed in from Karoo) | **12,718** (12,406 own + 312 routed in from Kilele) | **918** |
| contacts rejected / routed out / routed in | 71 / 312 / 88 (base; delta 0 / 0 / 0 — 2,500 updated, 1,680 inserted) | 46 / 88 / 312 | 15 / 0 / 0 |
| campaigns | **44** (46 staged, 2 duplicate warnings; 8 `KE`) | **19** (1 `parent_not_in_brand`) | **6** (`spend` from decimal comma) |
| events inserted / in-file duplicates / `unknown_campaign` | **303,588** / 8,412 / 0 | **69,100** / 4,900 / 0 | **940** / 0 / 633 |
| `unknown_contact`, `event_follows_routed_contact` | 0, 0 | 0, 0 | 0, 0 |

Every number equals the architecture's expected table (S16 / Story 2.4 Dev Notes) — no deviation. Least-sure candidates for the submission note: the 633 Marrakech events whose `campaign_external_id` names no Marrakech campaign (loaded, `campaign_id null`, excluded from campaign performance); the two byte-identical Kilele campaign pairs collapsed to one row each; Karoo `CMP-014` whose parent pointer `KIL-0007` lives in Kilele (pointer dropped); the 8,412 / 4,900 duplicate event ids (byte-identical rows, one kept). Each has a pgTAP case in `supabase/tests/0004_import_campaigns_events.test.sql` (134 cases: both normalisers, every reject / warn reason, cross-brand parent, follow-a-routed-contact, `campaign_id` never resolved by `external_id` alone, idempotency with a fresh and with the same `run_id`).

**Hosted full load pending: needs DB password.** Every migration is pushed (`supabase migration list`: `0000–0015` local = remote). The seed itself runs over the Supavisor **session** pooler with the project's database password (`SUPABASE_DB_PASSWORD` is not in this environment); exact command, from the repo root with Node 22:

```bash
# hosted — one-time engineer-run job over the session pooler (port 5432, needed for COPY and the long import calls)
NEXT_PUBLIC_SUPABASE_URL=https://qaocabdpaxetofqcfgsa.supabase.co \
SUPABASE_SERVICE_ROLE_KEY="$(supabase projects api-keys --project-ref qaocabdpaxetofqcfgsa --reveal -o json | jq -r '.[] | select(.type=="secret") | .api_key')" \
DATABASE_URL="postgresql://postgres.qaocabdpaxetofqcfgsa:${SUPABASE_DB_PASSWORD}@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" \
pnpm seed
```

Expected output: the tables above (the hosted `contacts` start empty, so the four contacts runs report the first-load numbers from *Import — contacts*). Run it twice and paste both `Import summary` tables here in place of this paragraph.

#### Import — send log (local, 2026-09-15)

`supabase/migrations/0010_send_log.sql` (`0006_sends.sql` is frozen on hosted — amendment S20) adds `internal.import_send_log(run_id)`, the last importer in the D-3 order (it needs the brand's campaigns). Reject `wrong_column_count` (`ncols <> 5`) / `blank_batch_key`; collapse by `batch_key` — the last row (highest `row_no`) wins and every superseded row gets one warn `duplicate_batch_key` and is never judged further; then on the surviving row reject `unknown_campaign` (looked up in the **file** brand only), `unparseable_queued_at` (`internal.normalize_signup_at`, ISO-8601 UTC), `unparseable_recipient_count` (`internal.normalize_int`). Insert `sends(brand_id, campaign_id, source = 'seed_send_log', batch_key, status = 'complete', recipient_count, confirmed_at = dispatched_at = queued_at_utc)` with `on conflict (batch_key) do nothing` — the unique constraint on `sends.batch_key` is the idempotency key, `already_present = candidates − inserted`. The file's `status` column is always `sent` and is not stored; `confirmed_by` / `body_sha256` / `batch_id` / `accepted_count` stay null. `complete` is terminal, so a seed send never blocks a later portal send of the same campaign (FR-21). Send-log batches are send **history**, never a rate denominator: `v_campaign_performance` still reads the campaign's `reported_*` — `BATCH-0007` carries 9,800 recipients while KIL-0016 reports `reported_sent` 10,640, and the page keeps 10,640 (delivered rate 95.00%, caption "as reported by the source").

`pnpm seed` twice (users → stage → the 11 imports, 19.7 s then 19.9 s, both exit 0); the send-log line each time:

```
import kilele-send-log.csv  staged 9  loaded 7  inserted 7  rejected 0  routed 0  warnings 2   (first run)
import kilele-send-log.csv  staged 9  loaded 7  inserted 0  rejected 0  routed 0  warnings 2   (second run — already_present 7)
```

9 staged rows → **7 sends** (`BATCH-0001`…`BATCH-0007`, one per Kilele campaign KIL-0012 / KIL-0044 / KIL-0007 / KIL-0021 / KIL-0031 / KIL-0009 / KIL-0016, `recipient_count` and `confirmed_at = dispatched_at` byte-for-byte the CSV's values); `BATCH-0003` ×3 (CSV lines 3, 6, 7 — byte-identical) collapsed to one send (line 7 wins) with 2 `duplicate_batch_key` warnings on rows 3 and 6 (`row_no` = the CSV line, header = 1); **0 rejected** (every campaign resolves in KILELE, every stamp and count parses). The second run inserted 0 (`already_present 7`), `select count(*) from sends where source = 'seed_send_log'` = 7 before and after; the per-brand verification table now ends with `seed_sends` = KILELE 7 / KAROO 0 / MARRAKECH 0. pgTAP `supabase/tests/0010_send_log.test.sql` (68 cases) pins the function's shape and grant surface, every reject / warn reason with its `detail`, the collapse (last row wins, a superseded row is only warned even when its own values are bad), the inserted row's fields, idempotency with the same and with a fresh `run_id` (zero rejects in the second run), a pending portal send next to a complete seed send, the campaign's `reported_*` untouched, another brand's file, and RLS on the result.

#### Events ingest + suppression backfill (Story 6.2, local, 2026-09-15)

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

## j. Contacts view — latency at the full load

_NFR-3: every portal page answers in under 2 s at the full load. **Local production build, full data** — `next build` + `next start` against the local stack with the complete seed load (Kilele 82,205 live contacts), signed in as the Kilele analyst, `curl -w '%{time_total}'`, one warm-up then ten timed requests per URL (Story 3.3). **Hosted re-measure pending seed load**: the hosted project has no contacts until the seed runs there, so a hosted timing today would measure an empty view — re-run the three URLs against https://vg-campaign-portal.vercel.app once it exists and replace this table._

| URL (Kilele analyst) | p50 | max of 10 (≈ p95) |
|---|---|---|
| `/contacts` (page 1 of 1,645) | 48 ms | 53 ms |
| `/contacts?q=ami` (6,306 matches, 127 pages) | 153 ms | 165 ms |
| `/contacts?contactable=true&page=800` (page 800 of 1,026) | 57 ms | 58 ms |

`explain analyze` of the `q=ami` page query as the analyst, under RLS through the `security_invoker` view: **72.9 ms** (brand-scoped scans; no extra index added — the trigram / `text_pattern_ops` indexes from `0002` are not what a contains-search uses, and the budget has 10× headroom). Same build, same session (3.2 / 3.4 review runs): `/dashboard` p50 42 ms / max 50 ms, `/campaigns` p50 42 ms / max 50 ms, `/campaigns/<id>` p50 31 ms / max 35 ms. `next dev` requests are 0.1–0.7 s and are not the measurement.

## k. What we tried to break

Every drill, one line each — attack → expected → observed → where it is pinned. The long-form entries that each story wrote as it landed follow below, unchanged.

| # | Attack | Expected | Observed | Pinned in |
|---|---|---|---|---|
| 1 | Sign in as the KILELE analyst and select every exposed table / view through PostgREST; the same as `anon` | own-brand rows only; anon refused | 17 relations: only KILELE `brand_id`s, `share_links` hashes refused (`42501`), anon `42501` everywhere (never an empty array) | `tests/isolation.test.ts` (38); pgTAP B7 / B8 in `supabase/tests/0001_tenancy.test.sql` |
| 2 | `alter table … disable row level security` on `brands`, `contacts`, `metric_rules`, `sends` | the isolation test fails | `not ok S1 …` + `B3` / `B4` / `B8` leak lines (`have: KAROO,KILELE,MARRAKECH`); `tests/isolation.test.ts` → `expected ['KILELE','KAROO','MARRAKECH'] to equal ['KILELE']` | `0001_tenancy.test.sql`, `tests/isolation.test.ts` (Stories 1.3, 2.1, 3.1, 4.1) |
| 3 | Policy rewritten `using (true)` / dropped on `brands`, `events` | fails | `not ok S2 policy references current_brand_id/auth.uid` + `B8` | `0001_tenancy.test.sql` |
| 4 | `grant select … to anon`, column grants `(id, code)`, `grant update (role) … to authenticated`, `grant truncate`, `reset search_path` on the definer | fails | `S4` / `S4c` / `S4d` / `S4b` / `S7b` each named | `0001_tenancy.test.sql` |
| 5 | A new `public` function without its `revoke` (`f_probe`) / a `dispatch_*` grant to `authenticated` | fails | `S5` / `S6` / `S7 (Extra records: (f_probe))`; `G2` / `N1` in `0008` | `0001_tenancy.test.sql`, `0008_dispatch.test.sql` |
| 6 | A view recreated without `security_invoker` | fails | `S3` + `B8 other-brand rows = 0: public.v_contacts` | `0001_tenancy.test.sql` (3.1) |
| 7 | Analyst calls `confirm_send`, `create_share_link`, `revoke_share_link` (RPC and server action); unknown `sub` | `not_owner`, nothing written | `P0001 not_owner` on every path; `sends` / `share_links` unchanged | `0007` R1–R6, `0011` R1–R5, `tests/send-actions.test.ts`, `tests/share-actions.test.ts` |
| 8 | Owner names another brand's campaign / link / send id (RPC, page, Edge Function) | `not_in_brand` / not-found | `P0001 not_in_brand`; `/campaigns/<foreign id>` → the not-found tree with zero foreign strings; `dispatch-send` → `404` | `0006` B12, `0007` B13, `0011` B14 / B15, `tests/campaigns-page.test.ts`, `tests/send-concurrency.test.ts` |
| 9 | Confirm pressed twice, from two tabs, and two `confirm_send` calls in `Promise.all` (50,064 recipients) | one send | one `sends` row, both responses carry its id, `send_recipients` = `recipient_count`, one digest; a third confirm → the same id; stale count → `count_mismatch` with the true count as `hint` | `tests/send-concurrency.test.ts`, `0007` O16–O21 |
| 10 | Two `dispatch-send` invocations at once; a third after the batch is recorded | one POST | one `202` + one `skipped / lease_unavailable`; one `Idempotency-Key` at the mock; third → `batch_recorded` | `tests/send-concurrency.test.ts` |
| 11 | Tampered `body_sha256`; provider `422`; provider `503` / timeout; a 2xx without `batch_id`; a reused `batch_id` | no POST / `failed` / no re-POST / unknown outcome honest | `failed / body_hash_mismatch` with zero provider calls; `failed / provider_422`; stays `dispatched` under the lease (flag on) or `partial / provider_503_outcome_unknown` (flag off); `failed / duplicate_batch_id` | `tests/send-concurrency.test.ts`, `0008` / `0012` D6–D8 |
| 12 | Lease without `batch_id is null`, `mark_failed` without its CAS, recipients ordered by `external_id`, sweep without the 2-min age / the 3-attempt cap / the live-lease check | fails | `L6` / `Z1`, `M2` / `M3`, `R1` / `R3`, `V2` … `V6`, `W3` | `0008_dispatch.test.sql`, `0009_cron_dispatch.test.sql` |
| 13 | The same 20 provider events in order, reversed, shuffled, doubled; released in two halves across two poll runs; a third run | identical end state, zero re-inserts | `results_eq` on suppression, events, performance rows and `recipient_state` across all four; messy two-run `toEqual` clean single-run; third run `inserted 0` | `supabase/tests/0012_events_ingest.test.sql`, `tests/ingestion.test.ts` |
| 14 | A forged event for a real contact of another brand (`brand_code` lying), a same-brand contact not in the batch, `NOPE` | dropped and counted | `foreign_recipient` 3; brand B's contact stays contactable; widening the lookup to the brand fails I1 / I7 / V2 | `0012` I-block |
| 15 | Poison page elements (a string, a number, `null` type, key-less, a 5 kB `event_id`, a future `occurred_at`); a 5,000-event page against 35,000 recipients | nothing aborts; fast | every page ingests; the 5 kB id is stored as its sha256; 0.2 s (pinned < 5 s) | `0012`, `0015_ingest_fixes.test.sql` P1 / L1–L3 |
| 16 | `bounced` T2 then `delivered` T3; `complained` T3 arriving before `bounced` T2; the trigger's `WHEN` clause deleted | suppression monotonic | stays suppressed at T2 / `bounced`; only T1 fails (the function guards itself) | `0012` |
| 17 | The poller against 503 / 429 (`Retry-After` short and long), 401, 404, a non-JSON 200, an endless stream, `has_more` + null cursor, a concurrent run, an exception inside a batch, a `poll_log` row closed mid-run | honest statuses, no cursor damage | waited / `deferred` / `rate_limited` per batch, `auth_error` aborts, `provider_error` continues, 10-page cap, `cursor_contract_violation`, `batches 0`, `finish()` CAS keeps `no_response` | `tests/ingestion.test.ts` (15) |
| 18 | The share door as a stranger: guessed token, wrong / empty / null / leading-space / case-changed password, another link's password, revoked link, expired link | one identical sentence, nothing else | `share_denied` rows carry only the status; byte-identical failure markup; 20 timed requests each ~5.7 ms (bcrypt on every path — no token-existence oracle) | `0011_share.test.sql` N0–N9 / V1–V5, `tests/share-link.test.ts`, `tests/share-page.test.ts` |
| 19 | 11 wrong passwords in a row; 30 wrong passwords **concurrently** on one token; then the right password | `rate_limited` from the 11th; exactly 10 ledger rows | 10 × `share_denied` + `rate_limited` (the right password too, for 15 min); 30 concurrent → 10 + 20, ledger = 10 (per-token advisory lock) | `0011` N-block, `tests/share-link.test.ts`, 5.1 review |
| 20 | `anon` on `share_links` / `campaigns` / `contacts` / `create_share_link`; a signed-in owner opening `/share/<token>` | refused; no session upgrade | `42501`; the anon client holds no cookie, so the owner rides in as a stranger | `0011` T8, `tests/share-link.test.ts`, `tests/share-page.test.ts` |
| 21 | `get_shared_results` rewritten to skip bcrypt for unknown tokens (keeping one textual `crypt(`); the column-grant exception removed | fails | `N3 timing: the unknown_token path paid for a bcrypt`; `S4e` | `0011`, `0001_tenancy.test.sql` |
| 22 | `pnpm seed` run twice; a file re-staged under a fresh `run_id` and re-imported | zero new rows | `inserted 0, updated 0`, table counts identical (96,236 / 69 / 373,628 / 7) | README (i), `0003` / `0004` / `0010` I-blocks |
| 23 | Ragged rows, the repeated header at line 40007, NUL bytes, BOM, windows-1252, `;` + French headers, decimal comma, two-line quoted notes, invalid UTF-8, Arabic-Indic digits | staged / rejected / warned with a reason, never silently dropped | every count matched the pre-computed profile; invalid UTF-8 throws naming the file; `[0-9]`-only normalisers | `tests/stage.test.ts` (19), `0003` / `0004` / `0012` M1 |
| 24 | `coalesce` removed from `is_contactable`; `least(100, open_rate)` clamp added; `security definer` on `is_contactable` | fails | `C1` / `C12` / `V1` / `A4`; `V4` / `A11` (119.16) **and** `V2` / `V6` (`least(100, null)` is 100); `C13` (inlining lost) | `0005_metrics.test.sql` |
| 25 | Unknown Google account (sign-ups OFF) at `/auth/callback`; a valid session with no `app_users` row; `/login?reason=constructor` | refused, no session; signed out; no crash | `307 /login?reason=not_allowed`; `303 /login?reason=no_access` + cookie cleared; the prototype key renders the default copy (this one crashed hosted before the fix) | `tests/auth-callback.test.ts`, `tests/current-user.test.ts`, `tests/reason-copy.test.ts` |
| 26 | Matcher bypass: `/authors`, `/shareholders`, `/login-x`, `/api/healthz` signed out | redirected to `/login` | all `307` (the unanchored prefixes let them through before) | `tests/proxy-matcher.test.ts` (26) |
| 27 | Contacts search with `%`, `_`, `*`, `\`; `?page=99999`; `?page=abc&status=deleted&contactable=maybe`; `?q=a,b(c)"d\` | no PostgREST 400, no "all rows" | 0 rows for the metacharacters (escaped), honest past-the-end copy with a "last page" link, invalid params → defaults | `tests/contacts-query.test.ts`, `tests/contacts-page.test.ts` |
| 28 | Every PostgREST call refused (a chaos reverse proxy in front of the local API) on every route | error state, no number | four `RetryAlert`s and zero `metric-value` on the dashboard, `error.tsx` on contacts / imports, "Sync status unavailable"; one Retry recovers each | Story 7.1 audit, `tests/error-boundaries.test.ts` |
| 29 | `import "@/lib/supabase/admin"` added to the health route; a migration edited without `pnpm schema:dump` | CI fails | `no-restricted-imports` × 2, `git diff --exit-code -- schema.sql` → 1 | `tests/health.test.ts`, `.github/workflows/ci.yml` |
| 30 | The real provider (Story 6.1 probe, 3 POSTs / ~70 GETs, one synthetic recipient) | learn, not trust | replayed `Idempotency-Key` → same `batch_id`; `since=<event_id>` ignored (full replay); exact duplicate ids, `delivered` re-appended after `opened`, a forged event per batch for a contact outside it, `occurred_at` in the future, 503 with `Retry-After` on ~30 % of GETs, no 429 — every one became a rule in `0012` / `0013` | `docs/provider-api.md` `## Probe 2026-09-15` |
| 31 | Found and fixed along the way | — | `next dev` printed server-action arguments (the share password) → `logging.serverFunctions: false`; `.bind(null, token)` wedged Next 16.3.5 on a no-JS POST of the public share form (a one-curl DoS) → unbound form action; the per-schema `alter default privileges … revoke execute` is a no-op against Postgres's built-in `PUBLIC` default → schema-less revoke in `0002` + per-function revokes pinned by `S5`/`S6` | Stories 5.2, 5.3, 1.3 |

### The long-form entries, story by story

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
- **A Kilele-scale page** (Epic 6 review, `supabase/migrations/0015_ingest_fixes.sql`, `supabase/tests/0015_ingest_fixes.test.sql`) — the 6.2 reviewer measured 14 s for 1,000 events against 35,000 recipients: `ingest_provider_events` resolved every element with a correlated scan of the send's `send_recipients` (O(events × recipients)), and the real provider ignores `page_size`, so KIL-0016's first page (35,547 recipients, ≥ 35k events) would have run for hours inside one poll transaction, never committed, and repeated every five minutes. Now the send's recipients are materialised once per call into a keyed temp table (`external_id`, `lower(address)`) and the page is hash-joined against it, with two supporting indexes on `send_recipients`; pgTAP generates 35,000 contacts / recipients and a 5,000-event page inside the test transaction and pins **< 5 s** with `clock_timestamp()` (measured 0.2 s locally). Same migration: a 5 kB provider `event_id` (which made `<batch_id>:<id>` overflow the btree row limit and poison the page on every retry) is stored as its sha256 hex with the raw id in `raw`; a batch that does not belong to the send is `invalid_input`; key-less events no longer count as delivered / bounced recipients (V2's 116.67 % delivered rate is gone); a portal row exists only for a send with a `batch_id`; a never-leased `confirmed` send that expires is `failed` / `dispatch_expired`, not "partially sent — outcome unknown". The poller's drills are in `tests/ingestion.test.ts` now: the 10-page cap on an endless stream, a concurrent run skipping the locked batch (`batches 0`), `cursor_contract_violation` (page ingested, `last_polled_at` bumped, `last_ok_at` not), a non-JSON 200, 429 short / long (the long one leaves the batch `rate_limited` and the run continues), an exception inside the batch (a raising trigger on `events`: caught per batch, `last_polled_at` bumped outside the rolled-back transaction, the run finishes `provider_error` — never `failed`), and `finish()`'s compare-and-set against a row the reconcile job closed mid-run (its `failed / no_response` verdict survives).

## l. Mobile audit

_NFR-4: every screen usable at 400 px — confirm and share especially. Checked headless (Chromium via Playwright in a scratch directory, not a project dependency) at **400 × 800**, `isMobile` + touch, against `pnpm dev` on the local stack with real sessions; the structural contract lives in `tests/mobile-nav.test.ts` and `tests/mobile-routes.test.ts`, the screenshots in the git-ignored `screenshots/`._

- Below `md` the header keeps brand + role badge and a 44 × 44 px menu button; the links, email and sign-out move into a left `Sheet` (`components/ui/sheet.tsx`, a dependency-free native `<dialog>` with the shadcn API — no new package, like `dialog` / `tooltip` / `popover`). It closes on a link tap (also for the page already shown), on navigation, on Escape, on the backdrop and on ×; from `md` up the email sits back in the header.
- Every table (`contacts`, `campaigns`, `imports` ×2, dashboard performance) declares a pixel `min-w-[…]` and scrolls inside the `Table` primitive's own `overflow-x-auto` wrapper; the portal `<main>` is `min-w-0`, so `document.documentElement.scrollWidth === window.innerWidth === 400` on every route (`/login`, `/dashboard` for Kilele and for Marrakech's empty chart, `/contacts` and `?q=zzzz`, `/campaigns`, `/campaigns/[id]` as owner and as the wrong brand, `/imports?run=`, `/share/<token>` before and after unlocking, the root 404).
- Tiles stack (`grid-cols-1 sm:grid-cols-2`); the signups SVG scales to the card (`w-full min-w-0`) with its axis text hidden below `sm` (each bar keeps its `<title>`); the send-confirm and share-link dialogs are `max-h-[90dvh] overflow-y-auto` with stacked full-width buttons (596 px and 398 px tall at 400 × 800, confirm / submit visible); every `<input>` is 16 px below `md` (no iOS focus zoom); the viewport meta stays Next's default (`width=device-width, initial-scale=1`, no `maximum-scale`).
- Copy on `/campaigns/[id]` is a plain `onClick` → `navigator.clipboard.writeText` → toast "Link copied"; when the clipboard is unavailable (no secure context, permission denied) the URL is selected in its read-only input and a toast + inline note say "Copy manually".
- Three states per route, simulated without stopping the shared stack: a reverse proxy in front of `127.0.0.1:54321` that refuses every PostgREST call except `app_users` — dashboard → four `RetryAlert`s and no number, `/contacts` and `/imports` → their `error.tsx`, `/campaigns` → list + portal-sends alerts and "Sync status unavailable", `/campaigns/[id]` → "This campaign could not be loaded"; one Retry after the proxy heals recovers every route. Empty: `/contacts?q=zzzz`, Marrakech's "0 signups in the last 30 days — last signup …", `/campaigns/<other brand's id>` → the not-found tree; `/nope` → `app/not-found.tsx` (404, muted, a way back). Skeleton: each `loading.tsx` is the streamed Suspense fallback in every response. With the RPC refused, `/share/<token>` with the right password still answers the one sentence.

## m. Reachability and the call-day checklist

Vercel Hobby and Supabase Free both go quiet when nobody visits (architecture D-14): Supabase pauses a free project after a week without API activity, and nothing pg_cron does inside the database is documented to count as activity. Two probes keep the API side warm, and one human check is the real control:

| What | Where | How |
|---|---|---|
| `GET /api/health` | `app/api/health/route.ts` | `@supabase/supabase-js` with `NEXT_PUBLIC_SUPABASE_URL` + the **publishable key only** (no session, never `lib/supabase/admin`, no service / provider / database secret — the ESLint boundary below makes an admin import a lint error), `rpc('health_ping')` → `200 {"ok":true,"db":"ok","at":"…"}` or `503 {"ok":false,"code":"db_unreachable"}` (also after an 8 s `AbortSignal.timeout` on the PostgREST call — a hung database never becomes a bodiless Vercel 504), always `Cache-Control: no-store`. Outside the session guard (`proxy.ts` matcher, `tests/proxy-matcher.test.ts`); unauthenticated by design — do **not** create a Vercel `CRON_SECRET` env (name clash with the Supabase Vault secret from Dispatch / Polling). Under Cache Components the route forces request-time rendering with `connection()` rather than `export const dynamic`. |
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
4. **Share link + password opens** — the published Kilele campaign's `/share/<token>` from the submission email + its password → the results card renders (a wrong password says so, a revoked link says so).
5. **Six logins** — each of `kilele.owner`, `kilele.analyst`, `karoo.owner`, `karoo.analyst`, `marrakech.owner`, `marrakech.analyst` `@vg-eval.test` (passwords in the hosted `credentials.<host>.txt` / the submission email) opens its own portal: its brand name in the header, its own campaigns, the owner / analyst badge.
6. **The poller is alive** — Supabase Dashboard → SQL editor (`internal` is not exposed through the Data API, so this is the only place):

   ```sql
   select status, requested_at, finished_at, error from internal.poll_log order by requested_at desc limit 3;
   ```

   The newest row must be `ok` (or `requested` / `running` if a run is in flight) with `requested_at` inside the last hour; `failed` / `missing_secret` means the Vault secrets are gone (see *Polling the reports*), `no_response` means pg_net could not reach the function. The same answer through the app: `select * from public.last_poll_status();` as any signed-in user, and the *Reports last synced …* line on `/campaigns`.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request, on a fresh `ubuntu-latest` runner, **without a single secret**: the whole run targets the local Supabase stack that `supabase start` boots on the runner (the CLI's well-known demo keys, read at run time from `supabase status -o env`), and the provider is `tests/provider-mock.ts`. No real provider batch is ever dispatched, no hosted project is ever touched, and `SUPABASE_SERVICE_ROLE_KEY` / `PROVIDER_API_KEY` / `DATABASE_URL` never appear in the workflow file as a value and are never a repository secret (the seed and test steps bind those names to the runner's own local demo values).

| Step | Fails when |
|---|---|
| `pnpm install --frozen-lockfile` | the lockfile is out of date |
| `pnpm lint` (`eslint .`) | any ESLint error — including the service boundary: `lib/supabase/admin` imported anywhere but `scripts/**` — the alias and every relative path ending in `lib/supabase/admin` (with or without `.ts` / `.js` / `.mjs` / `.cjs` / `.mts` / `.cts`), `export … from`, dynamic `import()` and `require()` (`no-restricted-syntax`), and inside `lib/**` any import whose basename is `admin` (`./admin`, `./supabase/admin`) — (`eslint.config.mjs`; proven by adding `import "@/lib/supabase/admin"` to the health route and watching `pnpm lint` fail; `tests/health.test.ts` re-proves every spelling through ESLint's API) |
| `pnpm exec tsc --noEmit` | a type error anywhere the app compiles (`supabase/functions` is Deno — `pnpm check:functions`) |
| `pnpm build` (`next build`, dummy `NEXT_PUBLIC_*` values, no stack) | what only Next reports at build time: a segment config rejected under Cache Components, a client / server boundary error, a broken route file |
| `pnpm schema:dump && git diff --exit-code -- schema.sql` | **schema drift**: `schema.sql` no longer equals the concatenation of `supabase/migrations/*.sql` (byte-deterministic, `LC_ALL=C` order, no timestamps) — a migration was edited or added without `pnpm schema:dump` in the same commit |
| `supabase start` → `supabase db reset && supabase test db` | a migration does not apply from empty, or any pgTAP suite fails (the isolation test included) |
| `pnpm seed` | the seed data in `docs/data/` does not load through the importers against the runner's stack (users → stage → import) |
| `scripts/ci-env.sh` | writes the runner's `.env.test` (local URL + publishable key + the six logins from the seed's `credentials.127.0.0.1-54321.txt`) — without it the integration suites would skip, and under `CI` skipping is a failure |
| `supabase functions serve --env-file supabase/mock.env --no-verify-jwt` | the Edge Functions do not come up (the step waits for `dispatch-send` to answer `400 invalid_input`) |
| `pnpm test` | any Vitest suite fails — the integration suites (`isolation`, `send-concurrency`, `ingestion`, `share-*`, `send-actions`, `health`) **fail instead of skipping under `CI`**; the provider mock starts in Vitest's `globalSetup` on 8787, where the served functions reach it through `host.docker.internal` |

Pinned versions: Node from `.nvmrc`, pnpm 12, Supabase CLI 2.117.0 (the version the repo was developed against). First runs (2026-09-15): run 1 failed on a suite race (`share-link`'s `afterAll` signed the shared KILELE owner out **globally**, GoTrue answered `session_not_found` for the dispatch suite's token — fixed with `scope: "local"`); run 2 failed in pgTAP when the live `poll-events-5m` tick at `20:20:00` outranked `0012`'s past-dated `poll_log` fixtures (now dated ahead of the clock); run 3 green in 3 m 49 s — pgTAP 14 files / 1,804 tests, Vitest 31 files / 410 tests, the dispatch suite reaching `reporting` through the mock in 515 ms on the runner. The drift step was proven to fail by appending a comment to a migration without regenerating (`git diff --exit-code` → 1), then restored. Latest run before this submission pack: `35022861663` on `343e192` (the Epic 6 review-fix commit) — green in 3 m 57 s, pgTAP 15 files / **1,867** assertions, Vitest 31 files / **422** tests.

## Submission pack

- `docs/submission-note.md` — the ≤ 300-word note (what we tried to break, where isolation lives, the least-sure number, what isn't finished).
- `docs/submission-email.md` — the email template with every "How to submit" item and `<placeholders>` for the passwords, the provider key and the share password; the filled copy `submission-email.txt` is git-ignored next to `credentials.txt`.
- `schema.sql` at the root = the concatenation of `supabase/migrations/0000 … 0015`, regenerated by `pnpm schema:dump` and checked for drift on every CI run.
- Git tag `submission-draft` marks this pack; the annotated tag `submission` is set after the hosted seed load.
