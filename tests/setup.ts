import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createBrowserClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../lib/database.types";
import { credentialsFileFor, parseCredentials } from "../scripts/seed/users";

// Local-only env for integration tests against `supabase start`. Never committed.
// `.env.test` carries the local-stack test logins (Story 1.5); `.env.local` the app's own
// URL/key. dotenv never overrides a variable that is already set.
dotenv.config({ path: ".env.test" });
dotenv.config({ path: ".env.local" });

/**
 * Story 4.2 — per-brand sign-in for the integration tests (architecture: "clients for owner/analyst
 * per brand from env"). Everything below targets the LOCAL stack only: `TEST_SUPABASE_URL` must be
 * 127.0.0.1:54321 unless ALLOW_HOSTED_TESTS=1 is set deliberately, so a hosted URL in `.env.local`
 * can never be signed into (or written to, via the service role) by accident.
 *
 * Credentials for `signInAs(brand, role)` are looked up in this order:
 *   1. `TEST_<BRAND>_<ROLE>_EMAIL` / `TEST_<BRAND>_<ROLE>_PASSWORD` (the `.env.test` convention since 1.5)
 *   2. `credentials.<host>.txt` for the test host (`pnpm seed` writes one per Supabase host, Story 1.4)
 *   3. the legacy `credentials.txt` (first hosted run) — only if nothing else matched
 * A password from a file that does not sign in is reported, not silently skipped.
 */
export type TestBrand = "KILELE" | "KAROO" | "MARRAKECH";
export type TestRole = "owner" | "analyst";
export type TestClient = SupabaseClient<Database>;

export const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";

/** Only the local stack is a legal target unless the operator opts in explicitly. */
export function isLocalSupabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.hostname === "127.0.0.1" && u.port === "54321";
  } catch {
    return false;
  }
}

/** The test stack's URL + publishable key from `.env.test`; `null` when either is missing. */
export function testStack(): { url: string; key: string } | null {
  const url = process.env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function assertLocal(url: string, what: string): void {
  if (!isLocalSupabaseUrl(url) && process.env.ALLOW_HOSTED_TESTS !== "1") {
    throw new Error(
      `tests/setup.ts: ${what} must target the local stack (${LOCAL_SUPABASE_URL}); refusing ${url}. ` +
        `Set ALLOW_HOSTED_TESTS=1 to override deliberately.`,
    );
  }
}

/** The app's browser client with an in-memory cookie jar (no `document` here); anonymous until signed in. */
export function anonClient(): TestClient {
  const stack = testStack();
  if (!stack) throw new Error("tests/setup.ts: TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY are not set (.env.test)");
  assertLocal(stack.url, "signing in");
  const jar = new Map<string, string>();
  return createBrowserClient<Database>(stack.url, stack.key, {
    isSingleton: false,
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
}

export type TestCredentials = { email: string; password: string; source: string };

/** Credentials for one login, from env first, then the per-host credentials file, then the legacy one. */
export function credentialsFor(brand: TestBrand, role: TestRole, supabaseUrl = process.env.TEST_SUPABASE_URL): TestCredentials | null {
  const prefix = `TEST_${brand}_${role.toUpperCase()}`;
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (email && password) return { email, password, source: `${prefix}_EMAIL/_PASSWORD` };

  const files = [supabaseUrl ? credentialsFileFor(supabaseUrl) : null, "credentials.txt"].filter((f): f is string => !!f);
  for (const file of files) {
    const full = path.resolve(process.cwd(), file);
    if (!existsSync(full)) continue;
    for (const line of parseCredentials(readFileSync(full, "utf8")).values()) {
      const [lineEmail, linePassword, lineBrand, lineRole] = line.split("\t");
      if (lineBrand?.toUpperCase() === brand && lineRole?.toLowerCase() === role && lineEmail && linePassword) {
        return { email: lineEmail, password: linePassword, source: file };
      }
    }
  }
  return null;
}

export type SignedIn = { supabase: TestClient; email: string; userId: string; brandId: string; role: TestRole };

/** A real password session for `<brand>.<role>` on the local stack, with its `app_users` row verified. */
export async function signInAs(brand: TestBrand, role: TestRole): Promise<SignedIn> {
  const creds = credentialsFor(brand, role);
  if (!creds) {
    throw new Error(
      `tests/setup.ts: no credentials for the ${brand} ${role} — set TEST_${brand}_${role.toUpperCase()}_EMAIL/_PASSWORD in the ` +
        `git-ignored .env.test, or keep the local credentials.<host>.txt that \`pnpm seed\` writes (see .env.example).`,
    );
  }
  const supabase = anonClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: creds.email, password: creds.password });
  if (error || !data.user) {
    throw new Error(`tests/setup.ts: sign-in failed for the ${brand} ${role} (${creds.email}, from ${creds.source}): ${error?.message ?? "no user"}`);
  }
  const { data: me, error: meError } = await supabase.from("app_users").select("brand_id, role, brands(code)").eq("email", creds.email).single();
  if (meError || !me) throw new Error(`tests/setup.ts: no app_users row for ${creds.email}: ${meError?.message ?? "not found"}`);
  if (me.role !== role || me.brands?.code !== brand) {
    throw new Error(`tests/setup.ts: ${creds.email} is ${me.brands?.code ?? "?"} ${me.role}, not ${brand} ${role}`);
  }
  return { supabase, email: creds.email, userId: data.user.id, brandId: me.brand_id, role };
}

let cachedServiceKey: string | undefined;

/**
 * The local stack's service-role key: `TEST_SUPABASE_SERVICE_ROLE_KEY` when set, otherwise read once from
 * `supabase status -o env` (the running local stack). Never `SUPABASE_SERVICE_ROLE_KEY` from `.env.local` —
 * that one may belong to the hosted project.
 */
export function localServiceRoleKey(): string {
  if (process.env.TEST_SUPABASE_SERVICE_ROLE_KEY) return process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (cachedServiceKey) return cachedServiceKey;
  let out: string;
  try {
    out = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    throw new Error("tests/setup.ts: no TEST_SUPABASE_SERVICE_ROLE_KEY and `supabase status` failed — is the local stack running?");
  }
  const match = out.match(/^SERVICE_ROLE_KEY="?([^"\n]+)"?$/m);
  if (!match) throw new Error("tests/setup.ts: `supabase status -o env` printed no SERVICE_ROLE_KEY");
  cachedServiceKey = match[1];
  return cachedServiceKey;
}

/**
 * A service-role client for test teardown only (deleting the sends a test confirmed, so the shared local
 * DB stays clean and the test is repeatable). Bypasses RLS — never use it to call an RPC under test: it
 * would skip the role check and prove nothing.
 */
export function serviceClient(): TestClient {
  const stack = testStack();
  if (!stack) throw new Error("tests/setup.ts: TEST_SUPABASE_URL is not set (.env.test)");
  assertLocal(stack.url, "the service-role client");
  return createClient<Database>(stack.url, localServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Story 6.3 — a cross-file mutex for the suites that dispatch real batches against the shared local stack. Vitest
 * runs files in parallel; `tests/send-concurrency.test.ts` (dispatch) and `tests/ingestion.test.ts` (the poller)
 * both create `provider_batches` rows inside the poll window, and the poller polls EVERY batch in the window — so
 * the two must not overlap. An atomic `mkdir` under `.vitest-locks/` is the lock (the OS guarantees exactly one
 * winner); a lock older than `staleMs` belongs to a crashed run and is taken over. Returns the release function.
 */
export async function acquireTestLock(name: string, { timeoutMs = 180_000, staleMs = 5 * 60_000 }: { timeoutMs?: number; staleMs?: number } = {}): Promise<() => void> {
  const dir = path.resolve(process.cwd(), ".vitest-locks");
  const lock = path.join(dir, name);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { recursive: true, force: true }); // a crashed run's leftover
          continue;
        }
      } catch {
        continue; // released between the stat and now
      }
      if (Date.now() - started > timeoutMs) throw new Error(`tests/setup.ts: could not acquire test lock "${name}" within ${timeoutMs} ms (${lock})`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
