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
  | { kind: "client_error"; status: number; text: string }
  | { kind: "server_error"; status: number; text: string }
  | { kind: "network_error"; error: string };

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

/** The provider's base URL without a trailing slash (secrets are pasted by hand; be lenient). */
export function providerBaseUrl(): string {
  return env("PROVIDER_BASE_URL").replace(/\/+$/, "");
}

/**
 * One POST, one outcome. Never retries here: a 5xx / timeout / network failure is reported as such and the
 * caller leaves the send `dispatched` for the sweep (the 10-min lease is the retry budget). `signal` bounds the
 * wall time (the caller passes `AbortSignal.timeout(60_000)`).
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
  const text = await response.text().catch(() => "");
  if (response.status >= 500) return { kind: "server_error", status: response.status, text };
  if (response.status >= 400) return { kind: "client_error", status: response.status, text };
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const json = parsed && typeof parsed === "object" ? (parsed as PostMessagesResponse) : {};
  return { kind: "ok", status: response.status, body: json, text };
}

/** The provider keys a recipient on id / external_id / contact_id / recipient_id / email — normalise its echo to one id. */
export function recipientId(item: ProviderRecipientEcho): string | null {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return null;
  const id = item.external_id ?? item.id ?? item.contact_id ?? item.recipient_id ?? item.email;
  return typeof id === "string" ? id : null;
}
