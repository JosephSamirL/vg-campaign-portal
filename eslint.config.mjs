import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  // Build output and generated files are not source (`pnpm lint` = `eslint .`; Next 16 removed `next lint`).
  { ignores: [".next/**", "out/**", "build/**", ".vercel/**", "next-env.d.ts", "coverage/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // Story 7.2 (architecture "Service boundaries", NFR-2): lib/supabase/admin.ts is the service-role client.
  // Only scripts/ (the seed / provisioning jobs, run on the engineer's machine) and tests/ (local-stack teardown)
  // may import it — never a route, page, action, component or lib module the deployed app bundles, whatever the
  // spelling (`@/lib/supabase/admin`, `../lib/supabase/admin`, `lib/supabase/admin.ts`). Proven by the probe in
  // the story: an `import '@/lib/supabase/admin'` in app/api/health/route.ts fails `pnpm lint`.
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs}"],
    ignores: ["scripts/**", "tests/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)lib/supabase/admin(\\.ts)?$",
              message: "Service-role client only under scripts/ (and tests/ teardown). The deployed app uses the publishable key.",
            },
          ],
        },
      ],
    },
  },
  // tailwind.config.ts uses the CommonJS `require("tailwindcss-animate")` the shadcn scaffold ships with.
  { files: ["tailwind.config.ts"], rules: { "@typescript-eslint/no-require-imports": "off" } },
];

export default eslintConfig;
