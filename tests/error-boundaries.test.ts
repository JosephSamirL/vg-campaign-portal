import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every `error.tsx` (root + the five portal routes) wires its Retry to Next 16's `retry`
 * callback — the one that does `startTransition(() => { router.refresh(); reset() })` — not to
 * `reset`, which only clears the boundary and replays the same server failure (3.3 review,
 * Medium #2; 3.2 / 3.4 Low). The shadcn `Button` is replaced by a recorder so the `onClick`
 * identity can be asserted without a DOM.
 */

const clicks: unknown[] = [];
vi.mock("@/components/ui/button", () => ({
  Button: ({ onClick, children }: { onClick?: unknown; children?: React.ReactNode }) => {
    clicks.push(onClick);
    return createElement("button", { "data-testid": "retry-button" }, children);
  },
}));

const boundaries: Array<[string, () => Promise<{ default: React.ComponentType<{ error: Error; retry: () => void }> }>, string]> = [
  ["app/error.tsx", () => import("../app/error"), "Something went wrong"],
  ["dashboard", () => import("../app/(portal)/dashboard/error"), "dashboard-error"],
  ["contacts", () => import("../app/(portal)/contacts/error"), "contacts-error"],
  ["campaigns", () => import("../app/(portal)/campaigns/error"), "campaigns-error"],
  ["campaigns/[id]", () => import("../app/(portal)/campaigns/[id]/error"), "campaign-error"],
  ["imports", () => import("../app/(portal)/imports/error"), "imports-error"],
];

beforeEach(() => {
  clicks.length = 0;
});

describe.each(boundaries)("%s error boundary", (_name, load, marker) => {
  it("renders the destructive alert and wires Retry to `retry`, never `reset`", async () => {
    const { default: Boundary } = await load();
    const retry = vi.fn();
    const reset = vi.fn();
    const error = Object.assign(new Error('relation "public.v_contacts" does not exist'), { digest: "abc123" });
    const html = renderToStaticMarkup(createElement(Boundary, { error, retry, reset } as never));
    expect(html).toContain(marker);
    expect(html).toMatch(/data-testid="retry-button">(Retry|Try again)</);
    expect(clicks).toEqual([retry]);
    expect(clicks[0]).not.toBe(reset);
    // the raw message is logged (client effect), never rendered
    expect(html).not.toContain("does not exist");
  });
});
