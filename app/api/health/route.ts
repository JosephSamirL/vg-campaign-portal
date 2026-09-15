import { createClient } from "@supabase/supabase-js";
import { connection, NextResponse } from "next/server";

/**
 * Story 7.2 — GET /api/health: the API-side keep-alive (architecture D-14, amendment #16).
 *
 * A Vercel cron (vercel.json, daily) and anyone with the URL hit this route; it asks the database
 * `health_ping()` (0014_health.sql — `select 'ok'`, executable by `anon` only) through PostgREST with the
 * PUBLISHABLE key and no session, exactly like the stranger's client on /share (lib/supabase/anon.ts). It never
 * imports lib/supabase/admin (ESLint `no-restricted-imports` fences that module to scripts/) and never reads a
 * service, provider or database secret: a public URL may only prove "the database answers", nothing more.
 *
 * Unauthenticated by design — proxy.ts leaves /api/health outside the session guard; do NOT create a Vercel
 * `CRON_SECRET` env (the name would clash with the Supabase Vault secret from 4.3/6.3 and add nothing).
 *
 * `export const dynamic = "force-dynamic"` is rejected by Next 16 when `cacheComponents` is on
 * (app/(portal)/campaigns/page.tsx); `await connection()` is the Cache Components way to force request-time
 * rendering, and `Cache-Control: no-store` keeps every hop from caching the answer.
 *
 * Every PostgREST call carries `AbortSignal.timeout(8_000)`: a hung database answers as the documented
 * `503 { ok: false, code: 'db_unreachable' }` (with `no-store`), not as Vercel's own 504 with no body.
 */
const DB_TIMEOUT_MS = 8_000;

export async function GET() {
  await connection();
  const headers = { "Cache-Control": "no-store" };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, code: "db_unreachable" }, { status: 503, headers });
  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(DB_TIMEOUT_MS) }) },
    });
    const { data, error } = await supabase.rpc("health_ping");
    if (error || data !== "ok") {
      return NextResponse.json({ ok: false, code: "db_unreachable" }, { status: 503, headers });
    }
    return NextResponse.json({ ok: true, db: "ok", at: new Date().toISOString() }, { headers });
  } catch {
    return NextResponse.json({ ok: false, code: "db_unreachable" }, { status: 503, headers });
  }
}
