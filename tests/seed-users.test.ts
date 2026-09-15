import { describe, expect, it } from "vitest";
import {
  credentialLine,
  credentialsFileFor,
  generatePassword,
  parseCredentials,
} from "../scripts/seed/users";

describe("scripts/seed/users helpers", () => {
  it("generates a password of at least 16 characters, different every time", () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url — safe on one tab-separated line
  });

  it("formats one credentials line as email<TAB>password<TAB>brand<TAB>role", () => {
    expect(credentialLine("kilele.owner@vg-eval.test", "pw", "KILELE", "owner")).toBe(
      "kilele.owner@vg-eval.test\tpw\tKILELE\towner",
    );
  });

  it("parses an existing credentials file into a map keyed by lowercase email", () => {
    const map = parseCredentials("A@X.test\tp1\tKILELE\towner\n\nb@x.test\tp2\tKAROO\tanalyst\n");
    expect([...map.keys()]).toEqual(["a@x.test", "b@x.test"]);
    expect(map.get("b@x.test")).toBe("b@x.test\tp2\tKAROO\tanalyst");
  });

  it("names the credentials file after the target host so local and hosted runs never overwrite each other", () => {
    expect(credentialsFileFor("http://127.0.0.1:54321")).toBe("credentials.127.0.0.1-54321.txt");
    expect(credentialsFileFor("https://qaocabdpaxetofqcfgsa.supabase.co")).toBe(
      "credentials.qaocabdpaxetofqcfgsa.supabase.co.txt",
    );
    expect(credentialsFileFor("http://127.0.0.1:54321")).not.toBe(credentialsFileFor("https://x.supabase.co"));
  });

  it("returns an empty map for missing or empty content", () => {
    expect(parseCredentials("").size).toBe(0);
    expect(parseCredentials(undefined).size).toBe(0);
  });
});
