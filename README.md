# Client Campaign Portal

A multi-tenant campaign portal for three brands (Kilele Rides, Karoo Coaches, Marrakech Express) built for the Velocity Growth Growth-Engineer build task. Each brand's marketing team signs in, sees only its own contacts, campaigns and dashboard, sends a campaign through the messaging provider, watches delivery reports come back, and can publish one campaign's results behind a password-protected link.

**Live:** https://vg-campaign-portal.vercel.app

## Stack

- **Next.js 16.3** (App Router, `proxy.ts` for session refresh) on **Vercel**
- **Supabase**: Postgres 17 with row-level security, Auth (email + password, Google), Cron (pg_cron + pg_net), Edge Functions
- **Tailwind CSS + shadcn/ui**
- **Vitest** (app-level tests) + **pgTAP** via `supabase test db` (database-level tests)
- Node 22 (`.nvmrc`), pnpm

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

_Filled in by the auth stories._

## Exposed schemas

_Filled in by the tenancy story._

## What we tried to break

_Grows with every attack test that lands._

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
