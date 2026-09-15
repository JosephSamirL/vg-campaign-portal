import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Everything except: /share/* (public results, Epic 5), /api/health (uptime probe, 7.2),
  // /login and /auth/* (the sign-in round-trip itself), Next internals, and static assets
  // (favicon, the metadata images, anything with a file extension). Exclusions are anchored
  // (`share(?:/|$)`, `login$`, …) so /authors, /shareholders or /login-x are still guarded.
  // Tested by tests/proxy-matcher.test.ts — keep them in sync (architecture amendment #13).
  matcher: [
    "/((?!share(?:/|$)|api/health$|login$|auth(?:/|$)|_next(?:/|$)|favicon\\.ico$|opengraph-image\\.png$|twitter-image\\.png$|.*\\.[A-Za-z0-9]+$).*)",
  ],
};
