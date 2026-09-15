# Submission email — template

The email that answers every item of the brief's "How to submit" list (pp. 4–5), in the brief's order. This file holds **no secret**: every `<PLACEHOLDER>` is filled into the git-ignored `submission-email.txt` (next to `credentials.txt`) from `credentials.txt` / `credentials.qaocabdpaxetofqcfgsa.supabase.co.txt` (the six passwords), the brief's email (the provider key), and the share link created on the hosted project **after the hosted seed load** (see item 9). Never paste a filled copy into the repo, an issue, or a chat.

---

**To:** the Velocity Growth address the brief came from
**Subject:** Growth Engineer build task — Joe

Hi,

Here is everything from the "How to submit" list, in your order.

**1. Live URL**
https://vg-campaign-portal.vercel.app

**2. The six logins** (email + password each; one brand per pair, an Owner and an Analyst)

| Brand | Role | Email | Password |
|---|---|---|---|
| Kilele Rides | Owner | `kilele.owner@vg-eval.test` | `<KILELE_OWNER_PASSWORD>` |
| Kilele Rides | Analyst | `kilele.analyst@vg-eval.test` | `<KILELE_ANALYST_PASSWORD>` |
| Karoo Coaches | Owner | `karoo.owner@vg-eval.test` | `<KAROO_OWNER_PASSWORD>` |
| Karoo Coaches | Analyst | `karoo.analyst@vg-eval.test` | `<KAROO_ANALYST_PASSWORD>` |
| Marrakech Express | Owner | `marrakech.owner@vg-eval.test` | `<MARRAKECH_OWNER_PASSWORD>` |
| Marrakech Express | Analyst | `marrakech.analyst@vg-eval.test` | `<MARRAKECH_ANALYST_PASSWORD>` |

They work through the app (`/login`) and directly against Supabase (`POST /auth/v1/token?grant_type=password` with the publishable key in item 4). Owners can send and publish; analysts see the same data and are refused both, by the database, not the UI.

**3. Google sign-in**
Google sign-in is live on the same login page ("Continue with Google"). It is an allow-list: the seventh pre-created account, `joegmes@gmail.com` (Kilele Rides, Owner), signs in with Google and lands on the Kilele dashboard — I'll demonstrate it on the call. Any other Google account is refused with "This Google account is not on the allow-list for this portal." and no user is created (sign-ups are off).

**4. Supabase project URL, anon key, table and function names, which key the deployed app uses**
- Project URL: `https://qaocabdpaxetofqcfgsa.supabase.co`
- Publishable (anon) key: `<PUBLISHABLE_KEY — verbatim in README (b)>`
- Tables (`public`): `brands`, `app_users`, `contacts`, `campaigns`, `events`, `import_runs`, `import_issues`, `metric_rules`, `sends`, `send_recipients`, `provider_batches`, `share_links`; views: `v_contacts`, `v_dashboard_totals`, `v_signups_30d`, `v_campaign_performance`, `v_import_issue_groups`, `v_share_links`, `v_last_sync`. Unexposed schemas: `internal` (`poll_log`, `share_attempts` + the importers, the ingest and the cron helpers) and `staging` (the raw CSV rows).
- Functions (`public`): `current_brand_id`, `current_app_role`, `is_contactable`, `recipient_preview`, `confirm_send`, `dispatch_take_lease`, `dispatch_recipients`, `dispatch_record_result`, `dispatch_mark_failed`, `dispatch_mark_partial`, `create_share_link`, `revoke_share_link`, `get_shared_results`, `last_poll_status`, `health_ping`, `normalize_event_type`. Edge Functions: `dispatch-send`, `poll-events`. pg_cron: `dispatch-sweep`, `poll-events-5m`, `poll-events-hourly`, `poll-log-reconcile`. The full one-line-per-object inventory is README (c).
- **The deployed app uses only the publishable key plus each user's JWT.** The service-role key exists only in my shell for the seed script and as the platform-injected secret inside the two Edge Functions; the provider key is an Edge Function secret. Neither is in Vercel, the browser, or git (README (d)).

**5. Public GitHub repo**
https://github.com/JosephSamirL/vg-campaign-portal — real history (46+ incremental commits from the untouched `create-next-app` starter), `schema.sql` at the root (the concatenation of `supabase/migrations/0000 … 0015`, regenerated on every change and checked for drift in CI), README with sections (a)–(m), tag `submission`.

**6. AI tools, time, availability**
- AI tools: Claude Code (Claude Opus 5) with the BMad method — PRD → architecture → adversarial and edge-case reviews → 28 stories → dev / review loops with sub-agents. The agents did the typing; I directed, reviewed, and did the account / console steps. Details in README (g).
- Time: ~4 h planning (14 Sep) + ~13 h wall-clock build (15 Sep, several agents in parallel) + ~1.5 h for this pack (16 Sep). README (h).
- Earliest start date: `[Joe to fill]`
- Notice period: `[Joe to fill]`

**7. Where a send's progress and results are recorded**
Send trail in the database: `sends` (status `confirmed → dispatched → reporting → complete`, or `partial` / `failed`, with counts, timestamps, `batch_id`, `failure_reason`) → `send_recipients` (the frozen recipient list that was posted) → `provider_batches` (the provider's `batch_id` + the poller's cursor and `last_ok_at`) → `events` with `source = 'provider'` (every delivery report, deduplicated on batch + event id) → `internal.poll_log` / `last_poll_status()` (every poll run). In the app: the send's history card on `/campaigns/<id>` and the portal-send rows + "Reports last synced" on `/campaigns`. The reconciliation query is in README (e).

**8. The provider key I was issued**
`<PROVIDER_API_KEY>` — every POST carried `Idempotency-Key: send-<send id>`, so the batch you read at `GET /v1/messages/<batch_id>/events` is the one `provider_batches.batch_id` names.

**9. Shared link and its password**
- Link: `<SHARE_LINK_URL>` (created on the hosted project after the seed load, for a Kilele Rides campaign, no expiry)
- Password: `<SHARE_LINK_PASSWORD>`
Opening it signed in or signed out is the same: the page reads nothing until the password is right, answers one identical sentence to a wrong password, a guessed token, a revoked or expired link, and rate-limits after ten wrong attempts.

**10. The note (≤ 300 words)**
`docs/submission-note.md` in the repo, pasted here verbatim:

```
<PASTE docs/submission-note.md>
```

Best regards,
Joe

---

## Filling it (local machine only)

```bash
# from the repo root; writes the git-ignored submission-email.txt (mode 0600), never prints a value
python3 - <<'EOF'
import re, os
tpl = open("docs/submission-email.md").read().split("\n---\n", 1)[1].rsplit("\n---\n", 1)[0]
creds = {l.split("\t")[0]: l.split("\t")[1] for l in open("credentials.txt").read().splitlines() if "\t" in l}
for email, pw in creds.items():
    if email.endswith("@vg-eval.test"):
        tag = "<" + email.split("@")[0].replace(".", "_").upper() + "_PASSWORD>"
        tpl = tpl.replace(tag, pw)
tpl = tpl.replace("<PASTE docs/submission-note.md>", open("docs/submission-note.md").read().strip())
pk = re.search(r"^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)$", open(".env.local").read(), re.M).group(1).strip('"')
tpl = tpl.replace("<PUBLISHABLE_KEY — verbatim in README (b)>", pk)
fd = os.open("submission-email.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, tpl.encode()); os.close(fd)
print("written; still to fill by hand:", sorted(set(re.findall(r"<[A-Z_ ]+>|\[Joe to fill\]", tpl))))
EOF
```

Then fill `<PROVIDER_API_KEY>` (from the brief's email), `<SHARE_LINK_URL>` / `<SHARE_LINK_PASSWORD>` (after the hosted seed load: `/campaigns/<a Kilele campaign>` → *Publish results*, ≥ 8-character password, **no expiry**; test it once from an incognito window), and the two `[Joe to fill]` lines by hand.
