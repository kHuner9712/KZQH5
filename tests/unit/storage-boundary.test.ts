import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// Phase 4: Storage boundary tests
// ------------------------------------------------------------
// Proves that Storage security is enforced at the server-side
// trusted boundary, not only in client-side validation:
//
//   1. Upload functions only use allowlisted buckets (static scan)
//   2. SVG is excluded from the MIME allowlist at every layer
//   3. The cleanup script is DRY-RUN by default (never auto-deletes)
//   4. The cleanup script does NOT delete files referenced by any table
//   5. Unpublished resources do not get a public URL in the catalog repo
//   6. The storage bucket hardening migration enforces MIME + size
//      at the database level (the real gatekeeper)
// ============================================================

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..");

function readRoot(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Phase 4: Storage boundary — no direct browser storage uploads", () => {
  it("the browser-side storage upload module has been removed", () => {
    // Client components must not call createBrowserSupabaseClient().storage.upload()
    // directly. The old lib/supabase/storage.ts module has been deleted; uploads
    // now go through the trusted server API (/api/admin/storage/*).
    expect(existsSync(join(ROOT, "lib/supabase/storage.ts"))).toBe(false);
  });

  it("the server-API client wrapper exists", () => {
    expect(existsSync(join(ROOT, "lib/services/admin-storage-fetch.ts"))).toBe(true);
  });

  it("the client wrapper does not call Supabase storage directly", () => {
    const content = readRoot("lib/services/admin-storage-fetch.ts");
    // No direct .storage.from(...) calls — uploads/deletes go through fetch()
    // to the server, which owns the allowlisted bucket selection.
    expect(content).not.toMatch(/\.storage\.from\(/);
  });

  it("the client wrapper uploads/deletes via the trusted server endpoints", () => {
    const content = readRoot("lib/services/admin-storage-fetch.ts");
    expect(content).toMatch(/\/api\/admin\/storage\/upload/);
    expect(content).toMatch(/\/api\/admin\/storage\/object/);
  });
});

describe("Phase 4: Storage boundary — SVG exclusion at every layer", () => {
  it("validation module excludes SVG from PUBLIC_ASSETS_ALLOWED_MIME", () => {
    const content = readRoot("lib/validation/storage.ts");
    expect(content).not.toMatch(/image\/svg\+xml/);
    expect(content).toMatch(/SVG is intentionally excluded/);
  });

  it("storage bucket hardening migration excludes SVG from allowed_mime_types", () => {
    const content = readRoot("supabase/migrations/20260724170000_storage_bucket_hardening.sql");
    // The migration must NOT include image/svg+xml in the allowed_mime_types array.
    expect(content).not.toMatch(/image\/svg\+xml/);
    // It must include the four allowed types.
    expect(content).toMatch(/application\/pdf/);
    expect(content).toMatch(/image\/jpeg/);
    expect(content).toMatch(/image\/png/);
    expect(content).toMatch(/image\/webp/);
  });

  it("migration enforces file_size_limit at the bucket level", () => {
    const content = readRoot("supabase/migrations/20260724170000_storage_bucket_hardening.sql");
    // 50 MB = 52428800 bytes
    expect(content).toMatch(/file_size_limit\s*=\s*52428800/);
  });

  it("migration hardens BOTH public-assets and private-assets buckets", () => {
    const content = readRoot("supabase/migrations/20260724170000_storage_bucket_hardening.sql");
    expect(content).toMatch(/where name = 'public-assets'/);
    expect(content).toMatch(/where name = 'private-assets'/);
  });
});

describe("Phase 4: Storage boundary — cleanup script is READ-ONLY inventory", () => {
  const CLEANUP_SCRIPT = "scripts/cleanup-orphaned-assets.mjs";

  it("cleanup script exists", () => {
    expect(existsSync(join(ROOT, CLEANUP_SCRIPT))).toBe(true);
  });

  it("cleanup script is READ-ONLY (no --execute flag, no delete path)", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    // The dangerous --execute flag must NOT be parsed as a CLI argument.
    // Comments documenting its removal are allowed; the actual parseArgs
    // function must not accept it.
    const parseArgsBlock = content.match(/function\s+parseArgs[\s\S]+?\n\}/);
    expect(parseArgsBlock).not.toBeNull();
    expect(parseArgsBlock![0]).not.toMatch(/--execute/);
    // No DELETE HTTP method against storage objects.
    expect(content).not.toMatch(/method:\s*["']DELETE["']/);
    // Must explicitly declare READ-ONLY mode.
    expect(content).toMatch(/READ-ONLY/);
    // Must explicitly state that cleanup goes through storage_cleanup_queue.
    expect(content).toMatch(/storage_cleanup_queue/);
  });

  it("cleanup script requires SUPABASE_SERVICE_ROLE_KEY (server-side only)", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    expect(content).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    // Must exit with error if the key is missing
    expect(content).toMatch(/process\.exit\(1\)/);
  });

  it("cleanup script checks ALL referencing tables (reference query must be exhaustive)", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    // Every table that holds a storage URL must be checked so that
    // orphan inventory is reliable. The list must stay in sync with
    // check_storage_object_referenced RPC.
    const requiredTables = [
      "product_images",
      "products",
      "product_assets",
      "projects",
      "certificates",
      "company_profile",
    ];
    for (const table of requiredTables) {
      expect(
        content,
        `cleanup script must check table "${table}" for referenced URLs`,
      ).toContain(table);
    }
  });

  it("cleanup script is fail-closed: any reference query failure is FATAL", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    // The script must NOT "warn and continue" on reference query failures.
    // A failed reference query would produce a false-positive orphan list
    // that could be misused. Any non-404 error must abort with non-zero exit.
    expect(content).toMatch(/REFERENCE_QUERY_FAILED|FATAL/);
    expect(content).toMatch(/process\.exit\(1\)/);
  });

  it("cleanup script never claims object deletion (no 'Deleted' count in output)", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    // The script must NOT output a "Deleted: N" counter, because it does
    // not delete anything. Misleading success counters are forbidden.
    expect(content).not.toMatch(/Deleted.*Failed/);
    // The reminder that "no objects were deleted" must appear.
    expect(content).toMatch(/No objects were deleted|does NOT delete objects/);
  });
});

describe("Phase 4: Storage boundary — unpublished resources", () => {
  it("catalog repository only queries is_published=true assets", () => {
    const content = readRoot("lib/repositories/product-assets.ts");
    // getPublishedProductAssets must filter on is_published = true.
    // Unpublished assets must NEVER appear in the public catalog.
    expect(content).toMatch(/is_published.*true/);
  });

  it("catalog repository uses the public (anon) Supabase client, not admin", () => {
    const content = readRoot("lib/repositories/product-assets.ts");
    // Public reads must use createPublicSupabaseClient (anon key, RLS-enforced).
    // They must NOT use createAdminSupabaseClient (service_role, RLS-bypassing).
    expect(content).toMatch(/createPublicSupabaseClient/);
    expect(content).not.toMatch(/createAdminSupabaseClient/);
  });
});
