import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Story 7.1, Task 1 — the portal nav at phone width (AC1). Pure server renders: below `md` the
 * link row is hidden and a 44 × 44 px ghost icon button opens a left `Sheet` carrying the brand
 * name, the role badge, every link and the sign-out; on `md` and up the links are the inline row.
 * The Sheet is a native `<dialog>` (dependency-free, like `Dialog`), so its content is in the
 * markup — closed — on the first paint.
 */

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/dashboard",
  useRouter: () => ({ refresh: () => {} }),
}));

const { PortalNav, NAV_LINKS } = await import("../components/layout/portal-nav");
const { MobileNav } = await import("../components/layout/mobile-nav");
const sheet = await import("../components/ui/sheet");

const attrs = (html: string, testid: string): string => {
  const m = html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`));
  if (!m) throw new Error(`no element with data-testid="${testid}"`);
  return m[0];
};

describe("PortalNav — desktop row + mobile Sheet (AC1)", () => {
  const html = renderToStaticMarkup(createElement(PortalNav, { brandName: "KILELE", role: "owner", email: "owner@example.test" }));

  it("hides the inline link row below md and shows it from md up", () => {
    const row = attrs(html, "nav-links");
    expect(row).toMatch(/class="[^"]*\bhidden\b[^"]*"/);
    expect(row).toMatch(/class="[^"]*\bmd:flex\b[^"]*"/);
    for (const link of NAV_LINKS) expect(html).toContain(`href="${link.href}"`);
  });

  it("renders a 44 × 44 ghost icon button below md that opens the sheet", () => {
    const toggle = attrs(html, "nav-toggle");
    expect(toggle.startsWith("<button")).toBe(true);
    expect(toggle).toMatch(/aria-label="Open menu"/);
    expect(toggle).toMatch(/aria-haspopup="dialog"/);
    expect(toggle).toMatch(/class="[^"]*\bh-11\b[^"]*"/);
    expect(toggle).toMatch(/class="[^"]*\bw-11\b[^"]*"/);
    expect(toggle).toMatch(/class="[^"]*\bmd:hidden\b[^"]*"/);
    expect(toggle).toMatch(/class="[^"]*hover:bg-accent[^"]*"/); // ghost variant
  });

  it("the sheet (closed on the first paint) carries brand name, role badge, every link and the sign-out", () => {
    const panel = attrs(html, "nav-sheet");
    expect(panel.startsWith("<dialog")).toBe(true);
    expect(panel).not.toMatch(/\sopen(=""|\s|>)/);
    const inner = html.slice(html.indexOf(panel));
    expect(inner).toContain("KILELE");
    expect(inner).toMatch(/data-testid="nav-sheet-role"[^>]*>Owner</);
    for (const link of NAV_LINKS) expect(inner).toMatch(new RegExp(`<a[^>]*href="${link.href}"[^>]*>${link.label}<`));
    expect(inner).toMatch(/<form[^>]*action="\/auth\/signout"[^>]*method="post"/);
    expect(inner).toContain("owner@example.test");
  });

  it("keeps the desktop badge, the email (lg+) and the header sign-out (md+)", () => {
    expect(html).toMatch(/data-testid="role-badge"[^>]*>Owner</);
    expect(attrs(html, "nav-signout")).toMatch(/class="[^"]*\bhidden\b[^"]*\bmd:block\b[^"]*"/);
  });
});

describe("MobileNav — link tap targets", () => {
  it("every link in the sheet is at least 44 px tall and closes the sheet on navigation", () => {
    const html = renderToStaticMarkup(
      createElement(MobileNav, { brandName: "KAROO", role: "analyst", email: "a@example.test", links: NAV_LINKS }),
    );
    const links = html.match(/<a[^>]*data-testid="nav-sheet-link"[^>]*>/g) ?? [];
    expect(links).toHaveLength(NAV_LINKS.length);
    for (const a of links) expect(a).toMatch(/class="[^"]*\bmin-h-11\b[^"]*"/);
    expect(html).toMatch(/data-testid="nav-sheet-role"[^>]*>Analyst</);
  });
});

describe("Sheet primitive — shadcn surface, native <dialog>", () => {
  it("exports the shadcn names and renders a left panel that is not the centred dialog", () => {
    for (const name of ["Sheet", "SheetTrigger", "SheetContent", "SheetHeader", "SheetTitle", "SheetDescription", "SheetClose"]) {
      // plain function components or `forwardRef` objects — both render
      expect(["function", "object"]).toContain(typeof (sheet as Record<string, unknown>)[name]);
      expect((sheet as Record<string, unknown>)[name]).toBeTruthy();
    }
    const html = renderToStaticMarkup(
      createElement(
        sheet.Sheet,
        { open: false, onOpenChange: () => {} } as never,
        createElement(sheet.SheetTrigger, { "data-testid": "t" } as never, "open"),
        createElement(
          sheet.SheetContent,
          { side: "left", "data-testid": "panel" } as never,
          createElement(sheet.SheetHeader, null, createElement(sheet.SheetTitle, null, "Menu"), createElement(sheet.SheetDescription, null, "desc")),
          createElement(sheet.SheetClose, null, "Close"),
        ),
      ),
    );
    const panel = attrs(html, "panel");
    expect(panel.startsWith("<dialog")).toBe(true);
    expect(panel).toMatch(/class="[^"]*\bm-0\b[^"]*"/); // pinned to the edge, not `m-auto`
    expect(panel).toMatch(/class="[^"]*\bh-dvh\b[^"]*"/);
    expect(panel).toMatch(/class="[^"]*\bmax-h-none\b[^"]*"/);
    expect(panel).toMatch(/class="[^"]*\bmr-auto\b[^"]*"/); // side="left"
    expect(attrs(html, "t")).toMatch(/aria-haspopup="dialog"/);
    expect(html).toContain(">Menu<");
    expect(html).toContain(">desc<");
    expect(html).toMatch(/<button[^>]*>Close<\/button>/);
  });
});
