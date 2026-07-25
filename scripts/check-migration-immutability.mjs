#!/usr/bin/env node
// ============================================================
// check-migration-immutability.mjs
// ------------------------------------------------------------
// CI gate that enforces migration history immutability.
//
// The file docs/MIGRATION_SHA256_MANIFEST.txt records the SHA-256
// of every migration file under supabase/migrations/ at the time
// of the first green HEAD after the "pre-merge migration
// correction exception" window closed.
//
// Subsequent PRs MUST NOT modify a migration file that already
// appears in the manifest. New fixes must be added as a NEW
// migration file with a strictly later timestamp, and the manifest
// must be updated in the SAME PR to include the new file.
//
// This script:
//   1. Reads the manifest.
//   2. For each (filename, expected_sha256) entry in the manifest,
//      verifies that the file still exists and its current SHA-256
//      matches the recorded value.
//   3. Reports any mismatch as a BLOCK (exit code 1).
//   4. Reports any migration file on disk that is NOT in the
//      manifest as a WARN (does not fail CI, but prints a notice
//      so reviewers know the manifest needs to be updated).
//
// Exit codes:
//   0 = all manifest entries match, no tampering detected
//   1 = one or more manifest entries mismatch (a frozen migration
//       was modified)
//   2 = manifest file is missing or unreadable
//
// Usage:
//   node scripts/check-migration-immutability.mjs
//
// To update the manifest after adding a new migration:
//   node scripts/check-migration-immutability.mjs --update
// (This regenerates the manifest from the current on-disk state.
// Only run this AFTER all migrations are final and the PR is
// about to be merged.)
// ============================================================

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const MANIFEST_PATH = join(ROOT, "docs", "MIGRATION_SHA256_MANIFEST.txt");

const UPDATE_MODE = process.argv.includes("--update");

/**
 * Compute SHA-256 of a file by streaming it (handles large files).
 */
async function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Parse the manifest file. Each non-comment, non-empty line is:
 *   <sha256>  <filename>
 * Lines starting with '#' are comments. Lines starting with '--'
 * are SQL-style comments (also skipped).
 */
function parseManifest(text) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("--")) continue;
    // Format: 64 hex chars, whitespace, filename
    const match = /^([0-9a-fA-F]{64})\s+(\S.+)$/.exec(line);
    if (!match) {
      throw new Error(
        `manifest parse error: unrecognized line: ${rawLine}`,
      );
    }
    entries.push({
      sha256: match[1].toLowerCase(),
      filename: match[2].trim(),
    });
  }
  return entries;
}

/**
 * Generate manifest text from the current on-disk migration files.
 */
async function generateManifest() {
  const files = await readdir(MIGRATIONS_DIR);
  const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();
  const lines = [];
  lines.push("# Migration SHA-256 Manifest");
  lines.push("#");
  lines.push(
    "# Records the SHA-256 of every migration file under supabase/migrations/",
  );
  lines.push(
    "# at the time of the first green HEAD after the pre-merge migration",
  );
  lines.push("# correction exception window closed.",
  );
  lines.push("#");
  lines.push(
    "# Subsequent PRs MUST NOT modify a migration that already appears here.",
  );
  lines.push(
    "# New fixes must be added as a NEW migration with a strictly later",
  );
  lines.push(
    "# timestamp, and this manifest must be updated in the SAME PR to",
  );
  lines.push("# include the new file.",
  );
  lines.push("#");
  lines.push("# Regenerate with: node scripts/check-migration-immutability.mjs --update");
  lines.push("");
  for (const filename of sqlFiles) {
    const fullPath = join(MIGRATIONS_DIR, filename);
    const stats = await stat(fullPath);
    if (!stats.isFile()) continue;
    const hash = await sha256OfFile(fullPath);
    lines.push(`${hash}  ${filename}`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  if (UPDATE_MODE) {
    const text = await generateManifest();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(MANIFEST_PATH, text, "utf8");
    console.log(
      `manifest updated: ${MANIFEST_PATH} (${text.split("\n").length} lines)`,
    );
    return;
  }

  // Read manifest.
  let manifestText;
  try {
    manifestText = await readFile(MANIFEST_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(
        `BLOCK: manifest not found at ${MANIFEST_PATH}. ` +
          `Run 'node scripts/check-migration-immutability.mjs --update' ` +
          `to generate it after all migrations are final.`,
      );
      process.exit(2);
    }
    throw err;
  }

  const entries = parseManifest(manifestText);
  if (entries.length === 0) {
    console.error("BLOCK: manifest is empty.");
    process.exit(1);
  }

  // Verify each manifest entry matches the current on-disk file.
  let mismatches = 0;
  for (const entry of entries) {
    const fullPath = join(MIGRATIONS_DIR, entry.filename);
    let actualHash;
    try {
      actualHash = await sha256OfFile(fullPath);
    } catch (err) {
      if (err.code === "ENOENT") {
        console.error(
          `BLOCK: manifest references '${entry.filename}' but the file ` +
            `no longer exists. Frozen migrations must not be deleted.`,
        );
        mismatches += 1;
        continue;
      }
      throw err;
    }
    if (actualHash !== entry.sha256) {
      console.error(
        `BLOCK: migration '${entry.filename}' has been modified.` +
          `\n  manifest sha256: ${entry.sha256}` +
          `\n  current  sha256: ${actualHash}` +
          `\n  Frozen migrations must not be edited. Add a NEW migration ` +
          `with a strictly later timestamp and update the manifest in the ` +
          `same PR.`,
      );
      mismatches += 1;
    }
  }

  // Report (but do not block) migration files on disk that are not
  // in the manifest — these are new migrations whose PR has not yet
  // updated the manifest.
  const manifestFilenames = new Set(entries.map((e) => e.filename));
  const diskFiles = (await readdir(MIGRATIONS_DIR)).filter((f) =>
    f.endsWith(".sql"),
  );
  const unregistered = diskFiles.filter((f) => !manifestFilenames.has(f));
  if (unregistered.length > 0) {
    console.warn(
      `WARN: ${unregistered.length} migration file(s) on disk are not in ` +
        `the manifest:`,
    );
    for (const f of unregistered) {
      console.warn(`  - ${f}`);
    }
    console.warn(
      `Update the manifest with ` +
        `'node scripts/check-migration-immutability.mjs --update' ` +
        `in this PR before merging.`,
    );
  }

  if (mismatches > 0) {
    console.error(
      `\nBLOCK: ${mismatches} frozen migration(s) were modified.`,
    );
    process.exit(1);
  }

  console.log(
    `PASS: ${entries.length} frozen migration(s) verified. ` +
      `${unregistered.length} unregistered (WARN).`,
  );
}

main().catch((err) => {
  console.error("check-migration-immutability failed:", err);
  process.exit(1);
});
