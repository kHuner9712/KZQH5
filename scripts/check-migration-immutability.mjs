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
// must be updated in the SAME PR via `--append-new`.
//
// Modes:
//   (default)         Strict verification — any tampering with a
//                     frozen migration, any missing manifest, any
//                     unregistered on-disk file, any manifest
//                     reference to a missing file, any duplicate
//                     filename/hash line, or any non-monotonic
//                     timestamp causes exit code 1.
//   --append-new      Verifies all registered hashes match, then
//                     appends the SHA-256 of any NEW migration
//                     file (one not yet in the manifest) to the
//                     manifest. Existing hash lines are NEVER
//                     rewritten. New file timestamps must be
//                     strictly later than the last versioned
//                     migration already in the manifest.
//   --initialize      One-time bootstrap. Refuses to run if a
//                     manifest already exists. Generates a fresh
//                     manifest from the current on-disk state.
//
// The legacy `--update` mode (full manifest rewrite) is INTENTIONALLY
// REMOVED. It allowed a single command to overwrite every frozen
// hash, defeating the entire point of the gate.
//
// Exit codes:
//   0 = pass (verify) or success (append-new / initialize)
//   1 = BLOCK — tampering, missing manifest, unregistered file,
//              non-monotonic timestamp, duplicate, parse error
// ============================================================

import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const MANIFEST_PATH = join(ROOT, "docs", "MIGRATION_SHA256_MANIFEST.txt");

const argv = process.argv.slice(2);
const MODE_APPEND_NEW = argv.includes("--append-new");
const MODE_INITIALIZE = argv.includes("--initialize");
const MODE_UPDATE = argv.includes("--update"); // legacy, removed

if (MODE_UPDATE) {
  console.error(
    "BLOCK: --update mode has been removed. It allowed rewriting every " +
      "frozen hash in one command, defeating the immutability gate. " +
      "Use --append-new to register a NEW migration, or --initialize " +
      "for a one-time bootstrap when no manifest exists yet.",
  );
  process.exit(1);
}

if (MODE_APPEND_NEW && MODE_INITIALIZE) {
  console.error("BLOCK: --append-new and --initialize are mutually exclusive.");
  process.exit(1);
}

const TIMESTAMP_RE = /^(\d{14})_.+\.sql$/;

/**
 * Compute SHA-256 of a file with CRLF -> LF normalization.
 *
 * Why: the same migration file is checked out with LF on Linux and
 * CRLF on Windows (when git's core.autocrlf=true and no .gitattributes
 * forces LF). Without normalization, the manifest would have to keep
 * two parallel hash sets, and a manifest generated on one platform
 * would block the other. By normalizing to LF before hashing, the
 * manifest is platform-independent.
 *
 * We read the file as a UTF-8 string (SQL migration files are text)
 * and replace \r\n with \n. This is safe even for files that already
 * have LF (the replace is a no-op) and handles mixed line endings.
 *
 * For non-text content this would be wrong, but the immutability gate
 * only tracks YYYYMMDDHHMMSS_*.sql files, which are always text.
 */
async function sha256OfFile(filePath) {
  const text = await readFile(filePath, "utf8");
  const normalized = text.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Parse the manifest file. Each non-comment, non-empty line is:
 *   <sha256>  <filename>
 * Lines starting with '#' are comments. Lines starting with '--'
 * are SQL-style comments (also skipped).
 *
 * Validates:
 *   - No duplicate filenames.
 *   - No duplicate hash lines.
 *   - Every filename matches the migration timestamp pattern.
 *   - Timestamps are strictly increasing in manifest order.
 */
function parseManifest(text) {
  const entries = [];
  const seenFilenames = new Map();
  const seenHashes = new Map();
  let lastTimestamp = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("--")) continue;

    const match = /^([0-9a-fA-F]{64})\s+(\S.+)$/.exec(line);
    if (!match) {
      throw new Error(
        `manifest parse error on line ${i + 1}: unrecognized format: ${rawLine}`,
      );
    }
    const sha256 = match[1].toLowerCase();
    const filename = match[2].trim();

    if (seenFilenames.has(filename)) {
      throw new Error(
        `manifest parse error: duplicate filename '${filename}' ` +
          `(first seen on line ${seenFilenames.get(filename)})`,
      );
    }
    if (seenHashes.has(sha256)) {
      throw new Error(
        `manifest parse error: duplicate hash '${sha256}' ` +
          `for '${filename}' (first seen for '${seenHashes.get(sha256)}')`,
      );
    }
    seenFilenames.set(filename, i + 1);
    seenHashes.set(sha256, filename);

    const tsMatch = TIMESTAMP_RE.exec(filename);
    if (!tsMatch) {
      throw new Error(
        `manifest parse error: filename '${filename}' does not match ` +
          `the migration pattern YYYYMMDDHHMMSS_<name>.sql`,
      );
    }
    const ts = Number.parseInt(tsMatch[1], 10);
    if (ts <= lastTimestamp) {
      throw new Error(
        `manifest parse error: timestamp for '${filename}' (${tsMatch[1]}) ` +
          `is not strictly later than the previous entry. ` +
          `Migrations must be strictly monotonic by filename timestamp.`,
      );
    }
    lastTimestamp = ts;

    entries.push({ sha256, filename, timestamp: ts });
  }
  return entries;
}

/**
 * List on-disk migration files (only YYYYMMDDHHMMSS_*.sql).
 * Excludes non-versioned files like cms_upgrade.sql.
 */
async function listDiskMigrations() {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter((f) => TIMESTAMP_RE.test(f))
    .sort()
    .map((filename) => {
      const ts = Number.parseInt(TIMESTAMP_RE.exec(filename)[1], 10);
      return { filename, timestamp: ts };
    });
}

/**
 * Verify that every manifest entry exists on disk and hash-matches.
 * Does NOT check for unregistered on-disk files (that's a separate
 * concern for the strict verify mode, not for --append-new).
 *
 * Returns an array of error strings (empty if all good).
 */
async function verifyRegisteredHashes(entries) {
  const errors = [];
  for (const entry of entries) {
    const fullPath = join(MIGRATIONS_DIR, entry.filename);
    let actualHash;
    try {
      actualHash = await sha256OfFile(fullPath);
    } catch (err) {
      if (err.code === "ENOENT") {
        errors.push(
          `BLOCK: manifest references '${entry.filename}' but the file ` +
            `no longer exists. Frozen migrations must not be deleted.`,
        );
        continue;
      }
      throw err;
    }
    if (actualHash !== entry.sha256) {
      errors.push(
        `BLOCK: migration '${entry.filename}' has been modified.` +
          `\n  manifest sha256: ${entry.sha256}` +
          `\n  current  sha256: ${actualHash}` +
          `\n  Frozen migrations must not be edited. Add a NEW migration ` +
          `with a strictly later timestamp and run ` +
          `'node scripts/check-migration-immutability.mjs --append-new'.`,
      );
    }
  }
  return errors;
}

/**
 * Find on-disk migration files that are not in the manifest.
 */
async function findUnregistered(entries) {
  const manifestFilenames = new Set(entries.map((e) => e.filename));
  const disk = await listDiskMigrations();
  return disk.filter((d) => !manifestFilenames.has(d.filename));
}

/**
 * Strict verification: every manifest entry must match the on-disk
 * file, and every on-disk migration must be registered.
 *
 * Returns an object with `errors` (array of strings) and `unregistered`
 * (array of {filename, timestamp} for on-disk files not in the manifest).
 */
async function verifyStrict(entries) {
  const errors = await verifyRegisteredHashes(entries);
  const unregistered = await findUnregistered(entries);
  for (const u of unregistered) {
    errors.push(
      `BLOCK: migration '${u.filename}' exists on disk but is not in ` +
        `the manifest. Run ` +
        `'node scripts/check-migration-immutability.mjs --append-new' ` +
        `to register it in the same PR.`,
    );
  }
  return { errors, unregistered };
}

/**
 * Read the existing manifest, throwing a BLOCK if it is missing.
 */
async function readManifestOrBlock() {
  let manifestText;
  try {
    manifestText = await readFile(MANIFEST_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(
        `BLOCK: manifest not found at ${MANIFEST_PATH}. ` +
          `If this is the first time the gate is being introduced, ` +
          `run 'node scripts/check-migration-immutability.mjs --initialize' ` +
          `once to bootstrap it.`,
      );
      process.exit(1);
    }
    throw err;
  }
  return manifestText;
}

async function modeInitialize() {
  // Refuse if a manifest already exists.
  try {
    await stat(MANIFEST_PATH);
    console.error(
      `BLOCK: manifest already exists at ${MANIFEST_PATH}. ` +
        `--initialize is a one-time bootstrap and may not be used when a ` +
        `manifest is present. Use --append-new to register new migrations.`,
    );
    process.exit(1);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const disk = await listDiskMigrations();
  if (disk.length === 0) {
    console.error("BLOCK: no migration files found to initialize the manifest.");
    process.exit(1);
  }

  const lines = [
    "# Migration SHA-256 Manifest",
    "#",
    "# Records the SHA-256 of every migration file under supabase/migrations/",
    "# at the time of the first green HEAD after the pre-merge migration",
    "# correction exception window closed.",
    "#",
    "# Subsequent PRs MUST NOT modify a migration that already appears here.",
    "# New fixes must be added as a NEW migration with a strictly later",
    "# timestamp, and this manifest must be updated in the SAME PR via:",
    "#   node scripts/check-migration-immutability.mjs --append-new",
    "#",
    "# Regenerate from scratch (ONE-TIME ONLY, requires manifest deletion):",
    "#   node scripts/check-migration-immutability.mjs --initialize",
    "",
  ];
  for (const { filename } of disk) {
    const fullPath = join(MIGRATIONS_DIR, filename);
    const hash = await sha256OfFile(fullPath);
    lines.push(`${hash}  ${filename}`);
  }
  const text = lines.join("\n") + "\n";
  await writeFile(MANIFEST_PATH, text, "utf8");
  console.log(
    `manifest initialized: ${MANIFEST_PATH} (${disk.length} entries)`,
  );
}

async function modeAppendNew() {
  const manifestText = await readManifestOrBlock();
  let entries;
  try {
    entries = parseManifest(manifestText);
  } catch (err) {
    console.error(`BLOCK: ${err.message}`);
    process.exit(1);
  }
  if (entries.length === 0) {
    console.error("BLOCK: manifest is empty.");
    process.exit(1);
  }

  // 1. Strict verification of every already-registered hash. ANY
  //    mismatch blocks the append — we never rewrite existing lines.
  //    Note: we do NOT call verifyStrict here because that would also
  //    flag unregistered files (which is exactly what --append-new is
  //    trying to fix). We only verify that already-registered hashes
  //    still match.
  const hashErrors = await verifyRegisteredHashes(entries);
  if (hashErrors.length > 0) {
    for (const e of hashErrors) console.error(e);
    console.error(
      `\nBLOCK: --append-new refused: ${hashErrors.length} issue(s) above ` +
        `must be resolved first. Existing hash lines are never rewritten.`,
    );
    process.exit(1);
  }

  // 2. Identify unregistered on-disk files.
  const newFiles = await findUnregistered(entries);
  if (newFiles.length === 0) {
    console.log(
      "PASS: no new migrations to append. Manifest is up to date " +
        `(${entries.length} entries).`,
    );
    return;
  }

  // 3. New file timestamps must be strictly later than the last
  //    versioned migration already in the manifest.
  const lastEntry = entries[entries.length - 1];
  const lastTs = lastEntry.timestamp;
  const tooOld = newFiles.filter((f) => f.timestamp <= lastTs);
  if (tooOld.length > 0) {
    for (const f of tooOld) {
      console.error(
        `BLOCK: new migration '${f.filename}' has timestamp ` +
          `${String(f.timestamp)} which is not strictly later than the ` +
          `last manifest entry '${lastEntry.filename}' (${String(lastTs)}). ` +
          `New migrations must use a strictly later timestamp.`,
      );
    }
    process.exit(1);
  }

  // 4. Append-only: never touch existing lines.
  const appendedLines = [];
  const hashes = [];
  for (const { filename } of newFiles) {
    const fullPath = join(MIGRATIONS_DIR, filename);
    const hash = await sha256OfFile(fullPath);
    appendedLines.push(`${hash}  ${filename}`);
    hashes.push({ filename, hash });
  }

  // Append to the existing manifest text, preserving the original
  // content byte-for-byte (including comments and trailing newline).
  const separator = manifestText.endsWith("\n") ? "" : "\n";
  const newText = manifestText + separator + appendedLines.join("\n") + "\n";
  await writeFile(MANIFEST_PATH, newText, "utf8");

  console.log(
    `appended ${newFiles.length} new migration(s) to manifest:`,
  );
  for (const { filename, hash } of hashes) {
    console.log(`  + ${filename}  (${hash.slice(0, 12)}…)`);
  }
}

async function modeVerify() {
  const manifestText = await readManifestOrBlock();
  let entries;
  try {
    entries = parseManifest(manifestText);
  } catch (err) {
    console.error(`BLOCK: ${err.message}`);
    process.exit(1);
  }
  if (entries.length === 0) {
    console.error("BLOCK: manifest is empty.");
    process.exit(1);
  }

  const { errors } = await verifyStrict(entries);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(
      `\nBLOCK: ${errors.length} immutability violation(s) detected.`,
    );
    process.exit(1);
  }

  console.log(
    `PASS: ${entries.length} frozen migration(s) verified. ` +
      `No unregistered migrations on disk.`,
  );
}

async function main() {
  if (MODE_INITIALIZE) {
    await modeInitialize();
    return;
  }
  if (MODE_APPEND_NEW) {
    await modeAppendNew();
    return;
  }
  await modeVerify();
}

main().catch((err) => {
  console.error("check-migration-immutability failed:", err);
  process.exit(1);
});
