import { describe, expect, it } from "vitest";
import { isCurrentPath } from "@/components/layout/nav-links";

describe("nav current-page highlight", () => {
  it("marks the exact route and its nested routes, nothing else", () => {
    expect(isCurrentPath("/campaigns", "/campaigns")).toBe(true);
    expect(isCurrentPath("/campaigns/8f0c", "/campaigns")).toBe(true);
    expect(isCurrentPath("/campaigns-old", "/campaigns")).toBe(false);
    expect(isCurrentPath("/dashboard", "/contacts")).toBe(false);
    expect(isCurrentPath("/contacts?page=2", "/contacts")).toBe(false); // pathname never carries the query
  });
});
