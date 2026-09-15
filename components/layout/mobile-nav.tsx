"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { AppRole } from "@/lib/current-user";

const ROLE_LABEL: Record<AppRole, string> = { owner: "Owner", analyst: "Analyst" };

export type MobileNavProps = {
  brandName: string;
  role: AppRole;
  email: string;
  links: ReadonlyArray<{ href: string; label: string }>;
};

/**
 * The phone navigation (Story 7.1, AC1): a 44 × 44 px ghost icon button, visible below `md`,
 * opens a left `Sheet` with the brand name, the role badge, the signed-in email, every portal
 * link (44 px tap targets) and the sign-out form. The sheet closes on navigation — the pathname
 * effect — so a tapped link never leaves it hanging over the new page. Nothing here decides
 * anything: brand, role and links come from the server-rendered `PortalNav`.
 */
export function MobileNav({ brandName, role, email, links }: MobileNavProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0 md:hidden" aria-label="Open menu" data-testid="nav-toggle">
          <Menu className="size-5" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" aria-labelledby="nav-sheet-title" data-testid="nav-sheet">
        <SheetHeader>
          <SheetTitle id="nav-sheet-title" className="break-words">
            {brandName}
          </SheetTitle>
          <div>
            <Badge variant={role === "owner" ? "default" : "secondary"} data-testid="nav-sheet-role">
              {ROLE_LABEL[role]}
            </Badge>
          </div>
          <SheetDescription className="break-all">{email}</SheetDescription>
        </SheetHeader>
        <nav aria-label="Portal" className="flex-1">
          <ul className="flex flex-col">
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={pathname === link.href || pathname.startsWith(`${link.href}/`) ? "page" : undefined}
                  className="flex min-h-11 items-center rounded-md px-2 text-base font-medium hover:bg-accent aria-[current=page]:bg-muted"
                  data-testid="nav-sheet-link"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <form action="/auth/signout" method="post">
          <Button type="submit" variant="outline" className="h-11 w-full">
            Log out
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
