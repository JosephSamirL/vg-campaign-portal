import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AppRole } from "@/lib/current-user";

/** Later stories add routes here (campaigns, contacts, …); 7.1 folds it into a mobile Sheet. */
export const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/imports", label: "Imports" },
] as const;

const ROLE_LABEL: Record<AppRole, string> = { owner: "Owner", analyst: "Analyst" };

type Props = { brandName: string; role: AppRole; email: string };

export function PortalNav({ brandName, role, email }: Props) {
  return (
    <header className="w-full border-b border-b-foreground/10">
      <nav className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-5 text-sm">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="font-semibold">
            {brandName}
          </Link>
          <Badge variant={role === "owner" ? "default" : "secondary"} data-testid="role-badge">
            {ROLE_LABEL[role]}
          </Badge>
          <ul className="flex items-center gap-3">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="hover:underline">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-muted-foreground sm:inline">{email}</span>
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="outline" size="sm">
              Log out
            </Button>
          </form>
        </div>
      </nav>
    </header>
  );
}
