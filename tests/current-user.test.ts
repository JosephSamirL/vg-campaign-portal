import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, from }),
}));

const { getCurrentAppUser } = await import("../lib/current-user");

beforeEach(() => {
  getUser.mockReset();
  maybeSingle.mockReset();
  from.mockClear();
});

describe("getCurrentAppUser", () => {
  it("is null without a session and never queries app_users", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect(await getCurrentAppUser()).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("is null for a session with no app_users row (the layout then signs out with no_access)", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getCurrentAppUser()).toBeNull();
    expect(from).toHaveBeenCalledWith("app_users");
    expect(eq).toHaveBeenCalledWith("auth_user_id", "u1");
  });

  it("is null when Auth reports a missing session (AuthSessionMissingError), not an error", async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400 },
    });
    expect(await getCurrentAppUser()).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("throws (→ error.tsx) when getUser fails for a non-session reason instead of reading as no_access", async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 },
    });
    await expect(getCurrentAppUser()).rejects.toThrow("auth.getUser failed: fetch failed");
    expect(from).not.toHaveBeenCalled();
  });

  it("throws (→ error.tsx) when the app_users query errors instead of returning null", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u3" } } });
    maybeSingle.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    await expect(getCurrentAppUser()).rejects.toThrow("app_users lookup failed: canceling statement due to statement timeout");
  });

  it("returns email, role, brand id/name/code for an allow-listed session", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u2" } } });
    maybeSingle.mockResolvedValue({
      data: {
        email: "kilele.analyst@vg-eval.test",
        role: "analyst",
        brand_id: "b-kilele",
        brands: { name: "Kilele Rides", code: "KILELE" },
      },
    });
    expect(await getCurrentAppUser()).toEqual({
      email: "kilele.analyst@vg-eval.test",
      role: "analyst",
      brand_id: "b-kilele",
      brand_name: "Kilele Rides",
      brand_code: "KILELE",
    });
  });
});
