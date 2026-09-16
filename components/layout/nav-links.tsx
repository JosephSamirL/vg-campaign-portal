"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavLinkItem = { href: string; label: string };

/** True for the link's own route and anything nested under it (`/campaigns/[id]` highlights Campaigns). */
export function isCurrentPath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The desktop link row of the portal header. `PortalNav` is a server component and cannot read
 * the pathname, so the current-page highlight lives here: `aria-current="page"` (what assistive
 * tech announces) drives the visible state through the `aria-[current=page]:` variants — one
 * source of truth, no separate "active" prop to drift.
 */
export function NavLinks({ links }: { links: ReadonlyArray<NavLinkItem> }) {
  const pathname = usePathname();
  return (
    <ul className="hidden items-center gap-1 md:flex" data-testid="nav-links">
      {links.map((link) => (
        <li key={link.href}>
          <Link
            href={link.href}
            aria-current={isCurrentPath(pathname, link.href) ? "page" : undefined}
            className="rounded-md px-3 py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
            data-testid="nav-link"
          >
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
