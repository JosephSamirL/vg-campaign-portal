import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Story 7.2 (AC2) — GET /api/health, unit level: the handler is a thin wrapper around `rpc('health_ping')`, so
 * @supabase/supabase-js is mocked here and the contract is pinned: which key builds the client (the PUBLISHABLE
 * key, no session, never the service role), `200 { ok, db, at }` for 'ok', `503 { ok: false, code: 'db_unreachable' }`
 * for an error or any other answer, `Cache-Control: no-store` on every response. The real round-trip against the
 * local stack lives in tests/health.test.ts.
 */
const rpc = vi.fn();
const createClient = vi.fn(() => ({ rpc }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));
// `connection()` (the Cache Components request-time opt-in the route awaits first) needs Next's request scope;
// outside `next start` it throws, so only that export is stubbed — NextResponse stays real.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const URL_ = "http://127.0.0.1:54321";
const KEY = "sb_publishable_unit_test";

beforeEach(() => {
  rpc.mockReset();
  createClient.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_must_never_be_used";
});

async function GET() {
  const mod = await import("../app/api/health/route");
  return mod.GET();
}

describe("GET /api/health (unit)", () => {
  it("answers 200 { ok: true, db: 'ok', at } when health_ping says 'ok'", async () => {
    rpc.mockResolvedValue({ data: "ok", error: null });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, db: "ok" });
    expect(typeof body.at).toBe("string");
    expect(Number.isNaN(Date.parse(body.at))).toBe(false);
    expect(rpc).toHaveBeenCalledWith("health_ping");
  });

  it("builds the client from NEXT_PUBLIC_SUPABASE_URL + the PUBLISHABLE key with no session — never the service role", async () => {
    rpc.mockResolvedValue({ data: "ok", error: null });
    await GET();
    expect(createClient).toHaveBeenCalledTimes(1);
    const [url, key, options] = createClient.mock.calls[0] as unknown as [string, string, { auth?: { persistSession?: boolean } }];
    expect(url).toBe(URL_);
    expect(key).toBe(KEY);
    expect(key).not.toBe(process.env.SUPABASE_SERVICE_ROLE_KEY);
    expect(options?.auth?.persistSession).toBe(false);
  });

  it("answers 503 { ok: false, code: 'db_unreachable' } on an rpc error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, code: "db_unreachable" });
  });

  it("answers 503 when the answer is anything but 'ok'", async () => {
    rpc.mockResolvedValue({ data: "nope", error: null });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, code: "db_unreachable" });
  });

  it("answers 503 (not a thrown 500) when the client rejects", async () => {
    rpc.mockRejectedValue(new Error("fetch failed"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, code: "db_unreachable" });
  });

  it("sends Cache-Control: no-store on both outcomes", async () => {
    rpc.mockResolvedValue({ data: "ok", error: null });
    expect((await GET()).headers.get("cache-control")).toBe("no-store");
    rpc.mockResolvedValue({ data: null, error: { message: "x" } });
    expect((await GET()).headers.get("cache-control")).toBe("no-store");
  });
});
