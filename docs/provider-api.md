# VG Messaging Dispatcher API (v1.4.0)

Base URL: https://dispatcher-production-72fc.up.railway.app

Fetched: 2026-09-14 from /v1/docs

Send campaigns and read delivery reports. Authenticate every request with the API key issued to you: 'Authorization: Bearer <API_KEY>' (or the 'X-API-Key' header). 

## Auth

{
  "scheme": "Bearer",
  "header": "Authorization: Bearer <API_KEY>",
  "alt_header": "X-API-Key: <API_KEY>"
}

## Rate limits

{
  "requests_per_minute": 600,
  "note": "Generous headroom: up to 600 requests per minute per key. You are unlikely to hit this."
}

## Endpoints

### POST /v1/messages

Dispatch a batch of messages.

```json
{
  "headers": {
    "Idempotency-Key": "Optional. Include a key to make a retry safe. Send the same request twice and it is delivered once."
  },
  "body": {
    "campaign": "string (optional label for your own reference)",
    "brand": "string (optional label)",
    "recipients": "array of recipients. Each item may be a string id or an object; we key on id / external_id / contact_id / recipient_id / email."
  },
  "recipient_limit": "Up to 100,000 recipients per call. No practical limit for normal campaigns.",
  "returns": {
    "batch_id": "string \u2014 poll its events for delivery reports",
    "accepted": "array of accepted recipients",
    "rejected": "array (normally empty)"
  }
}
```

### GET /v1/messages/{batch_id}/events

Delivery reports for a batch.

```json
{
  "query": {
    "since": "Pass the event_id of the last event you have already processed. Omit on the first call."
  },
  "page_size": "Up to 1,000 events per page.",
  "returns": {
    "events": "array of delivery events",
    "next_cursor": "cursor for the next page (null when complete)",
    "has_more": "boolean"
  },
  "note": "The report stream is clean and complete: every event is delivered exactly once and in order."
}
```

### GET /healthz

Liveness probe (no auth).

```json
{}
```

## Event types

delivered, bounced, opened, unsubscribed

> NOTE (from the brief, not the docs): the brief says reports "will be deliberately messy and out of order in places". The docs claim exactly-once, in-order. Design for the brief, not the docs.

## Probe 2026-09-15

Live probe against `https://dispatcher-production-72fc.up.railway.app` (Story 6.1), 18:17:57Z → 18:31Z, inside the 30-minute box.
Three POSTs (P1+P2 same `Idempotency-Key`, P3 without a key), one synthetic recipient `{"external_id":"PROBE-2026-09-15-6ab4dc49"}`,
`campaign`/`brand` = `probe`; ~70 GETs on the two resulting batches. Capture files (`p1`, `e1`, … below) lived in a session
scratch directory and were deleted; every `Authorization` line was `Bearer ***`. **No key material in this file.**
Observed reality overrides the v1.4.0 text above wherever the two disagree; the "exactly once and in order" claim is false (see d2).

### Decision table

| # | Question | Observed (file) | Decision | Consequence |
|---|---|---|---|---|
| a | Replay with same `Idempotency-Key` → same `batch_id`? | **yes** — P1 and P2 both `200 {"batch_id":"batch_5a07…"}`, byte-identical apart from JSON key order; no replay header. P3 (same body, no key) → a **new** `batch_id` (`batch_1308…`), i.e. the provider keys on the header only, never on the body (p1/p2/p3, h1/h2/h3) | **yes** | Story 6.3 activates `dispatch-sweep` in `0013_cron_poll.sql`: `select cron.alter_job(jobid, active := true) from cron.job where jobname = 'dispatch-sweep';` (the `cron.alter_job` form — `update cron.job` is `permission denied` for `postgres`, see 4.3). Sequence: land 6.2's migration first (24-h ceiling + `dispatch_expired`, `dispatch_mark_partial`), then enable. Hosted secret `DISPATCH_RETRY_ENABLED=on` is set in the **same** step (`supabase secrets set DISPATCH_RETRY_ENABLED=on`; `supabase/mock.env` gets the same line); until then it stays unset ⇒ 6.2's branch marks a 5xx/timeout `partial` immediately (D-7). `dispatch-send`'s 5xx/timeout branch is **unchanged** by 6.1 |
| a2 | `accepted` echoes ids or objects? Response shape? | `200` (not 201/202) `{"batch_id":"batch_<20 hex>","accepted":["<external_id as sent>"],"accepted_count":1,"rejected":[],"rejected_count":0,"status":"accepted"}` — bare **strings** equal to the `external_id` we posted; `Content-Type: application/json`; no `address` was posted and the recipient still got `delivered` (p1) | ids (strings) | `recipientId()` string branch matches `send_recipients.external_id` → `accepted ∩ recipients` works as built (4.3 deferred item closed). `accepted_count`/`rejected_count`/`status` are extra fields — read `accepted`/`rejected`, ignore the rest |
| b | `since` accepts | **`next_cursor` only.** `since=<event_id>` (e2, e5, e12) returns the full stream — indistinguishable from no `since` and from a bogus value (e4). `since=<next_cursor>` (e3, e10, e14, e15) is honoured: skips exactly the items served before that cursor was issued. The cursor is opaque and positional — both batches' first page returned `"bzox"` | `next_cursor` | 6.3 sends the stored `next_cursor` while it has one and **omits** `since` otherwise; it never sends an event id (`last_event_id` buys nothing — it is a full replay). D-8's "both, that order" fallback is replaced by this row |
| b2 | `since=<id>` exclusive or inclusive? | neither — ignored (e2/e5: the id passed is item 0 of the response) | ignored | Every run that has no cursor re-reads the whole stream; harmless because ingest is `do nothing` on a duplicate `(batch_id, event_id)` (6.2) |
| c | `next_cursor` when `has_more=false` | **`null`** (e5, t1, t2). Also: `has_more=true` with **empty** `events` and an **unchanged** `next_cursor` while the stream is still open (e3) — `has_more` means "the batch's report stream is still open", not "another page exists". Stream closed ≈ 90 s after the POST for one recipient (POST 18:18:08 → `has_more=false` at 18:19:36). `has_more=true` with a null cursor was **not** observed | null | Persist the last **non-null** cursor per batch and keep it when the final page comes back `null` (a stale cursor still works after close — e10/e15 returned the late items). A run stops on: empty `events`, `next_cursor=null`, cursor unchanged, or `has_more=false`; never on `has_more` alone (e3 would spin). `has_more=true` + null cursor stays `cursor_contract_violation` (D-8) |
| c2 | `page_size` honoured? | **no** — `page_size=1` returned 2 events (e10); `page_size=0` and `page_size=abc` → `200`, full stream (e8, e9); `page_size=1000` fine (e15) | no | Paging cannot be forced against the real provider; the mock forces it with its own knob (6.3) and the poller stays generic over `has_more`/`next_cursor` |
| d | Field names: id / type / timestamp / recipient | Envelope `{"batch_id","events":[…],"next_cursor","has_more"}`; event `{"event_id":"evt-batch_5a-00000","recipient_id":"PROBE-2026-09-15-6ab4dc49","brand_code":"account","type":"delivered","occurred_at":"2026-09-15T18:18:42Z"}` (e1). Recipient key is **`recipient_id`** (value = the `external_id` we posted), not `external_id`; timestamp is **`occurred_at`** (ISO-8601, `Z`, second precision); `brand_code` is `"account"` on our own events — not the `brand` label we posted (`probe`) — and `"KAROO"` on forged ones | `event_id`, `type`, `occurred_at`, `recipient_id` | 6.2 coalesce order (as `0012` implements it): id `event_id ?? id`; recipient `recipient_id ?? external_id ?? recipient (string) ?? recipient.external_id ?? recipient.id ?? contact_id ?? email` (a bare `id` is the event id, never a recipient key); time `occurred_at ?? timestamp ?? created_at` (present on every event seen — the "absent timestamp" path stays a fallback). Tenancy comes from the send's snapshot only: **never** trust `brand_code` |
| d2 | Types seen; order/duplicates seen | Types: `delivered`, `opened` (no `bounced`/`unsubscribed` in 13 min). Mess, all within ~3 min of the POST (e5, t1, t1b, t2b): (1) exact duplicates — the same `event_id` twice in one page (`…-00000` ×2, `…-00001` ×2); (2) out of order — `delivered` (`occurred_at` 18:19:00) re-appended **after** `opened` (18:22:10); (3) **forged** events `evt-<batch>-forged` for a recipient that was **not** in the batch — `recipient_id` `CT-078480` / `CT-021214` are real seed contacts (locally: KILELE) labelled `brand_code:"KAROO"`; (4) **future** `occurred_at` — `opened` at 18:22:10Z served at 18:21:28Z, forged at 18:21:53Z served at 18:19:36Z; (5) accumulation: 1 event at 18:18:20 → 3 at 18:19:36, then stable through 18:31 (t3) | as observed | **Deviation from FR-24 / 6.2 AC3, recorded:** FR-24 says "the terminal state by latest `occurred_at` when present, else by precedence"; because the stream carries forged events and future-dated timestamps (3, 4), a provider timestamp cannot be trusted to order states, so 6.2 decides the visible state by precedence FIRST (`unsubscribed > complained > bounced > delivered`) and uses `occurred_at` only as the tie-break within a type (6.2 deviation 4; `internal.recipient_state`). Suppression (`contacts.suppressed_at`) still keeps the earliest real timestamp (FR-24's monotonic clause is untouched). Also: dedupe on `(batch_id, event_id)`; drop (and count) any event whose `recipient_id` is not in the send's `send_recipients`; keep `occurred_at` verbatim in `raw`/`occurred_at`; `opened` may precede `delivered` |
| e | 401 / 404 / 503 shapes, `Retry-After`? | **401** `{"error":"unauthorized","message":"Provide your API key as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'."}` — same body for a wrong bearer (a1) and no header (a2). **404** `{"error":"not_found","message":"unknown batch_id"}` (e6). **503** `{"error":"service_unavailable","message":"reports temporarily unavailable","retry_after":N}` **with** `Retry-After: N` header (seconds; a 12-request 503 burst counted down 5,4,4,3,3,3,2,2,2,1,1,1; 18 and 16 seen on isolated hits) — ~30 % of GETs, on both auth styles (e5-first-try, x1-first-try, r1). Error bodies are always `{"error":"<snake_case>","message":"<text>"}` | JSON shapes as quoted | 6.3: 401 → `auth_error` (stop the run); 404 → `provider_error` for that batch; 503 → honour `Retry-After` (header, else body `retry_after`, else 5 s), retry within the run budget, and a wait that does not fit leaves **that batch** `deferred` (not an error, the run goes on — replaces D-8's "5xx → provider_error, skip the batch" for 503 specifically; other 5xx stay `provider_error`). Provider 503s on POST were not seen (3/3 `200`) — the sweep + same key cover that path |
| e2 | 429 shape, `Retry-After`? | **not observed** (r1: 40 back-to-back GETs → 28×`200`, 12×`503`, 0×`429`; ~70 GETs total) | unknown | architecture fallback (D-8): honour `Retry-After` the same way as 503 (header → body `retry_after` → 5 s); a wait that does not fit leaves that batch `rate_limited`. If a 429 shape is ever seen, record it here |
| f | Bogus `since` | `200`, full stream (e4) — same as `since=` empty (e13) | full stream | Never send a bogus cursor; if the provider forgets a cursor, the stream is replayed and 6.2's dedupe absorbs it. No `400` path exists for `since` |
| g | `X-API-Key` works? | **yes** — `200`, same stream (x1) | informational | `_shared/provider.ts` keeps `Authorization: Bearer` |
| h | POST idempotency across bodies / rate limit on POST | Not probed (one-recipient limit, 3 POSTs max) | unknown | architecture fallback: `Idempotency-Key = send-<send_id>` (FR-18) and the 60-s timeout stay |

### Decisions carried to Stories 6.2 / 6.3

1. **`dispatch-sweep`: enable.** Replay is safe (row a). `0013_cron_poll.sql` (6.3) runs `select cron.alter_job(jobid, active := true) from cron.job where jobname = 'dispatch-sweep';` — **not executed by 6.1** — after 6.2's migration has landed the 24-h ceiling, `dispatch_expired`, and `dispatch_mark_partial`.
2. **`DISPATCH_RETRY_ENABLED=on`** for the `dispatch-send` Edge Function secret (hosted `supabase secrets set …`, plus `supabase/mock.env`), set in the same step as (1) and not before — **recorded, not set by 6.1**. While unset, a 5xx/timeout goes `partial` immediately through 6.2's `dispatch_mark_partial` (D-7).
3. **Cursor rules for 6.3** (replace D-8's fallback where they differ):
   - `since` carries only a provider `next_cursor`; a run with no stored cursor omits `since`. Event ids are never sent.
   - Loop: ingest the page → if `next_cursor` is non-null and differs from the one sent, store it and request again; stop on empty `events`, `next_cursor=null`, unchanged cursor, or `has_more=false` (plus a page cap). `has_more=true` with an empty page is normal (stream open, nothing new).
   - On `has_more=false` keep the last non-null cursor (do not null it) and keep polling the batch for the rest of the window: late/forged/duplicate items were still appearing 90 s after the POST and a stale cursor returns them (e10/e15).
   - `has_more=true` with `next_cursor=null` → `cursor_contract_violation`, stop (unobserved, kept).
   - A `503`/`429` honours `Retry-After` (header → body `retry_after` → 5 s); a wait that does not fit the run budget records `deferred` (503) / `rate_limited` (429) for **that batch** and the run continues with the next batch; only a `401` aborts the run. `404` → `provider_error`.
   - **Replaces D-8's error handling:** D-8 said "5xx → `provider_error`, skip the batch" and knew no `deferred`. `deferred` is a new `internal.poll_status` value (6.2), is per batch, and is NOT a sync warning on the campaigns page (6.3; amends S11). Every other 5xx, a timeout and a malformed body stay `provider_error`.
   - `page_size` is decorative; still sent as `1000`.
4. **Ingest rules for 6.2** (from d/d2): key on `(batch_id, event_id)`; recipient = `recipient_id`; drop events whose recipient is not in `send_recipients` for that send (count them as `foreign_recipient`); never read `brand_code`; store `occurred_at` verbatim (it can be in the future); precedence, not arrival order or time, decides the visible state (the FR-24 deviation recorded in row d2).
   - **Mapping onto D-8's key:** `public.events` keeps D-8's natural key `(brand_id, source, event_id)`; 6.2 stores the provider id **batch-qualified** — `event_id = '<batch_id>:<provider event_id>'` (ids over 200 chars as their sha256 hex, the raw id in `raw`) — so the unique constraint IS the `(batch_id, event_id)` dedupe and two batches of one brand may reuse a provider id. D-8's key is not replaced; its meaning for `source = 'provider'` rows is.
