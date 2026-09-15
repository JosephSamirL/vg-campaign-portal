import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-action unit test: Supabase and Next's redirect are mocked; only the action's own
// contract is asserted (input normalisation, error mapping, redirect target).
const signInWithPassword = vi.fn();
const signInWithOAuth = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithPassword, signInWithOAuth } }),
}));

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect }));
let requestHeaders = new Headers({ origin: "http://localhost:3000" });
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { signInWithGoogleAction, signInWithPasswordAction } = await import(
  "../app/(public)/login/actions"
);

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  signInWithPassword.mockReset();
  signInWithOAuth.mockReset();
  redirect.mockClear();
});

describe("signInWithPasswordAction", () => {
  it("rejects malformed input before calling Supabase", async () => {
    const result = await signInWithPasswordAction(null, form({ email: "nope", password: "" }));
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("trims and lowercases the email, then redirects to /dashboard on success", async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: null });
    await expect(
      signInWithPasswordAction(null, form({ email: "  Kilele.Owner@VG-Eval.test ", password: "pw" })),
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "kilele.owner@vg-eval.test",
      password: "pw",
    });
  });

  it("maps any auth failure to the single 'incorrect' message", async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: { message: "Invalid login credentials" } });
    const result = await signInWithPasswordAction(null, form({ email: "x@y.test", password: "bad" }));
    expect(result).toEqual({
      ok: false,
      code: "invalid_credentials",
      message: "Email or password is incorrect.",
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("signInWithGoogleAction", () => {
  it("starts the PKCE flow with redirectTo = <origin>/auth/callback and follows the provider URL", async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/o/x" }, error: null });
    await expect(signInWithGoogleAction()).rejects.toThrow("NEXT_REDIRECT:https://accounts.google.com/o/x");
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "http://localhost:3000/auth/callback" },
    });
  });

  it("derives the origin from x-forwarded-proto/host when Origin is absent", async () => {
    requestHeaders = new Headers({ "x-forwarded-proto": "http", "x-forwarded-host": "localhost:3000", host: "localhost:3000" });
    signInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/o/y" }, error: null });
    await expect(signInWithGoogleAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "http://localhost:3000/auth/callback" },
    });
    requestHeaders = new Headers({ origin: "http://localhost:3000" });
  });

  it("falls back to /login?reason=oauth_failed when the provider gives no URL", async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: null }, error: { message: "provider disabled" } });
    await expect(signInWithGoogleAction()).rejects.toThrow("NEXT_REDIRECT:/login?reason=oauth_failed");
  });
});
