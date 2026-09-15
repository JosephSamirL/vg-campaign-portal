"use server";

import { z } from "zod";
import type { ActionResult } from "@/lib/actions";
import type { Database } from "@/lib/database.types";
import { createAnonClient } from "@/lib/supabase/anon";
import { SHARE_FAILURE_MESSAGE } from "./copy";

/*
 * The stranger's one server action (Story 5.3, D-10). It calls `get_shared_results` as `anon`
 * — the bare client from `lib/supabase/anon.ts`, never the cookie client — and maps EVERY
 * non-`ok` outcome to one sentence. Wrong token, wrong password, revoked, expired, rate-limited,
 * an empty field, a network failure: the viewer cannot tell them apart from what renders, and
 * the RPC already removed the timing oracle (one bcrypt per call, Story 5.1). `wrapRpc()` is
 * deliberately not used: this RPC returns its codes in a `status` column instead of raising
 * (S1), and a transport error must not reach `error.tsx` with a different render tree.
 *
 * The token is never logged — not the params, not the URL; a Supabase error object carries
 * neither and is the only thing written to the server log. `SHARE_FAILURE_MESSAGE` lives in
 * `./copy.ts`: a `"use server"` module may export only async functions.
 *
 * Two exports: `unlockShareAction(token, prev, form)` is the contract (and what the attack test
 * calls); `unlockShareFormAction(prev, form)` is what the form binds, taking the token from a
 * hidden field instead of `.bind(null, token)`. Next 16.3.5 loops forever (100 % CPU until the
 * process dies) when a bound action arrives as a plain no-JS form POST — on a public URL that is
 * a one-request denial of service, so the door uses the unbound shape that `/login` already uses.
 */

/** The aggregate row `get_shared_results` returns when `status = 'ok'` — the only data this route ever holds. */
export type SharedResults = Database["public"]["Functions"]["get_shared_results"]["Returns"][number];

// No `.trim()`: a password with leading spaces must round-trip exactly as the owner typed it.
const Unlock = z.object({ password: z.string().min(1) });

function denied(code: string): ActionResult<never> {
  return { ok: false, code, message: SHARE_FAILURE_MESSAGE };
}

/** The unlock: `token` from the route, `password` from the form; one row back or one sentence. */
export async function unlockShareAction(
  token: string,
  _prev: ActionResult<SharedResults> | null,
  form: FormData,
): Promise<ActionResult<SharedResults>> {
  const parsed = Unlock.safeParse({ password: form.get("password") });
  if (!parsed.success) return denied("invalid_input");

  let data: SharedResults | null;
  try {
    const supabase = createAnonClient();
    const res = await supabase.rpc("get_shared_results", { p_token: token, p_password: parsed.data.password }).single();
    if (res.error) {
      // PostgREST / Postgres error object: code + message, no token in it.
      console.error("share_unlock_rpc_error", res.error.code, res.error.message);
      return denied("unavailable");
    }
    data = res.data;
  } catch (error) {
    // A network failure (fetch rejected) — the message names the host, not the request path.
    console.error("share_unlock_transport_error", error instanceof Error ? error.message : "unknown");
    return denied("unavailable");
  }

  if (!data) return denied("share_denied");
  if (data.status !== "ok") return denied(data.status);
  return { ok: true, data };
}

/**
 * What `ShareUnlockForm` hands to `useActionState`: `(prev, form)`, the token in the form's
 * hidden `token` field (the same value React would have serialised as the bound argument).
 */
export async function unlockShareFormAction(
  prev: ActionResult<SharedResults> | null,
  form: FormData,
): Promise<ActionResult<SharedResults>> {
  const token = form.get("token");
  if (typeof token !== "string") return denied("invalid_input");
  return unlockShareAction(token, prev, form);
}
