import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { config as proxyConfig } from "../proxy";
import { testStack } from "./setup";

// `connection()` needs Next's request scope (see tests/health-route.test.ts); only that export is stubbed.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

/**
 * Story 7.2 — /api/health end to end against the LOCAL stack (`supabase start`), plus the static contracts around it:
 * the route source never imports the service-role client, vercel.json schedules the daily probe, and proxy.ts leaves
 * /api/health outside the session guard (a probe with no cookie must never be redirected to /login).
 *
 * The app's client reads NEXT_PUBLIC_SUPABASE_*; `.env.local` may point them at the hosted project, so they are
 * re-targeted at the local test stack before the handler is imported (as tests/share-link.test.ts does).
 */
const stack = testStack();
if (stack) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = stack.url;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = stack.key;
}
const { GET } = await import("../app/api/health/route");

const ROUTE = "app/api/health/route.ts";

describe("GET /api/health against the local stack", () => {
  it.skipIf(!stack)("answers 200 { ok: true, db: 'ok', at } with the publishable key and no session", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, db: "ok" });
    expect(Math.abs(Date.now() - Date.parse(body.at))).toBeLessThan(60_000);
  });

  it("answers 503 { ok: false, code: 'db_unreachable' } when the database is not reachable", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9"; // discard port: nothing listens
    try {
      const res = await GET();
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ ok: false, code: "db_unreachable" });
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    }
  });
});

describe("the contracts around /api/health", () => {
  it("the route never imports the service-role client or reads a secret", () => {
    // code only — the header comment is allowed to NAME the things the code must not touch
    const src = readFileSync(ROUTE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/supabase\/admin/);
    expect(src).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|PROVIDER_API_KEY|DATABASE_URL|CRON_SECRET/);
    expect(src).toMatch(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
    expect(src).toMatch(/rpc\(\s*["']health_ping["']\s*\)/);
  });

  it("vercel.json schedules GET /api/health once a day (Hobby: at most daily)", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path: string; schedule: string }[] };
    expect(vercel.crons).toEqual([{ path: "/api/health", schedule: "0 6 * * *" }]);
  });

  it("ESLint fences lib/supabase/admin out of the app (any spelling) and leaves scripts/ and tests/ alone", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ overrideConfigFile: "eslint.config.mjs" });
    const probe = 'import "@/lib/supabase/admin";\nimport "../../../lib/supabase/admin";\nimport "../../../lib/supabase/admin.ts";\nexport {};\n';
    const fenced = await eslint.lintText(probe, { filePath: ROUTE });
    const restricted = fenced[0].messages.filter((m) => m.ruleId === "no-restricted-imports");
    expect(restricted.map((m) => m.line)).toEqual([1, 2, 3]);
    expect(restricted[0].message).toMatch(/publishable key/);
    // the real route is clean
    const real = await eslint.lintText(readFileSync(ROUTE, "utf8"), { filePath: ROUTE });
    expect(real[0].messages.filter((m) => m.ruleId === "no-restricted-imports")).toEqual([]);
    // the two legitimate homes of the service-role client
    for (const filePath of ["scripts/seed/users.ts", "tests/setup.ts"]) {
      const allowed = await eslint.lintText('import "../lib/supabase/admin";\nexport {};\n', { filePath });
      expect(allowed[0].messages.filter((m) => m.ruleId === "no-restricted-imports")).toEqual([]);
    }
  }, 30_000);

  it("proxy.ts leaves /api/health outside the session guard", () => {
    const matcher = new RegExp("^" + proxyConfig.matcher[0] + "$");
    expect(matcher.test("/api/health")).toBe(false);
    expect(matcher.test("/api/healthz")).toBe(true);
  });
});
