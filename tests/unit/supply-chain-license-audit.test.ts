import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// KZQ-P2-012-d: dependency license audit governance contract
// ------------------------------------------------------------
// Verifies scripts/check-license-audit.mjs:
//   - audits the PRODUCTION dependency tree (npm ls --omit=dev);
//   - blocks strong copyleft (GPL / AGPL / SSPL) and missing/unknown
//     licenses;
//   - blocks weak copyleft (LGPL / MPL) UNLESS the package is a
//     documented KNOWN_EXCEPTION (sharp platform binaries), keeping
//     exceptions deliberate rather than silent;
//   - documents the audit command and the verified allowlist in the
//     script header;
//   - is wired into CI (ci.yml) and npm scripts.
// Also executes the audit for real — it MUST exit 0 on the current
// dependency tree (a passing audit is the enforcement, not just the
// presence of the script).
// ============================================================

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-license-audit.mjs");
const CI_YML = join(ROOT, ".github", "workflows", "ci.yml");
const PKG_JSON = join(ROOT, "package.json");

const script = existsSync(SCRIPT) ? readFileSync(SCRIPT, "utf8") : "";
const ci = existsSync(CI_YML) ? readFileSync(CI_YML, "utf8") : "";
const pkg = existsSync(PKG_JSON) ? readFileSync(PKG_JSON, "utf8") : "";

describe("KZQ-P2-012-d: license audit script exists and documents policy", () => {
  it("check-license-audit.mjs exists", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("documents the audit command in the header", () => {
    expect(script).toMatch(/node scripts\/check-license-audit\.mjs/);
  });

  it("documents a verified allowlist of permitted licenses", () => {
    expect(script).toMatch(/ALLOWED/);
    expect(script).toMatch(/MIT/);
    expect(script).toMatch(/Apache-2\.0/);
  });

  it("audits the production tree with --omit=dev (dev-only copyleft excluded)", () => {
    expect(script).toMatch(/npm ls --json --all --omit=dev/);
    expect(script).toMatch(/--omit=dev/);
  });
});

describe("KZQ-P2-012-d: license policy rules", () => {
  it("blocks strong copyleft licenses (GPL / AGPL / SSPL)", () => {
    expect(script).toMatch(/STRONG_COPYLEFT/);
    expect(script).toMatch(/GPL/);
    expect(script).toMatch(/AGPL/);
    expect(script).toMatch(/SSPL/);
  });

  it("fails on missing/unknown license fields", () => {
    expect(script).toMatch(/\(missing\)/);
    expect(script).toMatch(/no license field/);
  });

  it("blocks weak copyleft unless the package is a KNOWN_EXCEPTION", () => {
    expect(script).toMatch(/WEAK_COPYLEFT/);
    expect(script).toMatch(/KNOWN_EXCEPTIONS/);
    expect(script).toMatch(/isKnownException/);
  });

  it("keeps the sharp platform-binary exception justified, not silent", () => {
    // The KNOWN_EXCEPTIONS entry must carry a written justification in
    // the header so a future dependency change is a deliberate review.
    expect(script).toMatch(/@img\/sharp-/);
    expect(script).toMatch(/LGPL-3\.0-or-later/);
    expect(script).toMatch(/libvips/);
  });
});

describe("KZQ-P2-012-d: audit is enforced in CI and npm scripts", () => {
  it("is wired into the CI check job", () => {
    expect(ci).toMatch(/check:license-audit/);
  });

  it("is registered as an npm script", () => {
    expect(pkg).toMatch(/"check:license-audit"/);
    expect(pkg).toMatch(/node scripts\/check-license-audit\.mjs/);
  });
});

describe("KZQ-P2-012-d: audit actually passes on the current tree", () => {
  it("exits 0 with a PASSED summary", () => {
    const out = execSync("node scripts/check-license-audit.mjs", {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    expect(out).toMatch(/License audit PASSED/);
  });
});
