import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Server Components cannot clear cookies, so both the nav's logout button and the
 * (portal) layout's "session without brand access" refusal go through this handler.
 * `?reason=` is passed through to /login so the page can explain why.
 */
async function signOutAndRedirect(request: Request) {
  const url = new URL(request.url);
  const supabase = await createClient();
  await supabase.auth.signOut();
  const reason = url.searchParams.get("reason");
  const target = new URL("/login", url.origin);
  if (reason) target.searchParams.set("reason", reason);
  return NextResponse.redirect(target, 303);
}

export async function GET(request: Request) {
  return signOutAndRedirect(request);
}

export async function POST(request: Request) {
  return signOutAndRedirect(request);
}
