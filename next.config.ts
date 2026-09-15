import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // `next dev` would otherwise write AGENTS.md / CLAUDE.md into the repo on every start.
  agentRules: false,
};

export default nextConfig;
