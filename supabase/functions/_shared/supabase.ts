/**
 * Supabase clients for Edge Functions, from the runtime-injected env only (SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY are set by the platform locally and hosted). Functions never import `lib/` or
 * `app/` — the Next.js clients are cookie-based and belong to the portal.
 *
 * - `userClient(authorization)` — anon key + the caller's `Authorization: Bearer <jwt>` forwarded on every
 *   request, so PostgREST evaluates RLS as that user (the load "proves brand": no row → not in brand).
 *   `verify_jwt = false` on the function means this client's `auth.getUser()` IS the authentication check.
 * - `serviceClient()` — the service-role key: bypasses RLS; used only for the `dispatch_*` RPCs (which are
 *   granted to service_role alone) and, on the cron path, for the load.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export function serviceClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), noSession);
}

export function userClient(authorization: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    ...noSession,
    global: { headers: { Authorization: authorization } },
  });
}
