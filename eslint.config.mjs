// KZQ-UPG-002 — ESLint Flat Config.
//
// Next.js 16 removes `next lint`, and ESLint 9 (already installed)
// supports only Flat Config. This file replaces the legacy
// `.eslintrc.json` so `npm run lint` can run the ESLint CLI directly
// (`eslint .`) — a pre-migration for the Next.js 16 upgrade
// (docs/NEXT16_UPGRADE_PLAN.md Phase 2 + 3).
//
// `eslint-config-next@15.5.21` still ships legacy (eslintrc) presets,
// so they are bridged with FlatCompat from @eslint/eslintrc. Rules
// previously declared in .eslintrc are preserved verbatim.
//
// Files NOT linted:
//   - .next/            build output
//   - node_modules/     dependencies (ESLint default)
//   - playwright-report/, test-results/  Playwright artifacts
//   - public/lib/       vendored third-party bundle (PDF.js worker)
//   - **/*.d.ts         ambient type declarations (next-env.d.ts)

import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const baseDirectory = dirname(fileURLToPath(import.meta.url));

const compat = new FlatCompat({ baseDirectory });

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "public/lib/**",
      "**/*.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals"),
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    rules: {
      "@next/next/no-img-element": "off",
      "react/no-unescaped-entities": "off",
    },
  },
];

export default config;
