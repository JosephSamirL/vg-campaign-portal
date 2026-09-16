# Submission note — Client Campaign Portal

## What I tried to break

Cross-brand reads through PostgREST as brand users and anon (own rows only; anon → 42501). Analysts calling `confirm_send` / `create_share_link` → `not_owner`; owners naming another brand's campaign → `not_in_brand`. Confirm twice, from two tabs and in `Promise.all` → one send, one snapshot, one batch. Provider pages shuffled, reversed, duplicated, forged, poisoned, split across runs → identical end state. Guessed tokens, eleven wrong passwords (thirty concurrently), revoked and expired links → one identical sentence, ten ledger rows. RLS disabled, a policy `using (true)`, a grant to anon, an unrevoked function → named pgTAP failures. `pnpm seed` re-run → zero new rows.

## Where the data-isolation guarantee lives

`supabase/migrations/0001_tenancy.sql:30` — `public.current_brand_id()` (security definer; null without a JWT), and `supabase/migrations/0002_core_tables.sql:139` — `contacts_select_own_brand using (brand_id = (select public.current_brand_id()))`. Same lines: `schema.sql:45` / `schema.sql:212`. Every tenant table has the same forced policy, every view `security_invoker`; `supabase/tests/0001_tenancy.test.sql` fails if any is removed.

## The number I am least sure about

Contactable — Kilele **36,446** (caption: consent = true, blank = not consented; status ∉ {bounced, unsubscribed}; `suppressed_until` past; no ingested bounced / unsubscribed / complained event, seed or provider). Both are rule choices: ignoring event suppressions gives 51,298; blank consent as consented gives 42,330. Runner-up: KIL-0016 open rate 119.16 % (total opens ÷ sent, unclamped).

## What isn't finished

- Google sign-in on hosted: provider not yet enabled (needs Joe's Google Cloud OAuth client); button, callback and refusal path are built and tested.
- Review "Low" items deferred per story; none security-relevant.
