import Link from "next/link";
import { MobileNav } from "@/components/layout/mobile-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AppRole } from "@/lib/current-user";

/** The portal's routes, in nav order. Both the desktop row and the phone Sheet read this list. */
export const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/contacts", label: "Contacts" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/imports", label: "Imports" },
] as const;

const ROLE_LABEL: Record<AppRole, string> = { owner: "Owner", analyst: "Analyst" };

type Props = { brandName: string; role: AppRole; email: string };

/**
 * The portal header (Story 1.5; Story 7.1 folds it into a phone layout). From `md` up: brand,
 * role badge, the inline link row, the email and the sign-out. Below `md` the link row and the
 * header sign-out are hidden and the 44 px menu button opens `MobileNav`'s Sheet, which carries
 * the same brand / badge / links / sign-out. `min-w-0` + `truncate` keep a long brand name from
 * pushing the header past the viewport (AC1: no page-level horizontal scroll).
 */
export function PortalNav({ brandName, role, email }: Props) {
  return (
    <header className="w-full border-b border-b-foreground/10">
      <nav className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-3 px-4 text-sm sm:px-5">
        <div className="flex min-w-0 items-center gap-2 md:gap-4">
          <MobileNav brandName={brandName} role={role} email={email} links={NAV_LINKS} />
          <Link href="/dashboard" className="min-w-0 truncate font-semibold">
            {brandName}
          </Link>
          <Badge variant={role === "owner" ? "default" : "secondary"} className="shrink-0" data-testid="role-badge">
            {ROLE_LABEL[role]}
          </Badge>
          <ul className="hidden items-center gap-3 md:flex" data-testid="nav-links">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="hover:underline">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden text-muted-foreground md:inline">{email}</span>
          <form action="/auth/signout" method="post" className="hidden md:block" data-testid="nav-signout">
            <Button type="submit" variant="outline" size="sm">
              Log out
            </Button>
          </form>
        </div>
      </nav>
    </header>
  );
}
