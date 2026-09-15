import { cache } from "react";
import type { Database } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export type AppRole = Database["public"]["Enums"]["app_role"];

export type CurrentAppUser = {
  email: string;
  role: AppRole;
  brand_id: string;
  brand_name: string;
  brand_code: string;
};

/**
 * The signed-in user's allow-list row, or null. `role` is the single source later
 * stories use to hide owner-only controls (server-side refusal is Epics 4/5).
 *
 * Reads through the cookie-session server client, so RLS applies: `app_users` yields
 * only the caller's own row and the embedded `brands(name, code)` only their brand.
 * Null means "session without an app_users row / brand" — the (portal) layout signs
 * that session out. Wrapped in React `cache` so one render hits the DB once.
 */
export const getCurrentAppUser = cache(async (): Promise<CurrentAppUser | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("app_users")
    .select("email, role, brand_id, brands(name, code)")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!data?.brand_id || !data.brands) return null;
  return {
    email: data.email,
    role: data.role,
    brand_id: data.brand_id,
    brand_name: data.brands.name,
    brand_code: data.brands.code,
  };
});
