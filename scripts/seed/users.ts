// Story 1.4 — provision the allow-listed logins through the Auth Admin API.
//
// `supabase/seed.sql` puts the 7 `app_users` rows in place first (D-1). This
// script creates the matching auth users (`email_confirm: true`, so Google
// later auto-links to the same verified email — D-9), links
// `app_users.auth_user_id`, and appends generated passwords to the git-ignored
// `credentials.txt`. Existing auth users are never recreated or password-reset.
// Output is actions only (`created` / `exists` / `linked`) — never a password
// or key.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createAdminClient } from "../../lib/supabase/admin";
import type { Database } from "../../lib/database.types";

type AppUserRow = Database["public"]["Tables"]["app_users"]["Row"];
type SeedRow = Pick<AppUserRow, "email" | "role" | "brand_id"> & {
  brands: { code: string } | null;
};
type Admin = SupabaseClient<Database>;

const CREDENTIALS_FILE = "credentials.txt";

/** 24 random bytes → 32 base64url chars (AC requires ≥ 16). */
export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/** One `credentials.txt` line: email<TAB>password<TAB>brand<TAB>role. */
export function credentialLine(email: string, password: string, brand: string, role: string): string {
  return [email, password, brand, role].join("\t");
}

/** Existing file content → Map<lowercase email, full line>. Blank lines are dropped. */
export function parseCredentials(content: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of (content ?? "").split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const email = line.split("\t")[0].toLowerCase();
    map.set(email, [email, ...line.split("\t").slice(1)].join("\t"));
  }
  return map;
}

/**
 * Look an auth user up by (lowercase) email. Uses `auth.admin.getUserByEmail`
 * when the installed supabase-js has it; otherwise pages through
 * `auth.admin.listUsers` once and matches on lowercase email.
 */
async function findAuthUserByEmail(admin: Admin, email: string, cache: { users?: Map<string, User> }): Promise<User | null> {
  const api = admin.auth.admin as unknown as {
    getUserByEmail?: (email: string) => Promise<{ data: { user: User | null }; error: { message: string; status?: number } | null }>;
  };
  if (typeof api.getUserByEmail === "function") {
    const { data, error } = await api.getUserByEmail(email);
    if (error && error.status !== 404) throw new Error(`getUserByEmail ${email}: ${error.message}`);
    return data?.user ?? null;
  }
  if (!cache.users) {
    cache.users = new Map<string, User>();
    for (let page = 1; ; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(`listUsers page ${page}: ${error.message}`);
      for (const u of data.users) if (u.email) cache.users.set(u.email.toLowerCase(), u);
      if (data.users.length < 1000) break;
    }
  }
  return cache.users.get(email) ?? null;
}

export async function provisionUsers(): Promise<void> {
  dotenv.config({ path: ".env.local", quiet: true });
  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("app_users")
    .select("email, role, brand_id, brands(code)")
    .order("email");
  if (error) throw new Error(`app_users select: ${error.message}`);
  if (!rows || rows.length === 0) {
    throw new Error("app_users is empty — apply supabase/seed.sql to this database first");
  }

  const credentialsPath = path.resolve(process.cwd(), CREDENTIALS_FILE);
  const credentials = parseCredentials(
    existsSync(credentialsPath) ? readFileSync(credentialsPath, "utf8") : undefined,
  );
  const cache: { users?: Map<string, User> } = {};

  for (const row of rows as SeedRow[]) {
    const email = row.email.toLowerCase();
    const brand = row.brands?.code ?? row.brand_id;
    let id: string;

    const found = await findAuthUserByEmail(admin, email, cache);
    if (found) {
      console.log("exists", email);
      id = found.id;
    } else {
      const password = generatePassword();
      const { data, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (createError || !data.user) throw new Error(`createUser ${email}: ${createError?.message ?? "no user returned"}`);
      console.log("created", email);
      id = data.user.id;
      credentials.set(email, credentialLine(email, password, brand, row.role));
    }

    const { error: linkError } = await admin
      .from("app_users")
      .update({ auth_user_id: id })
      .eq("email", email);
    if (linkError) throw new Error(`link ${email}: ${linkError.message}`);
    console.log("linked", email);
  }

  const lines = [...credentials.values()];
  writeFileSync(credentialsPath, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
  console.log(`${CREDENTIALS_FILE}: ${lines.length} line(s)`);
}
