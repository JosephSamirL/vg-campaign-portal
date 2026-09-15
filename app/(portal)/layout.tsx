import { redirect } from "next/navigation";
import { PortalNav } from "@/components/layout/portal-nav";
import { getCurrentAppUser } from "@/lib/current-user";

// The whole portal reads the session cookie, so nothing here can be part of a static
// shell; let the segment block on the server (Next 16 Cache Components opt-out).
export const instant = false;

/**
 * Every (portal) route assumes a session AND a brand. proxy.ts already bounced anonymous
 * requests, so a null here means "valid session, no allow-list row (or brand)": sign it
 * out through the route handler (a layout cannot clear cookies) with a reason (D-9).
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const me = await getCurrentAppUser();
  if (!me) redirect("/auth/signout?reason=no_access");

  return (
    <div className="flex min-h-screen flex-col">
      <PortalNav brandName={me.brand_name} role={me.role} email={me.email} />
      <main className="mx-auto w-full max-w-5xl flex-1 p-5">{children}</main>
    </div>
  );
}
