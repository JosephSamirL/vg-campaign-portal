import { isRpcCode, rpcMessage, type RpcCode, type RpcContext } from "@/lib/rpc-codes";

/**
 * Every server action returns this shape (architecture "Format patterns"): expected
 * failures carry a snake_case `code` the UI can switch on plus a human `message` for the
 * inline <Alert>; success carries `data`. Successful sign-in redirects instead of returning.
 *
 * `hint` (Story 4.4) is the RPC's `hint` when it sent one — `count_mismatch` puts the new
 * recipient count there (D-6), and the confirm dialog re-renders with it as the new
 * expected count.
 */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; hint?: string };

/** What supabase-js hands back for a query / RPC: PostgREST's error shape, or the data. */
type RpcError = { code?: string; message: string; hint?: string | null };
type RpcResponse = { data: unknown; error: RpcError | null };

/** `{ ok: false, code, message }` for an expected code, copy from `lib/rpc-codes.ts` (per surface — Story 5.2's `"share"`). */
export function fail(code: RpcCode, hint?: string | null, context?: RpcContext): ActionResult<never> {
  const message = rpcMessage(code, hint, context);
  return hint != null && hint !== "" ? { ok: false, code, message, hint } : { ok: false, code, message };
}

/**
 * Await a supabase-js RPC (or query) and map its outcome to an `ActionResult`:
 *   - no error → `{ ok: true, data }`
 *   - `P0001` whose message is one of the RPC codes → `{ ok: false, code, message, hint }`
 *   - anything else (a PostgREST error, a Postgres error that is not the contract, an unknown
 *     message) → throws, so the route's `error.tsx` renders. Expected failures are the only
 *     thing the UI switches on; the raw text of an unexpected one stays in the server log.
 */
export async function wrapRpc<R extends RpcResponse>(query: PromiseLike<R>, context?: RpcContext): Promise<ActionResult<NonNullable<R["data"]>>> {
  const { data, error } = await query;
  if (error) {
    if (error.code === "P0001" && isRpcCode(error.message)) return fail(error.message, error.hint, context);
    throw new Error(`rpc failed: ${error.code ?? "?"} ${error.message}`);
  }
  // supabase-js types `data` as nullable on every response; with `error` null it is the row (`.single()` errors on no row)
  return { ok: true, data: data as NonNullable<R["data"]> };
}
