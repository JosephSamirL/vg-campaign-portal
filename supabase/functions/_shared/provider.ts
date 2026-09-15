/**
 * The messaging provider (docs/provider-api.md). This is the ONLY module that knows the base URL and the key:
 * PROVIDER_BASE_URL / PROVIDER_API_KEY come from the function's secrets (`supabase secrets set` hosted;
 * `--env-file` locally — pointed at tests/provider-mock.ts in CI and while developing, D-14).
 *
 * POST /v1/messages { campaign?, brand?, recipients[] } with `Authorization: Bearer <key>` and
 * `Idempotency-Key: <key>` → { batch_id, accepted[], rejected[] }. The idempotency key is DERIVED by the caller
 * (`send-<send_id>`, FR-18) so a retry after a crash replays the same request and the provider delivers once.
 *
 * GET /v1/messages/{batch_id}/events?since=<next_cursor>&page_size=1000 → { events[], next_cursor, has_more }
 * (Story 6.3, probe rows b, c, c2, e): `since` carries ONLY a provider `next_cursor` — never an event id, which the
 * real provider ignores (a full replay). `page_size` is decorative (not honoured) and still sent as 1000. A 429 / 503
 * carries `Retry-After` (header, else body `retry_after`, else 5 s) — the caller decides whether to wait.
 */
export type Recipient = { external_id: string; address: string };

export type PostMessagesBody = {
  campaign?: string;
  brand?: string;
  recipients: Recipient[];
};

/** A recipient as the provider echoes it back: a bare id or an object keyed on one of its id fields. */
export type ProviderRecipientEcho =
  | string
  | { id?: string; external_id?: string; contact_id?: string; recipient_id?: string; email?: string };

export type PostMessagesResponse = {
  batch_id?: string;
  accepted?: ProviderRecipientEcho[];
  rejected?: ProviderRecipientEcho[];
};

export type ProviderResult =
  | { kind: "ok"; status: number; body: PostMessagesResponse; text: string }
  /** A 2xx whose body could not be read or parsed as JSON: the provider may well have accepted the batch — an UNKNOWN outcome, never a failure. */
  | { kind: "unreadable"; status: number; error: string }
  | { kind: "client_error"; status: number; text: string }
  | { kind: "server_error"; status: number; text: string }
  | { kind: "network_error"; error: string };

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

/** The names of the provider secrets that are unset (empty = configured). Checked BEFORE the lease so a misconfigured deploy never burns an attempt. */
export function missingProviderEnv(): string[] {
  return ["PROVIDER_BASE_URL", "PROVIDER_API_KEY"].filter((name) => !Deno.env.get(name));
}

/** The provider's base URL without a trailing slash (secrets are pasted by hand; be lenient). */
export function providerBaseUrl(): string {
  return env("PROVIDER_BASE_URL").replace(/\/+$/, "");
}

/** How much of a provider error body is kept in `sends.failure_reason` (the full text goes to the log line only). */
export const FAILURE_REASON_TEXT_MAX = 120;

/**
 * `provider_<status>: <first 120 chars of the body, whitespace collapsed, no newlines>` — what is stored in
 * `sends.failure_reason` and rendered to owners and analysts. The raw body (which may echo recipient addresses in a
 * validation error) stays in the function's log line.
 */
export function failureReason(status: number, text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const clipped = flat.length > FAILURE_REASON_TEXT_MAX ? `${flat.slice(0, FAILURE_REASON_TEXT_MAX)}…` : flat;
  return clipped ? `provider_${status}: ${clipped}` : `provider_${status}`;
}

/**
 * One POST, one outcome. Never retries here: a 5xx / timeout / network failure is reported as such and the
 * caller leaves the send `dispatched` for the sweep (the 10-min lease is the retry budget). A 2xx whose body
 * cannot be read or is not a JSON object is `unreadable` — also an unknown outcome (the provider may have
 * accepted the batch under this key), which the caller must not turn into `failed`. `signal` bounds the wall
 * time (the caller passes `AbortSignal.timeout(60_000)`).
 */
export async function postMessages(body: PostMessagesBody, idempotencyKey: string, signal?: AbortSignal): Promise<ProviderResult> {
  let response: Response;
  try {
    response = await fetch(`${providerBaseUrl()}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env("PROVIDER_API_KEY")}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return { kind: "network_error", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // the status line arrived, the body did not: for a 2xx the provider may have accepted the batch — unknown, not failed
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (response.status < 400) return { kind: "unreadable", status: response.status, error: `body_unreadable: ${reason}` };
    text = "";
  }
  if (response.status >= 500) return { kind: "server_error", status: response.status, text };
  if (response.status >= 400) return { kind: "client_error", status: response.status, text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable", status: response.status, error: text ? "body_not_json" : "body_empty" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unreadable", status: response.status, error: "body_not_object" };
  return { kind: "ok", status: response.status, body: parsed as PostMessagesResponse, text };
}

/** The provider keys a recipient on id / external_id / contact_id / recipient_id / email — normalise its echo to one id. */
export function recipientId(item: ProviderRecipientEcho): string | null {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return null;
  const id = item.external_id ?? item.id ?? item.contact_id ?? item.recipient_id ?? item.email;
  return typeof id === "string" ? id : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Story 6.3 — GET /v1/messages/{batch_id}/events
// ---------------------------------------------------------------------------------------------------------------

/** One page of the report stream as the provider serves it (probe row d: the envelope; the events are opaque here). */
export type EventsPage = { events: unknown[]; next_cursor: string | null; has_more: boolean };

export type GetEventsResult = {
  /** HTTP status; 0 = no response (timeout / network). */
  status: number;
  /** Seconds to wait before retrying, from a 429 / 503 (`Retry-After` header → body `retry_after` → 5). */
  retryAfter?: number;
  /** The parsed page for a 2xx whose body is a well-formed envelope. */
  body?: EventsPage;
  /** The raw response text (≤ 500 chars) for anything that is not a well-formed 2xx; the error text for status 0. */
  text?: string;
  /** Why a 2xx has no `body`, or the timeout / network error. */
  error?: string;
};

export const EVENTS_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRY_AFTER_S = 5;
/** Decorative on the real provider (probe c2), but the mock honours it and the contract documents it. */
export const EVENTS_PAGE_SIZE = 1000;

/** `Retry-After` in seconds: the header (delay-seconds or an HTTP date) → the body's `retry_after` → 5. */
export function retryAfterSeconds(headers: Headers, bodyText: string): number {
  const header = headers.get("retry-after");
  if (header) {
    const n = Number(header.trim());
    if (Number.isFinite(n) && n >= 0) return n;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  try {
    const parsed = JSON.parse(bodyText) as { retry_after?: unknown };
    if (parsed && typeof parsed === "object") {
      const n = typeof parsed.retry_after === "number" ? parsed.retry_after : Number(parsed.retry_after);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {
    // not JSON
  }
  return DEFAULT_RETRY_AFTER_S;
}

/** A 2xx body is a page only when it is an object with an `events` array; `next_cursor` non-string → null, `has_more` non-boolean → false. */
export function parseEventsPage(text: string): { page?: EventsPage; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: text ? "body_not_json" : "body_empty" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "body_not_object" };
  const obj = parsed as { events?: unknown; next_cursor?: unknown; has_more?: unknown };
  if (!Array.isArray(obj.events)) return { error: "events_not_array" };
  const cursor = typeof obj.next_cursor === "string" && obj.next_cursor.length > 0 ? obj.next_cursor : null;
  return { page: { events: obj.events, next_cursor: cursor, has_more: obj.has_more === true } };
}

/**
 * One GET, one outcome, no retry here: the poller owns the run budget and decides whether a `retryAfter` fits in it.
 * `since` is sent only when given (the stored `next_cursor`); `signal` bounds the wall time (default 20 s).
 */
export async function getEvents(batchId: string, since?: string | null, signal: AbortSignal = AbortSignal.timeout(EVENTS_TIMEOUT_MS)): Promise<GetEventsResult> {
  const url = new URL(`${providerBaseUrl()}/v1/messages/${encodeURIComponent(batchId)}/events`);
  if (since) url.searchParams.set("since", since);
  url.searchParams.set("page_size", String(EVENTS_PAGE_SIZE));
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${env("PROVIDER_API_KEY")}`, Accept: "application/json" }, signal });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return { status: 0, error: name === "TimeoutError" || name === "AbortError" ? `timeout: ${message}` : `${name}: ${message}` };
  }
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    text = "";
    if (response.ok) return { status: response.status, error: `body_unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (response.status === 429 || response.status === 503) {
    return { status: response.status, retryAfter: retryAfterSeconds(response.headers, text), text: text.slice(0, 500) };
  }
  if (!response.ok) return { status: response.status, text: text.slice(0, 500) };
  const { page, error } = parseEventsPage(text);
  if (!page) return { status: response.status, error, text: text.slice(0, 500) };
  return { status: response.status, body: page };
}
