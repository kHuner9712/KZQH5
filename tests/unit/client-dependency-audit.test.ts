import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Client-side dependency audit — static contract tests (KZQ-P1-004-d)
//
// These tests lock the security properties established by the audit
// in docs/SECURITY_AUDIT_CLIENT_DEPENDENCIES.md:
//
//   1. Project source code contains NO eval() or new Function() calls
//   2. PDF.js worker is vendored as a static asset (not inlined)
//   3. CSP worker-src directive allows the worker origin
//   4. PDF.js worker loader uses the vendored static asset path
//   5. Worker sync script exists and copies from node_modules
//   6. Audit deliverable document exists
//   7. (Documentation) KZQ-P1-003 ledger-vs-code discrepancy is recorded
//
// These are STATIC source-code contract tests — they read files from
// disk and assert on their contents. They do NOT execute the code.
// This makes them fast, deterministic, and safe to run in any
// environment (including CI without a browser).
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
 * Returns RELATIVE paths (from ROOT) so they can be passed to readFile().
 * Excludes:
 *   - node_modules (third-party)
 *   - .next (build output)
 *   - public/lib/pdfjs (vendored pdfjs-dist worker — audited separately)
 *   - .git
 *   - coverage / test artifacts
 *   - THIS test file (it contains the literal strings "eval()" and
 *     "new Function()" in describe/it labels, which would self-match)
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
  // Exclude this test file itself — its describe/it labels contain the
  // literal strings "eval()" and "new Function()" which would self-match.
  const selfPath = "tests/unit/client-dependency-audit.test.ts";

  // Use readdirSync with recursive:true (supported in Node 18.17+ and
  // typed in @types/node 20.x). Returns relative paths from cwd.
  const entries = readdirSync(ROOT, { recursive: true, withFileTypes: false });
  const allFiles: string[] = [];
  for (const entry of entries) {
    const normalized = String(entry).replace(/\\/g, "/");
    // Skip excluded directories
    if (excludePatterns.some((ex) => normalized.includes(`${ex}/`))) {
      continue;
    }
    // Skip this test file (self-exclusion — see comment above)
    if (normalized === selfPath) {
      continue;
    }
    // Only include files with target extensions
    if (!extensions.some((ext) => normalized.endsWith(ext))) {
      continue;
    }
    allFiles.push(normalized);
  }
  return allFiles;
}

// ============================================================
// 1. Project source code — no eval() or new Function()
// ============================================================
describe("1. Project source code — no eval() or new Function()", () => {
  const files = collectProjectSourceFiles();

  it("collects a non-empty set of project source files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("contains NO direct eval() calls", () => {
    const violations: string[] = [];
    // Match eval( but not:
    //   - eval in comments (// or /*)
    //   - eval in strings (we approximate by checking word boundary)
    //   - member access like obj.eval( or .eval(
    const evalPattern = /(^|[^.\w])eval\s*\(/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comment lines
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          continue;
        }
        if (evalPattern.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains NO new Function() constructor calls", () => {
    const violations: string[] = [];
    const functionPattern = /new\s+Function\s*\(/;
    for (const file of files) {
      const content = readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          continue;
        }
        if (functionPattern.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ============================================================
// 2. PDF.js worker — vendored as static asset
// ============================================================
describe("2. PDF.js worker — vendored as static asset", () => {
  it("worker file exists at public/lib/pdfjs/pdf.worker.min.mjs", () => {
    expect(fileExists("public/lib/pdfjs/pdf.worker.min.mjs")).toBe(true);
  });

  it("worker file is non-trivial size (>100KB — not a stub)", () => {
    const stat = readFileSync("public/lib/pdfjs/pdf.worker.min.mjs");
    expect(stat.length).toBeGreaterThan(100_000);
  });

  it("worker file starts with the Mozilla license header", () => {
    const content = readFile("public/lib/pdfjs/pdf.worker.min.mjs");
    // PDF.js worker files start with a license comment
    expect(content).toMatch(/Mozilla Foundation|Apache|@licstart/i);
  });
});

// ============================================================
// 3. CSP worker-src directive — allows worker loading
// ============================================================
describe("3. CSP worker-src directive — allows worker loading", () => {
  it("COMMON_DIRECTIVES includes worker-src 'self' blob:", () => {
    const source = readFile("lib/security/csp-policy.ts");
    expect(source).toMatch(/worker-src\s+'self'\s+blob:/);
  });

  it("COMMON_DIRECTIVES includes object-src 'none' (block plugins)", () => {
    const source = readFile("lib/security/csp-policy.ts");
    expect(source).toMatch(/object-src\s+'none'/);
  });

  it("COMMON_DIRECTIVES includes frame-ancestors 'none' (clickjacking)", () => {
    const source = readFile("lib/security/csp-policy.ts");
    expect(source).toMatch(/frame-ancestors\s+'none'/);
  });
});

// ============================================================
// 4. PDF.js worker loader — uses vendored static asset path
// ============================================================
describe("4. PDF.js worker loader — uses vendored static asset path", () => {
  it("usePdfDocument sets workerSrc to /lib/pdfjs/pdf.worker.min.mjs", () => {
    const source = readFile("components/public/product-asset-viewer/hooks/usePdfDocument.ts");
    expect(source).toMatch(/WORKER_SRC\s*=\s*['"]\/lib\/pdfjs\/pdf\.worker\.min\.mjs['"]/);
    expect(source).toMatch(/GlobalWorkerOptions\.workerSrc\s*=\s*WORKER_SRC/);
  });

  it("usePdfDocument does NOT use new Function or eval", () => {
    const source = readFile("components/public/product-asset-viewer/hooks/usePdfDocument.ts");
    expect(source).not.toMatch(/new\s+Function\s*\(/);
    expect(source).not.toMatch(/(^|[^.\w])eval\s*\(/);
  });

  it("viewer-utils does NOT use new Function or eval", () => {
    const source = readFile("lib/client/viewer-utils.ts");
    expect(source).not.toMatch(/new\s+Function\s*\(/);
    expect(source).not.toMatch(/(^|[^.\w])eval\s*\(/);
  });
});

// ============================================================
// 5. Worker sync script — exists and copies from node_modules
// ============================================================
describe("5. Worker sync script — copies from node_modules to public", () => {
  it("scripts/sync-pdfjs-worker.mjs exists", () => {
    expect(fileExists("scripts/sync-pdfjs-worker.mjs")).toBe(true);
  });

  it("sync script copies from node_modules/pdfjs-dist to public/lib/pdfjs", () => {
    const source = readFile("scripts/sync-pdfjs-worker.mjs");
    expect(source).toMatch(/node_modules\/pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs/);
    expect(source).toMatch(/public\/lib\/pdfjs\/pdf\.worker\.min\.mjs/);
    expect(source).toMatch(/copyFileSync/);
  });
});

// ============================================================
// 6. Audit deliverable document exists
// ============================================================
describe("6. Audit deliverable document exists", () => {
  it("docs/SECURITY_AUDIT_CLIENT_DEPENDENCIES.md exists", () => {
    expect(fileExists("docs/SECURITY_AUDIT_CLIENT_DEPENDENCIES.md")).toBe(true);
  });

  it("audit document records the clean source code finding", () => {
    const source = readFile("docs/SECURITY_AUDIT_CLIENT_DEPENDENCIES.md");
    expect(source).toMatch(/Project source code — CLEAN/i);
    expect(source).toMatch(/Zero matches/i);
  });

  it("audit document records the pdfjs-dist worker isolation finding", () => {
    const source = readFile("docs/SECURITY_AUDIT_CLIENT_DEPENDENCIES.md");
    expect(source).toMatch(/pdfjs-dist Web Worker — ISOLATED WITH FALLBACK/i);
    expect(source).toMatch(/PostScriptEvaluator/i);
    expect(source).toMatch(/isEvalSupported/i);
  });

  it("audit document records the KZQ-P1-003 ledger discrepancy", () => {
    const source = readFile("docs/SECURITY_AUDIT_CLIENT_DEPENDENCIES.md");
    expect(source).toMatch(/KZQ-P1-003/i);
    expect(source).toMatch(/DISCREPANT|factually incorrect/i);
  });
});

// ============================================================
// 7. Next.js config — no eval-based devtools in production
// ============================================================
describe("7. Next.js config — no eval-based sourcemaps in production", () => {
  it("next.config.mjs does not enable eval sourcemaps", () => {
    const source = readFile("next.config.mjs");
    // eval-source-map and cheap-eval-source-map would allow eval in dev
    // Production builds should not use them
    expect(source).not.toMatch(/eval-source-map/i);
    expect(source).not.toMatch(/cheap-eval-source-map/i);
  });

  it("next.config.mjs transpiles pdfjs-dist", () => {
    const source = readFile("next.config.mjs");
    expect(source).toMatch(/transpilePackages.*pdfjs-dist|pdfjs-dist.*transpilePackages/s);
  });
});
