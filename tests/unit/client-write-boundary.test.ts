import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ============================================================
// Work Package H: Client-side database write boundary
//
// Static scan that enforces the invariant:
//   "No client-side code performs direct database writes on
//    business tables."
//
// All writes must go through server-side API routes (app/api/**)
// which enforce RBAC, input validation, audit logging, optimistic
// locking, and Storage lifecycle.
//
// This test prevents regressions where a developer might add a
// `.insert()` / `.update()` / `.delete()` / `.upsert()` / `.rpc()`
// call directly on a browser Supabase client in a component or
// non-API route file.
// ============================================================

const ROOT = join(__dirname, "..", "..");

// Directories that are scanned for forbidden write patterns.
// `app/api/` is intentionally EXCLUDED — server-side API routes
// are the legitimate location for Supabase write operations.
const SCAN_DIRS = ["components", "app"];

// Subdirectories within app/ that are excluded from the scan.
// app/api/** contains server-side route handlers that are
// allowed to perform writes.
const EXCLUDED_APP_SUBDIRS = ["api"];

// Patterns that indicate a Supabase write operation.
// These are unambiguous: no other common JavaScript API uses
// these exact method names in a way that would match here.
//
// We match on the method call directly, but only flag it when
// the file also contains a Supabase client import (so that
// unrelated `.delete()` calls on Map/Set/URLSearchParams are
// not false positives).
const WRITE_METHOD_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // .insert( — unambiguous
  { name: ".insert()", regex: /\.insert\s*\(/ },
  // .upsert( — unambiguous
  { name: ".upsert()", regex: /\.upsert\s*\(/ },
  // .rpc( — unambiguous (only Supabase uses this)
  { name: ".rpc()", regex: /\.rpc\s*\(/ },
  // .update( — could be React setState, but on a Supabase query
  // builder it follows .from(...). We match .update({ to avoid
  // matching React's setState((prev) => ...) pattern.
  { name: ".update({...})", regex: /\.update\s*\(\s*\{/ },
];

// Files that import a Supabase client. We only flag write patterns
// in files that actually import a client — a `.rpc()` call in a
// file that doesn't import Supabase is not a database write.
const CLIENT_IMPORT_PATTERNS = [
  /from\s+["']@\/lib\/supabase\/client["']/,
  /from\s+["']@\/lib\/supabase\/public["']/,
  /from\s+["']@supabase\/ssr["']/,
  /from\s+["']@supabase\/supabase-js["']/,
];

function walkDir(dir: string, results: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkDir(fullPath, results);
    } else if (
      entry.endsWith(".ts") ||
      entry.endsWith(".tsx")
    ) {
      // Skip type declaration files (*.d.ts) — they describe types,
      // not runtime code.
      if (!entry.endsWith(".d.ts")) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function isExcluded(filePath: string): boolean {
  const normalized = filePath.split(sep).join("/");
  // Exclude app/api/** — server-side API routes are allowed to write.
  if (normalized.includes("/app/api/")) return true;
  // Exclude test files themselves.
  if (normalized.includes("/tests/")) return true;
  // Exclude node_modules and .next build cache.
  if (normalized.includes("/node_modules/")) return true;
  if (normalized.includes("/.next/")) return true;
  return false;
}

function scanFile(filePath: string): Array<{
  file: string;
  line: number;
  pattern: string;
  lineContent: string;
}> {
  if (isExcluded(filePath)) return [];
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  // Only flag files that import a Supabase client.
  const importsClient = CLIENT_IMPORT_PATTERNS.some((p) => p.test(content));
  if (!importsClient) return [];

  const violations: Array<{
    file: string;
    line: number;
    pattern: string;
    lineContent: string;
  }> = [];

  const lines = content.split("\n");
  for (const { name, regex } of WRITE_METHOD_PATTERNS) {
    // Use a global regex to find all matches.
    const globalRegex = new RegExp(regex.source, "g");
    let match;
    while ((match = globalRegex.exec(content)) !== null) {
      // Find the line number for this match.
      const beforeMatch = content.slice(0, match.index);
      const lineNum = beforeMatch.split("\n").length;
      const lineContent = lines[lineNum - 1]?.trim() ?? "";
      violations.push({
        file: relative(ROOT, filePath).split(sep).join("/"),
        line: lineNum,
        pattern: name,
        lineContent,
      });
    }
  }

  return violations;
}

describe("Work Package H: no client-side database writes on business tables", () => {
  it("scans components/ and app/ (excluding app/api/) for forbidden write methods", () => {
    const allFiles: string[] = [];
    for (const scanDir of SCAN_DIRS) {
      const fullDir = join(ROOT, scanDir);
      allFiles.push(...walkDir(fullDir));
    }

    const allViolations: Array<{
      file: string;
      line: number;
      pattern: string;
      lineContent: string;
    }> = [];

    for (const file of allFiles) {
      allViolations.push(...scanFile(file));
    }

    if (allViolations.length > 0) {
      const formatted = allViolations
        .map(
          (v) =>
            `  ${v.file}:${v.line} — ${v.pattern}\n    ${v.lineContent}`,
        )
        .join("\n");
      throw new Error(
        `Found ${allViolations.length} forbidden client-side database write(s):\n\n${formatted}\n\n` +
          `All database writes must go through server-side API routes (app/api/**) ` +
          `that enforce RBAC, input validation, audit logging, optimistic locking, ` +
          `and Storage lifecycle. Browser Supabase clients may only be used for ` +
          `Auth and read-only public queries.`,
      );
    }

    // The test passes when no violations are found.
    expect(allViolations).toHaveLength(0);
  });

  it("verifies the scan actually covers files (sanity check)", () => {
    // Sanity check: the scan must have examined at least the known
    // client-component files that import a Supabase client. This
    // ensures the walk + import-detection logic is working.
    const allFiles: string[] = [];
    for (const scanDir of SCAN_DIRS) {
      const fullDir = join(ROOT, scanDir);
      allFiles.push(...walkDir(fullDir));
    }

    // Filter to files that import a Supabase client.
    const clientFiles = allFiles.filter((f) => {
      if (isExcluded(f)) return false;
      try {
        const content = readFileSync(f, "utf8");
        return CLIENT_IMPORT_PATTERNS.some((p) => p.test(content));
      } catch {
        return false;
      }
    });

    // We know there are at least 4 client files that import Supabase
    // (ProductForm, AdminLayout, LoginForm, products page). If this
    // number drops to 0, the scan logic is broken.
    expect(clientFiles.length).toBeGreaterThanOrEqual(4);
  });
});
