// Build-time fence: Next refuses to bundle this module into a Client Component (NFR-2).
// `scripts/` run under `tsx --conditions=react-server` so the marker resolves to its empty
// build there (see package.json `seed`); Vitest aliases it (vitest.config.ts).
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * Service-role client. Bypasses RLS and reaches the Auth Admin API.
 *
 * Only `scripts/` may import this module (NFR-2): `SUPABASE_SERVICE_ROLE_KEY`
 * lives in the engineer's `.env.local` and never reaches Vercel or the
 * browser. Throws when either variable is missing so a mis-targeted run
 * fails before it touches anything.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
