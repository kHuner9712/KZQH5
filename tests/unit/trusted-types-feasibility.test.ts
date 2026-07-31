import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Trusted Types feasibility — static contract tests (KZQ-P1-004-e)
//
// These tests lock the security properties established by the audit
// in docs/SECURITY_AUDIT_TRUSTED_TYPES.md:
//
//   1. Project source has ZERO direct DOM sink assignments
//      (innerHTML, outerHTML, insertAdjacentHTML, document.write)
//   2. Project source has ZERO string-based timer calls
//      (setTimeout("..."), setInterval("..."))
//   3. Project source has ZERO new Worker(string) constructor calls
//   4. All dangerouslySetInnerHTML sites use serializeJsonLd()
//   5. Project source has ZERO existing Trusted Types policy creation
//   6. React DOM has ZERO native Trusted Types support (primary blocker)
//   7. Next.js has a partial Trusted Types policy (passthrough)
//   8. Audit deliverable document exists with NOT FEASIBLE conclusion
//
// These are STATIC source-code contract tests — they read files from
// disk and assert on their contents. They do NOT execute the code.
// ============================================================

const ROOT = join(import.meta.dirname, "..", "..");

function readFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function fileExists(relativePath: string): boolean {
  return existsSync(join(ROOT, relativePath));
}

/**
 * Collect all project-authored source files to scan.
 * Excludes node_modules, .next, public/lib/pdfjs, .git, coverage, and
 * THIS test file (its labels contain the literal sink names).
 */
function collectProjectSourceFiles(): string[] {
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  const excludePatterns = [
    "node_modules",
    ".next",
    "public/lib/pdfjs",
    ".git",
    "coverage",
    ".cache",
  ];
  const selfPath = "tests/unit/trusted-types-feasibility.test.ts";
  const entries = readdirSync(ROOT, { recursive: true, withFileTypes: false });
  const allFiles: string[] = [];
  for (const entry of entries) {
    const normalized = String(entry).replace(/\\/g, "/");
    if (excludePatterns.some((ex) => normalized.includes(`${ex}/`))) continue;
    if (normalized === selfPath) continue;
    if (!extensions.some((ext) => normalized.endsWith(ext))) continue;
    allFiles.push(normalized);
  }
  return allFiles;
}

/**
 * Check if a line is a comment (not executable code).
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

// ============================================================
// 1. Project source — zero direct DOM sink assignments
// ============================================================
describe("1. Project source — zero direct DOM sink assignments", () => {
  const files = collectProjectSourceFiles();

  it("contains NO direct .innerHTML = assignments", () => {
    const violations: string[] = [];
    const pattern = /\.innerHTML\s*=/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (pattern.test(lines[i])) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains NO direct .outerHTML = assignments", () => {
    const violations: string[] = [];
    const pattern = /\.outerHTML\s*=/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (pattern.test(lines[i])) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains NO insertAdjacentHTML calls", () => {
    const violations: string[] = [];
    const pattern = /insertAdjacentHTML\s*\(/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (pattern.test(lines[i])) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains NO document.write / document.writeln calls", () => {
    const violations: string[] = [];
    const pattern = /document\.write(?:ln)?\s*\(/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (pattern.test(lines[i])) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ============================================================
// 2. Project source — zero string-based timer calls
// ============================================================
describe("2. Project source — zero string-based timer calls", () => {
  const files = collectProjectSourceFiles();

  it("contains NO setTimeout with string argument", () => {
    const violations: string[] = [];
    // Match setTimeout("..." or setTimeout('...' — string arg, not function
    const pattern = /setTimeout\s*\(\s*["']/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (pattern.test(lines[i])) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains NO setInterval with string argument", () => {
    const violations: string[] = [];
    const pattern = /setInterval\s*\(\s*["']/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (pattern.test(lines[i])) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ============================================================
// 3. Project source — zero new Worker(string) constructor
// ============================================================
describe("3. Project source — zero new Worker(string) constructor", () => {
  const files = collectProjectSourceFiles();

  it("contains NO new Worker() constructor calls", () => {
    const violations: string[] = [];
    const pattern = /new\s+Worker\s*\(/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (pattern.test(lines[i])) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ============================================================
// 4. All dangerouslySetInnerHTML sites use serializeJsonLd()
// ============================================================
describe("4. All dangerouslySetInnerHTML sites use serializeJsonLd()", () => {
  const files = collectProjectSourceFiles();

  it("every dangerouslySetInnerHTML assignment uses serializeJsonLd()", () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isCommentLine(line)) continue;
        if (/dangerouslySetInnerHTML/.test(line)) {
          // The line or a nearby line must reference serializeJsonLd.
          // Check the current line and the next 2 lines (for multi-line props).
          const context = [lines[i], lines[i + 1], lines[i + 2]]
            .filter(Boolean)
            .join(" ");
          if (!/serializeJsonLd/.test(context)) {
            violations.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }
    // All 5 known sites use serializeJsonLd — no violations expected.
    expect(violations).toEqual([]);
  });

  it("serializeJsonLd escapes < > & U+2028 U+2029 (KZQ-P1-004-c hardening)", () => {
    const source = readFile("lib/utils.ts");
    // Core defense: < → \u003c (prevents </script> injection)
    expect(source).toMatch(/\\u003c/);
    // Defense-in-depth: > → \u003e, & → \u0026
    expect(source).toMatch(/\\u003e/);
    expect(source).toMatch(/\\u0026/);
    // ES2019 line/paragraph separators
    expect(source).toMatch(/\\u2028/);
    expect(source).toMatch(/\\u2029/);
  });
});

// ============================================================
// 5. Project source — zero existing Trusted Types policy creation
// ============================================================
describe("5. Project source — zero existing Trusted Types policy creation", () => {
  const files = collectProjectSourceFiles();

  it("contains NO trustedTypes.createPolicy() calls in project code", () => {
    const violations: string[] = [];
    const pattern = /trustedTypes\s*\.\s*createPolicy/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        if (pattern.test(lines[i])) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    // No project code creates a Trusted Types policy — this is deliberate.
    // Trusted Types enforcement is not feasible (see audit doc).
    expect(violations).toEqual([]);
  });

  it("contains NO require-trusted-types-for in CSP policy", () => {
    const source = readFile("lib/security/csp-policy.ts");
    // The CSP policy must NOT include Trusted Types enforcement directives.
    // Trusted Types is not feasible due to React 19 lacking native support.
    expect(source).not.toMatch(/require-trusted-types-for/i);
    expect(source).not.toMatch(/trusted-types/i);
  });
});

// ============================================================
// 6. React DOM — zero native Trusted Types support (primary blocker)
// ============================================================
describe("6. React DOM — zero native Trusted Types support (primary blocker)", () => {
  it("react-dom package contains NO trustedTypes references", () => {
    // Scan the react-dom client production build for Trusted Types APIs.
    // If React ever adds native support, this test will need updating.
    const reactDomPath = "node_modules/react-dom/cjs/react-dom-client.production.js";
    if (!fileExists(reactDomPath)) {
      // Fall back to checking the directory exists at all
      expect(fileExists("node_modules/react-dom")).toBe(true);
      return;
    }
    const source = readFile(reactDomPath);
    // React DOM should NOT create Trusted Types policies or reference
    // TrustedHTML. If this changes, the Trusted Types feasibility
    // assessment must be revisited.
    expect(source).not.toMatch(/trustedTypes\s*\.\s*createPolicy/);
    expect(source).not.toMatch(/TrustedHTML/);
  });
});

// ============================================================
// 7. Next.js — partial Trusted Types policy (passthrough)
// ============================================================
describe("7. Next.js — partial Trusted Types policy (passthrough)", () => {
  it("next.js ships a trusted-types policy module", () => {
    expect(fileExists("node_modules/next/dist/client/trusted-types.js")).toBe(true);
    const source = readFile("node_modules/next/dist/client/trusted-types.js");
    // Next.js creates a passthrough policy named 'nextjs'
    expect(source).toMatch(/createPolicy\s*\(\s*['"]nextjs['"]/);
    // Passthrough: returns input unchanged
    expect(source).toMatch(/createHTML:\s*\(input\)\s*=>\s*input/);
  });

  it("next.js <Script> component assigns raw string to innerHTML (would break under TT)", () => {
    // This documents WHY Next.js's own policy is insufficient:
    // the <Script> component does not wrap innerHTML assignments.
    const source = readFile("node_modules/next/dist/client/script.js");
    expect(source).toMatch(/\.innerHTML\s*=/);
  });
});

// ============================================================
// 8. Audit deliverable document exists with NOT FEASIBLE conclusion
// ============================================================
describe("8. Audit deliverable document exists", () => {
  it("docs/SECURITY_AUDIT_TRUSTED_TYPES.md exists", () => {
    expect(fileExists("docs/SECURITY_AUDIT_TRUSTED_TYPES.md")).toBe(true);
  });

  it("audit document states NOT FEASIBLE conclusion", () => {
    const source = readFile("docs/SECURITY_AUDIT_TRUSTED_TYPES.md");
    expect(source).toMatch(/NOT FEASIBLE/i);
    // Must document the primary blocker (React 19 lacks Trusted Types)
    expect(source).toMatch(/React.*19.*does.*NOT.*natively.*support.*Trusted Types/is);
    // Must reference the prerequisite audits
    expect(source).toMatch(/KZQ-P1-004-a/);
    expect(source).toMatch(/KZQ-P1-004-c/);
    expect(source).toMatch(/KZQ-P1-004-d/);
    // Must document the DOM sink scan results
    expect(source).toMatch(/0.*innerHTML/);
    // Must document reassessment triggers
    expect(source).toMatch(/Reassess/i);
  });
});
