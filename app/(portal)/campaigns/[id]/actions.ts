"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { fail, wrapRpc, type ActionResult } from "@/lib/actions";
import type { Database, Tables } from "@/lib/database.types";
import { isRpcCode } from "@/lib/rpc-codes";
import { createClient } from "@/lib/supabase/server";

/*
 * Server actions for `/campaigns/[id]` (Story 4.4 sends; Story 5.2 share links at the end of the file).
 * Pattern (D-12): zod on the input → RPC through the cookie-session client → `wrapRpc` maps
 * the error contract → `revalidatePath` after every mutation. The actions hold no role check
 * of their own: the RPCs refuse (`not_owner`, `not_in_brand`, …) and the action only maps —
 * "UI hides, DB refuses" (FR22). Nothing is recomputed here; every number is the RPC's.
 */

export type SendRow = Tables<"sends">;
export type RecipientPreview = Database["public"]["Functions"]["recipient_preview"]["Returns"][number];
/** What `dispatchSendAction` / `confirmSendAction` learned from `dispatch-send` — informational, the page polls `sends.status`. */
export type DispatchOutcome = { send_id: string; dispatched: boolean; reason: string | null };

const Preview = z.object({ campaign_id: z.uuid() });
const Confirm = z.object({ campaign_id: z.uuid(), expected_count: z.number().int().positive() });
const Dispatch = z.object({ send_id: z.uuid() });
/**
 * Story 5.2 / D-10: `password` is `min(8)` with NO `.trim()` and no transform — the RPC stores what
 * was typed, and the stranger must later type the same thing, spaces included. `expires_at` is an
 * ISO-8601 UTC instant (the browser converts its `datetime-local` value) or `null` — never `""`.
 */
const CreateShareLink = z.object({ campaign_id: z.uuid(), password: z.string().min(8), expires_at: z.iso.datetime().nullable() });
const RevokeShareLink = z.uuid();

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** `recipient_preview` for the confirm dialog: one row with the exact count and the three excluded counts (FR16/17). */
export async function previewSendAction(input: unknown): Promise<ActionResult<RecipientPreview>> {
  const p = Preview.safeParse(input);
  if (!p.success) return fail("invalid_input");
  const supabase = await createClient();
  // the RPC returns a set of one row → `.single()` (Dev Notes)
  return wrapRpc(supabase.rpc("recipient_preview", { p_campaign_id: p.data.campaign_id }).single());
}

/**
 * `confirm_send` with the count the owner saw, then `dispatch-send` — WITHOUT awaiting the provider
 * round-trip: the Edge Function answers 202 right after it takes the lease (Story 4.3), so this
 * action returns in well under a second and the page polls `sends.status` (D-12, amendment #12).
 * `count_mismatch` comes back with `hint` = the new count and the dialog asks to confirm again (D-6).
 */
export async function confirmSendAction(input: unknown): Promise<ActionResult<SendRow>> {
  const p = Confirm.safeParse(input);
  if (!p.success) return fail("invalid_input");
  const supabase = await createClient();
  const res = await wrapRpc(
    supabase.rpc("confirm_send", { p_campaign_id: p.data.campaign_id, p_expected_count: p.data.expected_count }),
  );
  if (!res.ok) return res;
  // The send is `confirmed` from here on whatever the invoke does: a failed invoke is logged, the
  // history's Retry (dispatchSendAction) and the sweep recover it.
  await invokeDispatch(supabase, res.data.id);
  revalidatePath(`/campaigns/${p.data.campaign_id}`);
  return res;
}

/**
 * The Retry beside a send stuck in `confirmed` (AC5): re-invokes `dispatch-send`, which is safe to
 * call any number of times (lease + `Idempotency-Key`). The function's own refusals (403 `not_owner`,
 * 404 `not_in_brand`) map to the same codes as the RPCs; a skipped or unreachable invoke is reported
 * as `dispatched: false` with the reason, never thrown — the send record is untouched either way.
 */
export async function dispatchSendAction(input: unknown): Promise<ActionResult<DispatchOutcome>> {
  const p = Dispatch.safeParse(input);
  if (!p.success) return fail("invalid_input");
  const supabase = await createClient();
  const outcome = await invokeDispatch(supabase, p.data.send_id);
  if (outcome.refused) return fail(outcome.refused);
  const { data: send } = await supabase.from("sends").select("campaign_id").eq("id", p.data.send_id).maybeSingle();
  if (send) revalidatePath(`/campaigns/${send.campaign_id}`);
  return { ok: true, data: { send_id: p.data.send_id, dispatched: outcome.dispatched, reason: outcome.reason } };
}

type InvokeOutcome = { dispatched: boolean; reason: string | null; refused: "not_owner" | "not_in_brand" | "invalid_input" | null };

/**
 * `supabase.functions.invoke('dispatch-send', { body: { send_id } })` — the server client forwards
 * the session's access token, so the function loads the send through a user-scoped client (RLS
 * proves the brand, `current_app_role()` must be `owner`). Returns after the lease (202) or the
 * function's `{ skipped, reason }` (200); it never waits for the provider. Never throws: an
 * unreachable function is a log line, the send stays `confirmed` for Retry / the sweep.
 */
async function invokeDispatch(supabase: Supabase, sendId: string): Promise<InvokeOutcome> {
  const started = Date.now();
  try {
    const { data, error } = await supabase.functions.invoke<Record<string, unknown>>("dispatch-send", { body: { send_id: sendId } });
    if (error) {
      const body = await functionErrorBody(error);
      const code = typeof body?.code === "string" ? body.code : null;
      console.error("dispatch_invoke_failed", { send_id: sendId, ms: Date.now() - started, error: error.message, code });
      if (code === "not_owner" || code === "not_in_brand" || code === "invalid_input") return { dispatched: false, reason: code, refused: code };
      return { dispatched: false, reason: isRpcCode(code) ? code : "invoke_failed", refused: null };
    }
    if (data && data.skipped === true) {
      const reason = typeof data.reason === "string" ? data.reason : "skipped";
      console.info("dispatch_skipped", { send_id: sendId, ms: Date.now() - started, reason });
      return { dispatched: false, reason, refused: null };
    }
    console.info("dispatch_leased", { send_id: sendId, ms: Date.now() - started, status: data?.status, dispatch_attempts: data?.dispatch_attempts });
    return { dispatched: true, reason: null, refused: null };
  } catch (error) {
    console.error("dispatch_invoke_threw", { send_id: sendId, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    return { dispatched: false, reason: "invoke_failed", refused: null };
  }
}

/** The function answers every refusal with JSON `{ code, message }`; supabase-js keeps the Response on `error.context`. */
async function functionErrorBody(error: unknown): Promise<Record<string, unknown> | null> {
  const context = (error as { context?: unknown }).context;
  if (!(context instanceof Response)) return null;
  try {
    const body: unknown = await context.clone().json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------------------------------------
 * Story 5.2 — share links. Same pattern: zod → RPC through the cookie-session client → `wrapRpc`
 * → `revalidatePath`. No role check here either: `create_share_link` / `revoke_share_link` raise
 * `not_owner` for an analyst and the action only relays it (FR-4: UI hides, DB refuses).
 * ---------------------------------------------------------------------------------------------- */

/** The one and only time the raw token exists outside the RPC's return value: this response. */
export type ShareLinkCreated = { token: string; url: string };

/**
 * `create_share_link(p_campaign_id, p_password, p_expires_at)` → the raw 43-char token (5.1 hashes
 * it; it is never readable again) plus the full URL the owner hands out. Invalid input is refused
 * here first (`invalid_input`, no RPC call) and again by the RPC. `p_expires_at` is omitted — not
 * sent as `null` — so the RPC's `default null` applies. The token is never logged and never put in
 * a portal URL, `revalidatePath` or a cookie.
 */
export async function createShareLinkAction(input: unknown): Promise<ActionResult<ShareLinkCreated>> {
  const p = CreateShareLink.safeParse(input);
  if (!p.success) return fail("invalid_input", null, "share");
  const supabase = await createClient();
  const res = await wrapRpc(
    supabase.rpc("create_share_link", {
      p_campaign_id: p.data.campaign_id,
      p_password: p.data.password,
      ...(p.data.expires_at === null ? {} : { p_expires_at: p.data.expires_at }),
    }),
    "share",
  );
  if (!res.ok) return res;
  if (typeof res.data !== "string" || res.data.length === 0) throw new Error("create_share_link returned no token");
  revalidatePath(`/campaigns/${p.data.campaign_id}`);
  return { ok: true, data: { token: res.data, url: await shareUrl(res.data) } };
}

/**
 * `revoke_share_link(p_id)` — sets `revoked_at` on an own-brand link (a second call is a no-op in
 * the RPC). `not_owner` for an analyst, `not_in_brand` for an unknown / foreign id. The page is
 * revalidated through the link's campaign, read back from `v_share_links` (RLS-scoped).
 */
export async function revokeShareLinkAction(id: unknown): Promise<ActionResult<{ id: string }>> {
  const p = RevokeShareLink.safeParse(id);
  if (!p.success) return fail("invalid_input", null, "share");
  const supabase = await createClient();
  const res = await wrapRpc(supabase.rpc("revoke_share_link", { p_id: p.data }), "share");
  if (!res.ok) return res;
  const { data: link } = await supabase.from("v_share_links").select("campaign_id").eq("id", p.data).maybeSingle();
  if (link?.campaign_id) revalidatePath(`/campaigns/${link.campaign_id}`);
  return { ok: true, data: { id: p.data } };
}

/**
 * `https://<host>/share/<token>` from the request's own host (`x-forwarded-host` behind Vercel's
 * proxy, else `host`) — no site-URL env var to drift from the deployment. `http` only for a local
 * dev host; with no host header at all the path is root-relative and the browser prefixes its origin.
 */
async function shareUrl(token: string): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const path = `/share/${token}`;
  if (!host) return path;
  const proto = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) ? "http" : "https";
  return `${proto}://${host}${path}`;
}
