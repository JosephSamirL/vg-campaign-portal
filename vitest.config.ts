import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig `paths` (`@/*` → repo root) so tests can import app modules.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `import "server-only"` (lib/supabase/admin.ts) throws outside a react-server build;
      // resolve it to the marker package's empty build here, as Next does for server code.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
  },
});
