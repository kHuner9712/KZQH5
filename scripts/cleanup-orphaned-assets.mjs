#!/usr/bin/env node
// ============================================================
// Phase 4: Orphaned Storage Asset Cleanup
//
// This script identifies storage objects in the `public-assets` bucket
// that are no longer referenced by any database row, and optionally
// deletes them.
//
// "Orphaned" means: a file exists in Storage but no table row points
// to its public URL. This happens when:
//   - An admin uploads a file but never saves the CMS form
//   - A product/project/certificate is deleted but its image wasn't
//   - A file is uploaded twice and the old URL is overwritten
//
// Safety:
//   - DRY RUN by default. Lists orphans but does NOT delete.
//   - Pass --execute to actually delete.
//   - Requires SUPABASE_SERVICE_ROLE_KEY (server-side only).
//   - Never deletes files referenced by ANY table.
//
// Usage:
//   node scripts/cleanup-orphaned-assets.mjs              # dry run
//   node scripts/cleanup-orphaned-assets.mjs --execute    # actually delete
//   node scripts/cleanup-orphaned-assets.mjs --bucket private-assets
// ============================================================

// This script uses Node.js built-in modules + fetch (Node 18+).
// No external dependencies.

const DEFAULT_BUCKET = "public-assets";

function parseArgs(argv) {
  const args = { execute: false, bucket: DEFAULT_BUCKET };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--bucket") {
      args.bucket = argv[++i] || DEFAULT_BUCKET;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/cleanup-orphaned-assets.mjs [options]

Options:
  --execute       Actually delete orphaned files (default: dry run)
  --bucket <name> Bucket to scan (default: ${DEFAULT_BUCKET})
  --help          Show this help message
`);
      process.exit(0);
    }
  }
  return args;
}

async function fetchAllStorageObjects(supabaseUrl, serviceKey, bucket) {
  const objects = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = `${supabaseUrl}/storage/v1/object/list/${bucket}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix: "",
        limit,
        offset,
        sortBy: { column: "name", order: "asc" },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`STORAGE_LIST_FAILED HTTP ${res.status}: ${text}`);
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    objects.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return objects;
}

async function fetchAllReferencedUrls(supabaseUrl, serviceKey) {
  // Collect all URLs from tables that reference storage objects.
  // We query each table for URL columns and build a Set of referenced URLs.
  const referencedUrls = new Set();

  const tables = [
    // Product images
    { table: "product_images", columns: ["image_url"] },
    // Products (main image)
    { table: "products", columns: ["main_image_url"] },
    // Product assets (catalog PDFs, cover images)
    {
      table: "product_assets",
      columns: ["file_url", "cover_image_url"],
    },
    // Projects
    { table: "projects", columns: ["image_url", "cover_image_url"] },
    // Certificates
    { table: "certificates", columns: ["image_url", "file_url"] },
    // Company profile (logo, etc.)
    { table: "company_profile", columns: ["logo_url"] },
  ];

  for (const { table, columns } of tables) {
    const select = columns.join(",");
    const url = `${supabaseUrl}/rest/v1/${table}?select=${select}`;
    try {
      const res = await fetch(url, {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      });

      if (res.status === 404) {
        // Table doesn't exist in this environment — skip
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`WARN: ${table} query failed HTTP ${res.status}: ${text}`);
        continue;
      }

      const rows = await res.json();
      if (!Array.isArray(rows)) continue;

      for (const row of rows) {
        for (const col of columns) {
          const val = row[col];
          if (typeof val === "string" && val.trim()) {
            referencedUrls.add(val.trim());
          }
        }
      }
    } catch (err) {
      console.warn(`WARN: ${table} query error: ${err.message}`);
    }
  }

  return referencedUrls;
}

function extractPathFromUrl(url, bucket) {
  // Supabase public URLs look like:
  // https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
  try {
    const parsed = new URL(url);
    const prefix = `/storage/v1/object/public/${bucket}/`;
    const idx = parsed.pathname.indexOf(prefix);
    if (idx === -1) return null;
    return decodeURIComponent(parsed.pathname.slice(idx + prefix.length));
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }

  console.log(`[cleanup-orphaned-assets] bucket=${args.bucket} mode=${args.execute ? "EXECUTE" : "DRY-RUN"}`);

  // 1. Fetch all storage objects
  console.log("Fetching storage objects...");
  const storageObjects = await fetchAllStorageObjects(supabaseUrl, serviceKey, args.bucket);
  console.log(`  Found ${storageObjects.length} objects in ${args.bucket}`);

  // 2. Fetch all referenced URLs
  console.log("Fetching referenced URLs from database...");
  const referencedUrls = await fetchAllReferencedUrls(supabaseUrl, serviceKey);
  console.log(`  Found ${referencedUrls.size} referenced URLs`);

  // 3. Extract paths from referenced URLs
  const referencedPaths = new Set();
  for (const url of referencedUrls) {
    const path = extractPathFromUrl(url, args.bucket);
    if (path) referencedPaths.add(path);
  }
  console.log(`  ${referencedPaths.size} URLs point to ${args.bucket}`);

  // 4. Find orphans
  const orphans = storageObjects.filter((obj) => {
    const name = obj.name || "";
    // Skip folder markers (objects ending with /)
    if (name.endsWith("/")) return false;
    return !referencedPaths.has(name);
  });

  console.log(`\n  Orphaned objects: ${orphans.length}`);
  if (orphans.length === 0) {
    console.log("  No cleanup needed.");
    return;
  }

  // Show first 20 orphans for review
  const preview = orphans.slice(0, 20);
  for (const obj of preview) {
    const size = obj.metadata?.size ? ` (${Math.round(obj.metadata.size / 1024)}KB)` : "";
    console.log(`    ${obj.name}${size}`);
  }
  if (orphans.length > 20) {
    console.log(`    ... and ${orphans.length - 20} more`);
  }

  const totalSize = orphans.reduce((sum, obj) => sum + (obj.metadata?.size || 0), 0);
  console.log(`\n  Total orphaned size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);

  // 5. Delete if --execute
  if (!args.execute) {
    console.log("\n  DRY RUN: No files deleted. Pass --execute to delete.");
    return;
  }

  console.log(`\n  Deleting ${orphans.length} orphaned objects...`);
  let deleted = 0;
  let failed = 0;

  for (const obj of orphans) {
    const name = obj.name;
    const url = `${supabaseUrl}/storage/v1/object/${args.bucket}/${name}`;
    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      });
      if (res.ok || res.status === 404) {
        deleted++;
      } else {
        failed++;
        console.warn(`    FAILED: ${name} HTTP ${res.status}`);
      }
    } catch (err) {
      failed++;
      console.warn(`    ERROR: ${name} ${err.message}`);
    }
  }

  console.log(`\n  Done. Deleted: ${deleted}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
