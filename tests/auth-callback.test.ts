import { beforeEach, describe, expect, it, vi } from "vitest";

const exchangeCodeForSession = vi.fn();
const signOut = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession, signOut } }),
}));

const { GET: callback } = await import("../app/(public)/auth/callback/route");
const { GET: signoutGet, POST: signoutPost } = await import("../app/(public)/auth/signout/route");

const get = (path: string) => new Request(`http://localhost:3000${path}`);
const location = (res: Response) => new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search;

beforeEach(() => {
  exchangeCodeForSession.mockReset();
  signOut.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /auth/callback", () => {
  it("maps a sign-ups-off refusal to /login?reason=not_allowed without touching the session", async () => {
    const res = await callback(
      get("/auth/callback?error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance"),
    );
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(location(res)).toBe("/login?reason=not_allowed");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("recognises the refusal from the description alone", async () => {
    const res = await callback(get("/auth/callback?error=server_error&error_description=Signups%20not%20allowed"));
    expect(location(res)).toBe("/login?reason=not_allowed");
  });

  it("maps any other provider error to oauth_failed", async () => {
    const res = await callback(get("/auth/callback?error=access_denied&error_code=user_cancelled"));
    expect(location(res)).toBe("/login?reason=oauth_failed");
  });

  it("exchanges a code and lands on /dashboard", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await callback(get("/auth/callback?code=abc"));
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(location(res)).toBe("/dashboard");
  });

  it("maps a failed exchange to oauth_failed", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: "bad code" } });
    expect(location(await callback(get("/auth/callback?code=stale")))).toBe("/login?reason=oauth_failed");
  });

  it("sends a bare hit back to /login", async () => {
    expect(location(await callback(get("/auth/callback")))).toBe("/login");
  });
});

describe("/auth/signout", () => {
  it("signs out and passes the reason through", async () => {
    signOut.mockResolvedValue({ error: null });
    const res = await signoutGet(get("/auth/signout?reason=no_access"));
    expect(signOut).toHaveBeenCalled();
    expect(location(res)).toBe("/login?reason=no_access");
  });

  it("POST without a reason lands on plain /login", async () => {
    signOut.mockResolvedValue({ error: null });
    const res = await signoutPost(new Request("http://localhost:3000/auth/signout", { method: "POST" }));
    expect(location(res)).toBe("/login");
  });
});
