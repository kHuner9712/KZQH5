#!/usr/bin/env node
// ============================================================
// Phase 4: Orphaned Storage Asset Inventory (READ-ONLY)
//
// This script identifies storage objects in a bucket that are no
// longer referenced by any database row. It is STRICTLY READ-ONLY.
//
// Safety:
//   - This script CANNOT delete objects. The previous --execute
//     mode was removed because the "list bucket → diff against
//     referenced URLs → delete unmatched" pattern risks deleting
//     in-flight uploads, objects referenced by URL shapes the
//     script does not know about, and objects in buckets where
//     LIST returns paginated/incomplete results.
//   - Actual cleanup MUST go through the storage_cleanup_queue
//     dispatcher (claim_storage_cleanup → check_storage_object_referenced
//     → delete → complete_storage_cleanup), which re-checks
//     references with the same RPC used by the trusted delete API.
//   - Any table/column/reference query failure is FATAL: the
//     script exits non-zero so it cannot be misread as "zero
//     orphans".
//
// Usage:
//   node scripts/cleanup-orphaned-assets.mjs
//   node scripts/cleanup-orphaned-assets.mjs --bucket private-assets
//   node scripts/cleanup-orphaned-assets.mjs --json
// ============================================================

// This script uses Node.js built-in modules + fetch (Node 18+).
// No external dependencies.

const DEFAULT_BUCKET = "public-assets";
const KNOWN_BUCKETS = new Set(["public-assets", "private-assets"]);

function parseArgs(argv) {
  const args = { bucket: DEFAULT_BUCKET, json: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--bucket") {
      args.bucket = argv[++i] || DEFAULT_BUCKET;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/cleanup-orphaned-assets.mjs [options]

Options:
  --bucket <name> Bucket to scan (default: ${DEFAULT_BUCKET})
  --json          Emit machine-readable JSON instead of human-readable text
  --help          Show this help message

NOTE: This script is READ-ONLY. It does not delete objects.
      Cleanup must go through storage_cleanup_queue + dispatcher.
`);
      process.exit(0);
    } else {
      console.error(`ERROR: unknown argument: ${arg}`);
      console.error("Run with --help for usage.");
      process.exit(2);
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

// Tables and URL columns that reference storage objects.
// This list MUST stay in sync with check_storage_object_referenced RPC.
// Any change here requires a corresponding RPC update + migration.
const REFERENCE_TABLES = [
  { table: "product_images", columns: ["image_url"] },
  { table: "products", columns: ["cover_image_url", "video_url"] },
  { table: "product_assets", columns: ["file_url", "cover_image_url"] },
  { table: "projects", columns: ["cover_image_url", "video_url"] },
  { table: "certificates", columns: ["image_url"] },
  { table: "company_profile", columns: ["logo_url", "wechat_qr_url"] },
  { table: "site_settings", columns: ["default_og_image_url"] },
  { table: "homepage_content", columns: ["hero_image_url"] },
];

async function fetchAllReferencedUrls(supabaseUrl, serviceKey) {
  // Collect all URLs from tables that reference storage objects.
  // Each table query is FATAL on non-404 errors — we never "warn and
  // continue", because a failed reference query would produce a false
  // positive orphan list that could be misused.
  const referencedUrls = new Set();
  const tableErrors = [];

  for (const { table, columns } of REFERENCE_TABLES) {
    const select = columns.join(",");
    const url = `${supabaseUrl}/rest/v1/${table}?select=${select}`;
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });

    if (res.status === 404) {
      // Table doesn't exist in this environment — allowed (schema skew
      // between environments). Skip silently.
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      tableErrors.push(
        `TABLE_QUERY_FAILED ${table} HTTP ${res.status}: ${text}`,
      );
      continue;
    }

    const rows = await res.json();
    if (!Array.isArray(rows)) {
      tableErrors.push(`TABLE_QUERY_INVALID ${table}: non-array response`);
      continue;
    }

    for (const row of rows) {
      for (const col of columns) {
        const val = row[col];
        if (typeof val === "string" && val.trim()) {
          referencedUrls.add(val.trim());
        }
      }
    }
  }

  if (tableErrors.length > 0) {
    // Fail closed: any reference query failure makes the orphan list
    // unreliable. Exit non-zero so the result cannot be misread.
    throw new Error(
      `REFERENCE_QUERY_FAILED\n  - ` + tableErrors.join("\n  - "),
    );
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

  if (!KNOWN_BUCKETS.has(args.bucket)) {
    console.error(
      `ERROR: unknown bucket "${args.bucket}". Allowed: public-assets, private-assets`,
    );
    process.exit(2);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error(
      "ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
    process.exit(1);
  }

  if (!args.json) {
    console.log(
      `[cleanup-orphaned-assets] bucket=${args.bucket} mode=READ-ONLY-INVENTORY`,
    );
    console.log(
      "  NOTE: This script does NOT delete objects. Cleanup must go through",
    );
    console.log(
      "        storage_cleanup_queue + dispatcher (claim_storage_cleanup RPC).",
    );
  }

  // 1. Fetch all storage objects (FATAL on failure)
  if (!args.json) console.log("Fetching storage objects...");
  let storageObjects;
  try {
    storageObjects = await fetchAllStorageObjects(
      supabaseUrl,
      serviceKey,
      args.bucket,
    );
  } catch (err) {
    console.error(`FATAL: storage list failed: ${err.message}`);
    process.exit(1);
  }
  if (!args.json) {
    console.log(`  Found ${storageObjects.length} objects in ${args.bucket}`);
  }

  // 2. Fetch all referenced URLs (FATAL on any non-404 failure)
  if (!args.json) console.log("Fetching referenced URLs from database...");
  let referencedUrls;
  try {
    referencedUrls = await fetchAllReferencedUrls(supabaseUrl, serviceKey);
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    console.error(
      "  Reference query failed — orphan inventory would be unreliable.",
    );
    process.exit(1);
  }
  if (!args.json) {
    console.log(`  Found ${referencedUrls.size} referenced URLs`);
  }

  // 3. Extract paths from referenced URLs
  const referencedPaths = new Set();
  for (const url of referencedUrls) {
    const path = extractPathFromUrl(url, args.bucket);
    if (path) referencedPaths.add(path);
  }
  if (!args.json) {
    console.log(`  ${referencedPaths.size} URLs point to ${args.bucket}`);
  }

  // 4. Find orphans
  const orphans = storageObjects.filter((obj) => {
    const name = obj.name || "";
    // Skip folder markers (objects ending with /)
    if (name.endsWith("/")) return false;
    return !referencedPaths.has(name);
  });

  const totalSize = orphans.reduce(
    (sum, obj) => sum + (obj.metadata?.size || 0),
    0,
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          bucket: args.bucket,
          mode: "read-only-inventory",
          totalObjects: storageObjects.length,
          referencedUrls: referencedUrls.size,
          referencedPathsInBucket: referencedPaths.size,
          orphanCount: orphans.length,
          orphanTotalSizeBytes: totalSize,
          orphans: orphans.slice(0, 100).map((o) => ({
            path: o.name,
            sizeBytes: o.metadata?.size ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n  Orphaned objects: ${orphans.length}`);
  if (orphans.length === 0) {
    console.log("  No orphaned objects detected.");
    console.log(
      "\n  REMINDER: This is a read-only inventory. No objects were deleted.",
    );
    return;
  }

  // Show first 20 orphans for review
  const preview = orphans.slice(0, 20);
  for (const obj of preview) {
    const size = obj.metadata?.size
      ? ` (${Math.round(obj.metadata.size / 1024)}KB)`
      : "";
    console.log(`    ${obj.name}${size}`);
  }
  if (orphans.length > 20) {
    console.log(`    ... and ${orphans.length - 20} more`);
  }

  console.log(
    `\n  Total orphaned size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`,
  );

  console.log(
    "\n  REMINDER: This is a read-only inventory. No objects were deleted.",
  );
  console.log(
    "  To clean up orphans, enqueue them via /api/admin/storage/cleanup",
  );
  console.log(
    "  and let the storage_cleanup_queue dispatcher handle deletion.",
  );
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
