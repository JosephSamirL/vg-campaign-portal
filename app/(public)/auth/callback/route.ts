import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * OAuth (PKCE) return leg. Supabase Auth lands here with either `?code=…` (a pre-created,
 * allow-listed user) or `?error=…&error_code=…&error_description=…` (sign-ups are OFF, so a
 * Google account with no `app_users` row is refused before any session exists — D-9).
 * A route handler cannot render, so every outcome is a redirect to /login?reason=….
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const p = url.searchParams;
  const to = (path: string) => NextResponse.redirect(new URL(path, url.origin));

  const error = p.get("error");
  if (error) {
    const code = p.get("error_code");
    const description = p.get("error_description") ?? "";
    console.warn("oauth_error", code, description);
    const refused = code === "signup_disabled" || /signups not allowed/i.test(description);
    return to(refused ? "/login?reason=not_allowed" : "/login?reason=oauth_failed");
  }

  const code = p.get("code");
  if (code) {
    const supabase = await createClient();
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    return to(exchangeError ? "/login?reason=oauth_failed" : "/dashboard");
  }

  return to("/login");
}
