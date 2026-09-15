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

  it("ESLint fences lib/supabase/admin out of the app (alias, relative, suffixed, re-export, dynamic import, require, lib-internal) and leaves scripts/ alone", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ overrideConfigFile: "eslint.config.mjs" });
    const fence = async (filePath: string, src: string) => {
      const [r] = await eslint.lintText(`${src}\nexport {};\n`, { filePath });
      return r.messages.filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax");
    };
    // every static spelling of the module path, from a route
    const probe = [
      'import "@/lib/supabase/admin";',
      'import "../../../lib/supabase/admin";',
      'import "../../../lib/supabase/admin.ts";',
      'import "../../../lib/supabase/admin.js";',
      'export * from "@/lib/supabase/admin";',
    ].join("\n");
    const fenced = await fence(ROUTE, probe);
    expect(fenced.map((m) => m.line)).toEqual([1, 2, 3, 4, 5]);
    expect(fenced[0].message).toMatch(/publishable key/);
    // dynamic import() and require() are not visited by no-restricted-imports — no-restricted-syntax covers them
    for (const src of [
      'const m = await import("@/lib/supabase/admin");',
      'const m = await import("../../../lib/supabase/admin.ts");',
      'const m = require("@/lib/supabase/admin");',
      'const m = require("../../../lib/supabase/admin");',
    ]) {
      expect((await fence(ROUTE, src)).map((m) => m.ruleId), src).toContain("no-restricted-syntax");
    }
    // inside lib/**, the short relative spellings are fenced by basename
    for (const [filePath, src] of [
      ["lib/supabase/anon.ts", 'import "./admin";'],
      ["lib/supabase/server.ts", 'export { createAdminClient } from "./admin.ts";'],
      ["lib/queries/contacts.ts", 'import "../supabase/admin";'],
      ["lib/actions.ts", 'import "./supabase/admin";'],
      ["lib/actions.ts", 'const m = await import("./supabase/admin");'],
    ] as const) {
      expect((await fence(filePath, src)).length, `${filePath}: ${src}`).toBeGreaterThan(0);
    }
    // tests/ is NOT exempt (nothing under tests/ imports the service-role client; tests/setup.ts builds its own client)
    expect((await fence("tests/setup.ts", 'import "../lib/supabase/admin";')).length).toBeGreaterThan(0);
    // the real route, the module itself and the other app imports are clean
    const real = await eslint.lintText(readFileSync(ROUTE, "utf8"), { filePath: ROUTE });
    expect(real[0].messages.filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax")).toEqual([]);
    expect(await fence("lib/supabase/admin.ts", 'import { createClient } from "@supabase/supabase-js";')).toEqual([]);
    expect(await fence(ROUTE, 'import "@/lib/supabase/anon";\nconst z = await import("zod");\nconst fs = require("node:fs");')).toEqual([]);
    // the one legitimate home of the service-role client
    expect(await fence("scripts/seed/users.ts", 'import "../../lib/supabase/admin";')).toEqual([]);
  }, 30_000);

  it("proxy.ts leaves /api/health outside the session guard", () => {
    const matcher = new RegExp("^" + proxyConfig.matcher[0] + "$");
    expect(matcher.test("/api/health")).toBe(false);
    expect(matcher.test("/api/healthz")).toBe(true);
  });
});
