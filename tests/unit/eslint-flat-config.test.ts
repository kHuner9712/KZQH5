import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// KZQ-UPG-002: ESLint Flat Config governance contract
// ------------------------------------------------------------
// Next.js 16 removes `next lint` and ESLint 9 (installed) supports only
// Flat Config. Verifies:
//   - eslint.config.mjs exists and replaces the legacy .eslintrc.json
//     (which must no longer exist);
//   - the Next.js preset (next/core-web-vitals) is bridged via
//     FlatCompat from @eslint/eslintrc (eslint-config-next@15 still
//     ships legacy presets);
//   - the custom rules from the old .eslintrc are preserved verbatim;
//   - build/test/vendor output and ambient .d.ts files are ignored;
//   - `npm run lint` runs the ESLint CLI directly (`eslint .`), not
//     `next lint`;
//   - the lint command actually exits 0 with zero errors AND zero
//     warnings on the current tree (clean baseline).
// ============================================================

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..");
const FLAT = join(ROOT, "eslint.config.mjs");
const LEGACY = join(ROOT, ".eslintrc.json");
const PKG_JSON = join(ROOT, "package.json");
const CI_YML = join(ROOT, ".github", "workflows", "ci.yml");

const flat = existsSync(FLAT) ? readFileSync(FLAT, "utf8") : "";
const pkg = existsSync(PKG_JSON) ? readFileSync(PKG_JSON, "utf8") : "";

describe("KZQ-UPG-002: flat config exists and replaces the legacy eslintrc", () => {
  it("eslint.config.mjs exists", () => {
    expect(existsSync(FLAT)).toBe(true);
  });

  it("the legacy .eslintrc.json has been removed", () => {
    expect(existsSync(LEGACY)).toBe(false);
  });
});

describe("KZQ-UPG-002: Next.js preset is bridged with FlatCompat", () => {
  it("imports FlatCompat from @eslint/eslintrc", () => {
    expect(flat).toMatch(/@eslint\/eslintrc/);
    expect(flat).toMatch(/FlatCompat/);
  });

  it("extends next/core-web-vitals", () => {
    expect(flat).toMatch(/compat\.extends\("next\/core-web-vitals"\)/);
  });

  it("preserves the custom rules from the old .eslintrc", () => {
    expect(flat).toMatch(/@next\/next\/no-img-element":\s*"off"/);
    expect(flat).toMatch(/react\/no-unescaped-entities":\s*"off"/);
  });

  it("ignores build output, vendor bundles and ambient .d.ts files", () => {
    expect(flat).toMatch(/\.next\/\*\*/);
    expect(flat).toMatch(/node_modules\/\*\*/);
    expect(flat).toMatch(/public\/lib\/\*\*/);
    expect(flat).toMatch(/\*\*\/\*\.d\.ts/);
  });
});

describe("KZQ-UPG-002: lint runs the ESLint CLI, not next lint", () => {
  it("package.json lint script is `eslint .`", () => {
    expect(pkg).toMatch(/"lint":\s*"eslint \."/);
    expect(pkg).not.toMatch(/"lint":\s*"next lint"/);
  });
});

describe("KZQ-UPG-002: the lint command is clean on the current tree", () => {
  it("eslint . exits 0 with zero errors and zero warnings", () => {
    const out = execSync("npx eslint .", {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    });
    // "✖ N problems" summary must be absent (0 problems); any error or
    // warning line would break this.
    expect(out).not.toMatch(/problems/);
    expect(out.trim()).toBe("");
  }, 180_000);
});
