import type { Metadata } from "next";
import { ShareUnlockForm } from "@/components/share/share-unlock-form";

/*
 * `/share/[token]` — the stranger's door (Story 5.3, D-12). A GET renders the password form and
 * nothing else: no database read, no session (proxy.ts never matches `/share`), no brand or
 * campaign name, no hint that the link exists. The token goes from `params` into the form's bound
 * action and is never displayed or logged. Per request, not a static shell: Next 16 with Cache
 * Components rejects `dynamic = "force-dynamic"`; `instant = false` is the repo's opt-out (3.2).
 */

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const instant = false;

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <ShareUnlockForm token={token} />
      </div>
    </div>
  );
}
