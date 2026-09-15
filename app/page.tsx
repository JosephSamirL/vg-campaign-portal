import { redirect } from "next/navigation";

// proxy.ts already sends "/" to /dashboard (session) or /login (none); this covers
// any render path that bypasses it.
export default function Home() {
  redirect("/dashboard");
}
