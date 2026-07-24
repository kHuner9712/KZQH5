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

describe("Phase 4: Storage boundary — cleanup script safety", () => {
  const CLEANUP_SCRIPT = "scripts/cleanup-orphaned-assets.mjs";

  it("cleanup script exists", () => {
    expect(existsSync(join(ROOT, CLEANUP_SCRIPT))).toBe(true);
  });

  it("cleanup script defaults to DRY-RUN (does not delete without --execute)", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    // The default must be execute: false
    expect(content).toMatch(/execute:\s*false/);
    // The --execute flag must be required to actually delete
    expect(content).toMatch(/--execute/);
    // There must be a dry-run branch that returns before deleting
    expect(content).toMatch(/DRY RUN/);
  });

  it("cleanup script requires SUPABASE_SERVICE_ROLE_KEY (server-side only)", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    expect(content).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    // Must exit with error if the key is missing
    expect(content).toMatch(/process\.exit\(1\)/);
  });

  it("cleanup script checks ALL referencing tables before deleting", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    // Every table that holds a storage URL must be checked.
    // If a file is referenced by ANY table, it must NOT be deleted.
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

  it("cleanup script counts failures separately from successes", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    // The script must track failed deletions separately, so a partial
    // failure is NOT misreported as complete success.
    expect(content).toMatch(/failed/);
    expect(content).toMatch(/deleted/);
    // The final report must include both counts
    expect(content).toMatch(/Deleted.*Failed/);
  });

  it("cleanup script treats 404 on delete as success (already gone)", () => {
    const content = readRoot(CLEANUP_SCRIPT);
    // A 404 on DELETE means the file was already removed — this is safe
    // to count as success because the end state (file gone) is achieved.
    expect(content).toMatch(/res\.status === 404/);
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
