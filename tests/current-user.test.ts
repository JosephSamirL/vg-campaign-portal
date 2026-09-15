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
    maybeSingle.mockResolvedValue({ data: null });
    expect(await getCurrentAppUser()).toBeNull();
    expect(from).toHaveBeenCalledWith("app_users");
    expect(eq).toHaveBeenCalledWith("auth_user_id", "u1");
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
