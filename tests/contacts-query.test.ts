import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_SIZE, contactsParamsSchema, getContactsPage } from "../lib/queries/contacts";

/**
 * `lib/queries/contacts.ts` contract (Story 3.3): the zod boundary is total (every invalid
 * value falls back to its default, never a throw) and `getContactsPage` issues exactly the
 * server-side query the story pins — `v_contacts`, `count: 'exact'`, `range()`, the `or`
 * search — and maps PostgREST answers to a `Result` without ever inventing a count.
 */

describe("contactsParamsSchema", () => {
  it("defaults an empty query string", () => {
    expect(contactsParamsSchema.parse({})).toEqual({ page: 1, q: "", status: undefined, contactable: undefined });
  });

  it("parses the documented example", () => {
    expect(contactsParamsSchema.parse({ page: "2", q: "amina", status: "active", contactable: "true" })).toEqual({
      page: 2,
      q: "amina",
      status: "active",
      contactable: "true",
    });
  });

  it("falls back to page 1 for abc / 0 / -3 / 1.5 / arrays", () => {
    for (const page of ["abc", "0", "-3", "1.5", ["2", "3"], ""]) {
      expect(contactsParamsSchema.parse({ page }).page).toBe(1);
    }
  });

  it("keeps the Kilele last page", () => {
    expect(contactsParamsSchema.parse({ page: "1681" }).page).toBe(1681);
  });

  it("trims q, strips PostgREST reserved characters, keeps dots for emails", () => {
    expect(contactsParamsSchema.parse({ q: "  sarah.wanjiru " }).q).toBe("sarah.wanjiru");
    expect(contactsParamsSchema.parse({ q: 'a,b(c)d"e\\f' }).q).toBe("a b c d e f");
    expect(contactsParamsSchema.parse({ q: ",()\"" }).q).toBe("");
  });

  it("drops q over 64 characters and non-string q", () => {
    expect(contactsParamsSchema.parse({ q: "x".repeat(65) }).q).toBe("");
    expect(contactsParamsSchema.parse({ q: "x".repeat(64) }).q).toBe("x".repeat(64));
    expect(contactsParamsSchema.parse({ q: ["a", "b"] }).q).toBe("");
  });

  it("accepts only the five status values and the two contactable values", () => {
    expect(contactsParamsSchema.parse({ status: "unknown" }).status).toBe("unknown");
    expect(contactsParamsSchema.parse({ status: "deleted" }).status).toBeUndefined();
    expect(contactsParamsSchema.parse({ status: "" }).status).toBeUndefined();
    expect(contactsParamsSchema.parse({ contactable: "false" }).contactable).toBe("false");
    expect(contactsParamsSchema.parse({ contactable: "yes" }).contactable).toBeUndefined();
    expect(contactsParamsSchema.parse({ contactable: "" }).contactable).toBeUndefined();
  });
});

type Canned = { data: unknown; error: unknown; count?: number | null };
const responses: Canned[] = [];
const calls: Array<[string, unknown[]]> = [];

function builder() {
  const chain: Record<string, unknown> = {};
  const record = (method: string) =>
    (...args: unknown[]) => {
      calls.push([method, args]);
      return chain;
    };
  for (const m of ["select", "or", "is", "eq", "order", "range"]) chain[m] = record(m);
  chain.then = (resolve: (r: Canned) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(responses.shift() ?? { data: null, error: { message: "no mock" } }).then(resolve, reject);
  return chain;
}

const from = vi.fn(() => builder());
const supabase = { from } as unknown as Parameters<typeof getContactsPage>[0];

const SELECT = "id, external_id, full_name, email, phone, country, city, status, consent_marketing, contactable, signup_at";
const ORDER: Array<[string, unknown[]]> = [
  ["order", ["signup_at", { ascending: false, nullsFirst: false }]],
  ["order", ["id"]],
];

beforeEach(() => {
  responses.length = 0;
  calls.length = 0;
  from.mockClear();
});

describe("getContactsPage", () => {
  it("reads v_contacts with count exact, the story's order, and the first page range", async () => {
    responses.push({ data: [{ id: "a" }], error: null, count: 82205 });
    const r = await getContactsPage(supabase, contactsParamsSchema.parse({}));
    expect(from).toHaveBeenCalledWith("v_contacts");
    expect(calls).toEqual([["select", [SELECT, { count: "exact" }]], ...ORDER, ["range", [0, PAGE_SIZE - 1]]]);
    expect(r).toEqual({ ok: true, data: { rows: [{ id: "a" }], count: 82205, page: 1, pages: 1645 } });
  });

  it("applies q as a PostgREST or-filter with * wildcards, status and contactable as filters", async () => {
    responses.push({ data: [], error: null, count: 0 });
    await getContactsPage(supabase, contactsParamsSchema.parse({ q: "ami", status: "active", contactable: "true", page: "3" }));
    expect(calls).toEqual([
      ["select", [SELECT, { count: "exact" }]],
      ...ORDER,
      ["or", ["full_name.ilike.*ami*,email.ilike.ami*"]],
      ["eq", ["status", "active"]],
      ["eq", ["contactable", true]],
      ["range", [100, 149]],
    ]);
  });

  it("maps status=unknown to `is null` and contactable=false to eq false", async () => {
    responses.push({ data: [], error: null, count: 0 });
    await getContactsPage(supabase, contactsParamsSchema.parse({ status: "unknown", contactable: "false" }));
    expect(calls).toContainEqual(["is", ["status", null]]);
    expect(calls).toContainEqual(["eq", ["contactable", false]]);
    expect(calls.find(([m]) => m === "or")).toBeUndefined();
  });

  it("returns ok:false with the message on a query error — never a zero count", async () => {
    responses.push({ data: null, error: { message: "relation does not exist", code: "42P01" }, count: null });
    const r = await getContactsPage(supabase, contactsParamsSchema.parse({}));
    expect(r).toEqual({ ok: false, message: "relation does not exist" });
  });

  it("treats a page past the end (PGRST103) as an empty page with the exact count from a head query", async () => {
    responses.push({ data: null, error: { message: "Requested range not satisfiable", code: "PGRST103" }, count: null });
    responses.push({ data: null, error: null, count: 82205 });
    const r = await getContactsPage(supabase, contactsParamsSchema.parse({ page: "99999", q: "ami" }));
    expect(r).toEqual({ ok: true, data: { rows: [], count: 82205, page: 99999, pages: 1645 } });
    // the head query carries the same filters, so the count is the filtered total
    const head = calls.slice(calls.findIndex(([m, a]) => m === "select" && (a[1] as { head?: boolean })?.head));
    expect(head[0]).toEqual(["select", ["id", { count: "exact", head: true }]]);
    expect(head).toContainEqual(["or", ["full_name.ilike.*ami*,email.ilike.ami*"]]);
    expect(head.find(([m]) => m === "range")).toBeUndefined();
  });

  it("propagates an error from the head query too", async () => {
    responses.push({ data: null, error: { message: "range", code: "PGRST103" }, count: null });
    responses.push({ data: null, error: { message: "boom" }, count: null });
    const r = await getContactsPage(supabase, contactsParamsSchema.parse({ page: "99999" }));
    expect(r).toEqual({ ok: false, message: "boom" });
  });

  it("pages is at least 1 when the count is 0", async () => {
    responses.push({ data: [], error: null, count: 0 });
    const r = await getContactsPage(supabase, contactsParamsSchema.parse({}));
    expect(r).toEqual({ ok: true, data: { rows: [], count: 0, page: 1, pages: 1 } });
  });
});
