import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // `next dev` would otherwise write AGENTS.md / CLAUDE.md into the repo on every start.
  agentRules: false,
  // `next dev` otherwise prints every server-function call WITH its arguments to the terminal
  // (`└─ ƒ createShareLinkAction({ …, "password": "…" })`) — the share-link password (Story 5.2)
  // and the stranger's unlock password (5.3) must never reach a log line. Dev-only logging;
  // production never prints action arguments.
  logging: { serverFunctions: false },
};

export default nextConfig;
