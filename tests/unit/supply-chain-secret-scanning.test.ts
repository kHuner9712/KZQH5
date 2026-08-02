import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// KZQ-P2-012-b: secret scanning configuration governance
// ------------------------------------------------------------
// GitHub Secret Scanning / Push Protection are PLATFORM settings
// (Settings → Code security and analysis) — there is NO standard
// repository config file for them (unlike dependabot.yml). This spec
// locks the honest delivery:
//   - the configuration/acceptance document exists and states the real
//     enablement steps + manual acceptance;
//   - the document explicitly forbids faking a nonexistent config file;
//   - the launch checklist carries the manual acceptance items;
//   - the repo does NOT contain a fabricated secret-scanning config.
// ============================================================

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..");

const DOC = join(ROOT, "docs", "SECRET_SCANNING_CONFIG.md");
const CHECKLIST = join(ROOT, "docs", "LAUNCH_CHECKLIST.md");

describe("KZQ-P2-012-b: secret scanning config doc exists and is honest", () => {
  it("docs/SECRET_SCANNING_CONFIG.md exists", () => {
    expect(existsSync(DOC)).toBe(true);
  });

  it("documents the real GitHub UI enablement steps", () => {
    const doc = readFileSync(DOC, "utf8");
    expect(doc).toMatch(/Settings → Code security and analysis/);
    expect(doc).toMatch(/Secret scanning/);
    expect(doc).toMatch(/Push protection/);
  });

  it("documents a concrete push-protection manual acceptance test", () => {
    const doc = readFileSync(DOC, "utf8");
    expect(doc).toMatch(/git push/);
    expect(doc).toMatch(/secret detected/);
  });

  it("explicitly forbids fabricating a nonexistent config file", () => {
    const doc = readFileSync(DOC, "utf8");
    expect(doc).toMatch(/不得.*伪造|not.*fake|fabricat/i);
    expect(doc).toMatch(/secret-scanning\.yml/);
  });

  it("the repo does NOT contain a fabricated secret-scanning config", () => {
    // GitHub has no .github/secret-scanning.yml mechanism — a file here
    // would be a false "enabled" claim and must not exist.
    expect(
      existsSync(join(ROOT, ".github", "secret-scanning.yml")),
    ).toBe(false);
  });
});

describe("KZQ-P2-012-b: launch checklist carries the manual acceptance items", () => {
  it("LAUNCH_CHECKLIST.md has the supply-chain section with Secret scanning items", () => {
    const checklist = readFileSync(CHECKLIST, "utf8");
    expect(checklist).toMatch(/## 10\. 供应链安全/);
    expect(checklist).toMatch(/Secret scanning.*Enabled/);
    expect(checklist).toMatch(/Push protection.*Enabled/);
    expect(checklist).toMatch(/SECRET_SCANNING_CONFIG\.md/);
  });
});
