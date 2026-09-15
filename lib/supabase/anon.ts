import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * The stranger's client (Story 5.3, D-2 / D-10 / FR-31): `@supabase/supabase-js` with the
 * publishable key and NO cookies — never `@supabase/ssr`, never `next/headers`. Every request it
 * makes runs as Postgres role `anon`, which may execute exactly one function
 * (`get_shared_results`) and read no table. A signed-in brand user opening a share URL is
 * therefore just another stranger: their JWT never rides along, so nothing on `/share/[token]`
 * can ever be unlocked with a brand user's privileges.
 *
 * No session is persisted, refreshed or read from the URL — there is none. Create one per call
 * (Fluid compute: never a module-level singleton).
 */
export function createAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  if (!key) throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set");
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
