import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// KZQ-P2-012-a: CodeQL workflow governance contract
// ------------------------------------------------------------
// Verifies .github/workflows/codeql.yml:
//   - runs the full init → autobuild → analyze pipeline for
//     JavaScript/TypeScript with the security-extended query suite;
//   - triggers on push, pull_request and a weekly schedule;
//   - uses least-privilege permissions (security-events write only);
//   - pins every third-party action to a 40-char commit SHA
//     (no moving @vX tags) — consistent with ci.yml governance.
// ============================================================

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..");
const CODEQL_YML = join(ROOT, ".github", "workflows", "codeql.yml");

const content = existsSync(CODEQL_YML)
  ? readFileSync(CODEQL_YML, "utf8")
  : "";

describe("KZQ-P2-012-a: CodeQL workflow exists and runs the pipeline", () => {
  it("codeql.yml exists", () => {
    expect(existsSync(CODEQL_YML)).toBe(true);
  });

  it("runs init → autobuild → analyze for JavaScript/TypeScript", () => {
    expect(content).toMatch(/github\/codeql-action\/init/);
    expect(content).toMatch(/github\/codeql-action\/autobuild/);
    expect(content).toMatch(/github\/codeql-action\/analyze/);
    expect(content).toMatch(/languages:\s*javascript-typescript/);
  });

  it("enables the security-extended query suite", () => {
    expect(content).toMatch(/security-extended/);
  });

  it("triggers on push, pull_request and a weekly schedule", () => {
    expect(content).toMatch(/pull_request:/);
    expect(content).toMatch(/schedule:/);
    expect(content).toMatch(/cron:\s*"/);
  });

  it("pins the project Node version to 20 (matches CI)", () => {
    expect(content).toMatch(/node-version:\s*20/);
  });
});

describe("KZQ-P2-012-a: CodeQL least-privilege permissions", () => {
  it("grants only security-events: write, actions: read, contents: read", () => {
    // Extract the top-level permissions block (a line starting with
    // "permissions:" followed by indented keys); the prose comment above
    // it also contains the word "permissions" so a plain split is wrong.
    const permsMatch = content.match(/^permissions:\n((?:  [^\n]+\n)*)/m);
    const permsBlock = permsMatch?.[1] ?? "";
    expect(permsBlock).toMatch(/security-events:\s*write/);
    expect(permsBlock).toMatch(/actions:\s*read/);
    expect(permsBlock).toMatch(/contents:\s*read/);
    // No write access to anything else.
    expect(permsBlock).not.toMatch(/packages:\s*write/);
    expect(permsBlock).not.toMatch(/issues:\s*write/);
    expect(permsBlock).not.toMatch(/contents:\s*write/);
  });
});

describe("KZQ-P2-012-a: every codeql-action use is SHA-pinned", () => {
  const shaPattern = (action: string) =>
    new RegExp(`uses:\\s+${action}@[0-9a-f]{40}\\b`);
  const movingTagPattern = (action: string) =>
    new RegExp(`uses:\\s+${action}@v\\d+\\b`);

  it("pins github/codeql-action/init by SHA", () => {
    expect(shaPattern("github/codeql-action/init").test(content)).toBe(true);
    expect(movingTagPattern("github/codeql-action/init").test(content)).toBe(false);
  });

  it("pins github/codeql-action/autobuild by SHA", () => {
    expect(shaPattern("github/codeql-action/autobuild").test(content)).toBe(true);
    expect(movingTagPattern("github/codeql-action/autobuild").test(content)).toBe(false);
  });

  it("pins github/codeql-action/analyze by SHA", () => {
    expect(shaPattern("github/codeql-action/analyze").test(content)).toBe(true);
    expect(movingTagPattern("github/codeql-action/analyze").test(content)).toBe(false);
  });

  it("pins actions/checkout and actions/setup-node by SHA (no moving tags anywhere)", () => {
    expect(shaPattern("actions/checkout").test(content)).toBe(true);
    expect(shaPattern("actions/setup-node").test(content)).toBe(true);
    // No `uses: ...@v<digit>` moving references at all.
    expect(content).not.toMatch(/uses:\s+[^\s]+@v\d+\b/);
  });
});
