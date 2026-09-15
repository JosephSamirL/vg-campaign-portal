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
