/**
 * The messaging provider (docs/provider-api.md). This is the ONLY module that knows the base URL and the key:
 * PROVIDER_BASE_URL / PROVIDER_API_KEY come from the function's secrets (`supabase secrets set` hosted;
 * `--env-file` locally — pointed at tests/provider-mock.ts in CI and while developing, D-14).
 *
 * POST /v1/messages { campaign?, brand?, recipients[] } with `Authorization: Bearer <key>` and
 * `Idempotency-Key: <key>` → { batch_id, accepted[], rejected[] }. The idempotency key is DERIVED by the caller
 * (`send-<send_id>`, FR-18) so a retry after a crash replays the same request and the provider delivers once.
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
