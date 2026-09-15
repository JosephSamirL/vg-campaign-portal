import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// Story 7.2 (architecture "Service boundaries", NFR-2): lib/supabase/admin.ts is the service-role client.
// Only scripts/ (the seed / provisioning jobs, run on the engineer's machine) may import it — never a route,
// page, action, component, test or lib module the deployed app bundles, whatever the spelling:
//   - the alias and every relative path that ends in the `lib/supabase/admin` segment (`@/lib/supabase/admin`,
//     `../lib/supabase/admin`, `lib/supabase/admin.ts`, `.js`/`.mjs`/`.cjs`/`.mts`/`.cts`) — anywhere;
//   - inside lib/**, any import whose basename is `admin` (`./admin` from lib/supabase/, `./supabase/admin` from
//     lib/), so no lib module can re-export the client to a route under a shorter name;
//   - dynamic `import("…lib/supabase/admin")` and `require("…lib/supabase/admin")`, which `no-restricted-imports`
//     never visits (`no-restricted-syntax` on ImportExpression / CallExpression).
// Proven by the probe in the story: an `import '@/lib/supabase/admin'` in app/api/health/route.ts fails `pnpm lint`;
// tests/health.test.ts re-proves every spelling through ESLint's API.
const ADMIN_MESSAGE = "Service-role client only under scripts/. The deployed app uses the publishable key.";
const ADMIN_PATH_REGEX = "(^|/)lib/supabase/admin(\\.[cm]?[jt]s)?$";
const ADMIN_BASENAME_REGEX = "(^|/)admin(\\.[cm]?[jt]s)?$";
// esquery regex attributes cannot hold a bare `/`, hence `\u002F` for the path separator.
const ADMIN_PATH_SELECTOR_REGEX = "/(^|\\u002F)lib\\u002Fsupabase\\u002Fadmin(\\.[cm]?[jt]s)?$/";
const ADMIN_BASENAME_SELECTOR_REGEX = "/(^|\\u002F)admin(\\.[cm]?[jt]s)?$/";
const dynamicFence = (regex) => [
  { selector: `ImportExpression[source.value=${regex}]`, message: ADMIN_MESSAGE },
  { selector: `CallExpression[callee.name='require'][arguments.0.value=${regex}]`, message: ADMIN_MESSAGE },
];

const eslintConfig = [
  // Build output and generated files are not source (`pnpm lint` = `eslint .`; Next 16 removed `next lint`).
  { ignores: [".next/**", "out/**", "build/**", ".vercel/**", "next-env.d.ts", "coverage/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
    ignores: ["scripts/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: ADMIN_PATH_REGEX, message: ADMIN_MESSAGE }] }],
      "no-restricted-syntax": ["error", ...dynamicFence(ADMIN_PATH_SELECTOR_REGEX)],
    },
  },
  {
    files: ["lib/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
    ignores: ["lib/supabase/admin.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ regex: ADMIN_PATH_REGEX, message: ADMIN_MESSAGE }, { regex: ADMIN_BASENAME_REGEX, message: ADMIN_MESSAGE }] },
      ],
      "no-restricted-syntax": ["error", ...dynamicFence(ADMIN_PATH_SELECTOR_REGEX), ...dynamicFence(ADMIN_BASENAME_SELECTOR_REGEX)],
    },
  },
  // tailwind.config.ts uses the CommonJS `require("tailwindcss-animate")` the shadcn scaffold ships with.
  { files: ["tailwind.config.ts"], rules: { "@typescript-eslint/no-require-imports": "off" } },
];

export default eslintConfig;
