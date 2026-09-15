"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@/lib/actions";
import { createClient } from "@/lib/supabase/server";

const credentials = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export async function signInWithPasswordAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const parsed = credentials.safeParse({
    email: String(form.get("email") ?? "").trim(),
    password: form.get("password"),
  });
  if (!parsed.success) {
    return { ok: false, code: "invalid_input", message: "Enter your email and password." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email.trim().toLowerCase(),
    password: parsed.data.password,
  });
  if (error) {
    // Same text for an unknown email and a wrong password: the allow-list must not be probeable.
    return { ok: false, code: "invalid_credentials", message: "Email or password is incorrect." };
  }

  redirect("/dashboard");
}

export async function signInWithGoogleAction() {
  const h = await headers();
  // Browsers send Origin on form posts; the fallback covers proxies (Vercel sets both x-forwarded-*).
  const origin =
    h.get("origin") ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const supabase = await createClient();
  // Server-side signInWithOAuth = PKCE; the verifier lands in a cookie and /auth/callback
  // exchanges the returned code. redirectTo must be in Supabase's Redirect URLs (Story 1.4).
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback` },
  });
  if (error || !data.url) redirect("/login?reason=oauth_failed");
  redirect(data.url);
}
