import { describe, expect, it } from "vitest";
import { config } from "../proxy";

// Next.js compiles `config.matcher` into an anchored path regex; mirror that here so the
// exclusion list in proxy.ts is a tested contract (architecture amendment #13: /share and
// /api/health must stay reachable without a session).
const matcher = new RegExp("^" + config.matcher[0] + "$");

describe("proxy.ts matcher", () => {
  it.each(["/share/abc", "/api/health", "/login", "/auth/callback", "/_next/static/x.js"])(
    "does not match %s (never redirected to /login)",
    (path) => {
      expect(matcher.test(path)).toBe(false);
    },
  );

  it.each(["/", "/dashboard", "/campaigns/1"])("matches %s (session refreshed + guarded)", (path) => {
    expect(matcher.test(path)).toBe(true);
  });
});
