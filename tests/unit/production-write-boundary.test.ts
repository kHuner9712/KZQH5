import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ============================================================
// Production write boundary test
// ------------------------------------------------------------
// Statically scans the codebase to ensure Client Components and
// browser-side Supabase repositories do NOT directly execute
// insert / update / delete / upsert on business tables.
//
// Admin writes MUST go through server-side API routes
// (app/api/admin/**) which use requireAdminWrite() from
// lib/services/admin-write-boundary.ts and service_role clients.
//
// The ONLY allowed client-side writes are:
//   1. inquiries INSERT via /api/inquiries (NOT direct client insert)
//   2. analytics_events INSERT via /api/analytics/events
//   3. product_assets SELECT for catalog viewing (read-only)
// ============================================================

// --- Path setup -----------------------------------------------------------
// Compute the project root from this test file's location so the test is
// independent of the process working directory.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..");

// --- Helpers --------------------------------------------------------------

/**
 * Normalize an absolute path to a forward-slash relative path from ROOT.
 * This makes allowlist keys and violation reports cross-platform.
 */
function normalizePath(absPath: string): string {
  return relative(ROOT, absPath).split(sep).join("/");
}

/**
 * Walk a directory recursively and return all .ts / .tsx file paths.
 * Skips node_modules and .next build output to avoid false positives.
 */
function walkDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const results: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else {
      const ext = extname(fullPath);
      if (ext === ".ts" || ext === ".tsx") {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Check if a file has a "use client" directive.
 * Only the first few lines matter, but scanning the whole content is safe
 * because the directive is only valid at the top of the file anyway.
 */
function isClientComponent(content: string): boolean {
  return content.includes('"use client"') || content.includes("'use client'");
}

interface WriteViolation {
  /** Which banned method was detected. */
  method: string;
  /** 1-based line number where the match starts. */
  line: number;
  /** Short snippet of the matched text for debugging. */
  snippet: string;
}

/**
 * Banned write method patterns on Supabase clients.
 * These match calls like `supabase.from("table").insert(...)` or
 * `client.from("table").update(...)` regardless of the variable name.
 * The patterns tolerate whitespace (including newlines) between
 * `.from(...)` and the write method, so multi-line chains are caught.
 */
const WRITE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "insert", pattern: /\.from\s*\([^)]*\)\s*\.\s*insert\s*\(/ },
  { name: "update", pattern: /\.from\s*\([^)]*\)\s*\.\s*update\s*\(/ },
  { name: "delete", pattern: /\.from\s*\([^)]*\)\s*\.\s*delete\s*\(\s*\)/ },
  { name: "upsert", pattern: /\.from\s*\([^)]*\)\s*\.\s*upsert\s*\(/ },
];

/**
 * Scan file content for banned Supabase write patterns.
 * Returns one entry per match with the method name and line number.
 */
function findWriteViolations(content: string): WriteViolation[] {
  const violations: WriteViolation[] = [];
  for (const { name, pattern } of WRITE_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, "g");
    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length;
      const raw = match[0].replace(/\s+/g, " ").trim();
      const snippet = raw.length > 90 ? raw.slice(0, 90) + " ..." : raw;
      violations.push({ method: name, line, snippet });
    }
  }
  return violations;
}

// --- Allowlist ------------------------------------------------------------
// Files exempt from the write boundary, each with a documented reason.
// Kept intentionally small. Two categories:
//
//   A) Legitimate server-side repositories that use createAdminSupabaseClient()
//      (service_role key). These are NEVER imported by client components and
//      back the public API routes.
//
//   B) Legacy admin browser writes that currently violate the boundary.
//      These must be migrated to /api/admin/** routes using requireAdminWrite().
//      The allowlist prevents new violations while documenting existing debt.
// ------------------------------------------------------------------------

const ALLOWLIST: Record<string, string> = {
  // --- A) Legitimate server-side repositories (service_role, server-only) ---
  "lib/repositories/inquiries.ts":
    "Server-side repository. createInquiry / createInquiryWithItems use " +
    "createAdminSupabaseClient() (service_role) and back /api/inquiries. " +
    "updateInquiry accepts a server client passed by /api/admin/inquiries. " +
    "Never imported by client components.",
  "lib/repositories/analytics.ts":
    "Server-side repository. recordAnalyticsEvent uses " +
    "createAdminSupabaseClient() (service_role) and backs " +
    "/api/analytics/events. Never imported by client components.",

  // --- B) Legacy admin browser writes (pending migration to /api/admin/**) ---
  "lib/repositories/product-assets.ts":
    "LEGACY: saveProductAsset / deleteProductAsset accept a client param and " +
    "are called from the admin product-assets page with a browser client. " +
    "Pending migration to /api/admin/product-assets using requireAdminWrite(). " +
    "getPublishedProductAssets (read) uses createPublicSupabaseClient().",
  "lib/repositories/projects.ts":
    "LEGACY: saveProject / replaceProjectImages / replaceProjectProducts / " +
    "deleteProject accept a client param and are called from the admin " +
    "projects page with a browser client. Pending migration to " +
    "/api/admin/projects using requireAdminWrite(). Read helpers use " +
    "createPublicSupabaseClient().",
  "app/admin/(protected)/categories/page.tsx":
    "LEGACY: Admin client component performs direct browser writes " +
    "(.from().insert / update / delete) on categories and subcategories via " +
    "createBrowserSupabaseClient(). Pending migration to " +
    "/api/admin/categories using requireAdminWrite().",
  "app/admin/(protected)/certificates/page.tsx":
    "LEGACY: Admin client component performs direct browser writes " +
    "(.from().insert / update / delete) on certificates via " +
    "createBrowserSupabaseClient(). Pending migration to " +
    "/api/admin/certificates using requireAdminWrite().",
  "app/admin/(protected)/company/page.tsx":
    "LEGACY: Admin client component performs direct browser writes " +
    "(.from().insert / update) on company_profile via " +
    "createBrowserSupabaseClient(). Pending migration to " +
    "/api/admin/company using requireAdminWrite().",
  "app/admin/(protected)/homepage/page.tsx":
    "LEGACY: Admin client component performs direct browser writes " +
    "(.from().insert / update) on homepage_content via " +
    "createBrowserSupabaseClient(). Pending migration to " +
    "/api/admin/homepage using requireAdminWrite().",
  "app/admin/(protected)/pages/page.tsx":
    "LEGACY: Admin client component performs direct browser writes " +
    "(.from().insert / update) on page_content via " +
    "createBrowserSupabaseClient(). Pending migration to " +
    "/api/admin/pages using requireAdminWrite().",
  "app/admin/(protected)/site-settings/page.tsx":
    "LEGACY: Admin client component performs direct browser writes " +
    "(.from().insert / update) on site_settings via " +
    "createBrowserSupabaseClient(). Pending migration to " +
    "/api/admin/site-settings using requireAdminWrite().",
};

// --- Directories to scan --------------------------------------------------
const COMPONENTS_DIR = join(ROOT, "components");
const APP_DIR = join(ROOT, "app");
const REPOSITORIES_DIR = join(ROOT, "lib", "repositories");
const SUPABASE_DIR = join(ROOT, "lib", "supabase");
const BROWSER_CLIENT_FILE = join(SUPABASE_DIR, "client.ts");

// ============================================================
// Tests
// ============================================================

describe("Production write boundary", () => {
  describe("Client Components (components/ and app/ with \"use client\")", () => {
    it("do not directly call Supabase write methods on business tables", () => {
      const files = [
        ...walkDir(COMPONENTS_DIR),
        ...walkDir(APP_DIR),
      ];

      // Sanity: the scan must actually find client components.
      const clientFiles = files.filter((f) => isClientComponent(readFileSync(f, "utf8")));
      expect(clientFiles.length, "expected to find at least one client component").toBeGreaterThan(0);

      const violations: Array<{ file: string; method: string; line: number; snippet: string }> = [];

      for (const file of clientFiles) {
        const rel = normalizePath(file);
        if (rel in ALLOWLIST) continue; // exempt — reason documented above
        const content = readFileSync(file, "utf8");
        const found = findWriteViolations(content);
        for (const v of found) {
          violations.push({ file: rel, method: v.method, line: v.line, snippet: v.snippet });
        }
      }

      if (violations.length > 0) {
        const report = violations
          .map((v) => `  - ${v.file}:${v.line}  [${v.method}]  ${v.snippet}`)
          .join("\n");
        throw new Error(
          `Client Components must not directly call Supabase write methods.\n` +
          `These writes must go through server-side API routes (/api/admin/**) ` +
          `using requireAdminWrite().\n` +
          `Violations found:\n${report}`,
        );
      }
    });
  });

  describe("Browser repositories (lib/repositories/)", () => {
    it("do not directly call Supabase write methods on business tables", () => {
      const files = walkDir(REPOSITORIES_DIR);

      // Sanity: the scan must actually find repository files.
      expect(files.length, "expected to find at least one repository file").toBeGreaterThan(0);

      const violations: Array<{ file: string; method: string; line: number; snippet: string }> = [];

      for (const file of files) {
        const rel = normalizePath(file);
        if (rel in ALLOWLIST) continue; // exempt — reason documented above
        const content = readFileSync(file, "utf8");
        const found = findWriteViolations(content);
        for (const v of found) {
          violations.push({ file: rel, method: v.method, line: v.line, snippet: v.snippet });
        }
      }

      if (violations.length > 0) {
        const report = violations
          .map((v) => `  - ${v.file}:${v.line}  [${v.method}]  ${v.snippet}`)
          .join("\n");
        throw new Error(
          `Browser repositories must not directly call Supabase write methods.\n` +
          `Writes must use createAdminSupabaseClient() (server-side, service_role) ` +
          `and be invoked only from server-side API routes.\n` +
          `Violations found:\n${report}`,
        );
      }
    });
  });

  describe("Browser Supabase client (lib/supabase/client.ts)", () => {
    it("does not import or call createClient (the low-level Supabase factory)", () => {
      const content = readFileSync(BROWSER_CLIENT_FILE, "utf8");
      // The browser client must use createBrowserClient from @supabase/ssr,
      // not the low-level createClient from @supabase/supabase-js which could
      // be used with service_role.
      //
      // We check for the exact string "createClient". This is safe because:
      //   - "createBrowserClient" does NOT contain "createClient" as a substring
      //     (create + Browser + Client  vs  create + Client)
      //   - "SupabaseClient" does NOT contain "createClient"
      // So this only matches the actual createClient function, whether imported
      // as a value or called at runtime.
      expect(
        content,
        "lib/supabase/client.ts must not import or call createClient " +
          "(use createBrowserClient from @supabase/ssr instead)",
      ).not.toContain("createClient");
    });

    it("does not reference SUPABASE_SERVICE_ROLE_KEY", () => {
      const content = readFileSync(BROWSER_CLIENT_FILE, "utf8");
      expect(
        content,
        "lib/supabase/client.ts must never reference the service_role key",
      ).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    });

    it("does not reference service_role auth mode", () => {
      const content = readFileSync(BROWSER_CLIENT_FILE, "utf8");
      expect(
        content,
        "lib/supabase/client.ts must never use service_role auth mode",
      ).not.toMatch(/service_role/i);
    });

    it("does not import from the admin client module", () => {
      const content = readFileSync(BROWSER_CLIENT_FILE, "utf8");
      // The browser client must not re-export or import the admin
      // (service_role) client, otherwise admin capabilities would leak
      // to the browser bundle.
      expect(
        content,
        "lib/supabase/client.ts must not import from ./admin",
      ).not.toMatch(/from\s+["']\.\/admin["']/);
    });

    it("uses createBrowserClient from @supabase/ssr", () => {
      const content = readFileSync(BROWSER_CLIENT_FILE, "utf8");
      expect(
        content,
        "lib/supabase/client.ts must use createBrowserClient from @supabase/ssr",
      ).toMatch(/createBrowserClient/);
    });

    it("uses only NEXT_PUBLIC_ env vars (no server-only secrets)", () => {
      const content = readFileSync(BROWSER_CLIENT_FILE, "utf8");
      // Browser-accessible code may only reference NEXT_PUBLIC_ env vars.
      // Any other env var would be undefined in the browser or, worse,
      // leak a server secret into the client bundle.
      const envVarMatches = content.match(/process\.env\.([A-Z_][A-Z0-9_]*)/g) || [];
      for (const ref of envVarMatches) {
        const name = ref.replace("process.env.", "");
        expect(
          name.startsWith("NEXT_PUBLIC_"),
          `lib/supabase/client.ts references non-public env var "${name}" — ` +
            `browser code may only use NEXT_PUBLIC_* variables`,
        ).toBe(true);
      }
    });
  });

  describe("Allowlist integrity", () => {
    it("every allowlisted file exists on disk", () => {
      const missing: string[] = [];
      for (const rel of Object.keys(ALLOWLIST)) {
        const abs = join(ROOT, ...rel.split("/"));
        if (!existsSync(abs)) {
          missing.push(rel);
        }
      }
      expect(missing, `stale allowlist entries (files not found):\n${missing.join("\n")}`).toEqual([]);
    });

    it("every allowlisted file actually contains a write pattern (no free passes)", () => {
      const stale: string[] = [];
      for (const rel of Object.keys(ALLOWLIST)) {
        const abs = join(ROOT, ...rel.split("/"));
        if (!existsSync(abs)) continue;
        const content = readFileSync(abs, "utf8");
        const found = findWriteViolations(content);
        if (found.length === 0) {
          stale.push(rel);
        }
      }
      expect(
        stale,
        `allowlist entries with no write pattern (remove them):\n${stale.join("\n")}`,
      ).toEqual([]);
    });
  });
});
