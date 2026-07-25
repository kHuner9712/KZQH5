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
//   --verify-against-ref=<git-ref>
//                     Anchors the manifest to a historical commit.
//                     Reads the manifest at <git-ref> via
//                     `git show <ref>:docs/MIGRATION_SHA256_MANIFEST.txt`,
//                     then verifies that EVERY migration registered
//                     at that ref is still present at HEAD with the
//                     SAME hash, both on disk and in the HEAD
//                     manifest. New migrations added since the ref
//                     must be appended with strictly later timestamps.
//                     This mode is the trust baseline: a malicious PR
//                     that rewrites the entire manifest + all
//                     migrations together would pass the default
//                     self-consistency check, but FAIL this mode
//                     because the historical baseline disagrees.
//                     Requires a full clone (CI must use fetch-depth: 0).
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
import { execFileSync } from "node:child_process";
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
const MODE_VERIFY_AGAINST_REF_ARG = argv.find((a) =>
  a.startsWith("--verify-against-ref="),
);
const MODE_VERIFY_AGAINST_REF = MODE_VERIFY_AGAINST_REF_ARG
  ? MODE_VERIFY_AGAINST_REF_ARG.slice("--verify-against-ref=".length)
  : null;

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

// --verify-against-ref is mutually exclusive with all write modes.
// It is a read-only trust baseline check.
const ACTIVE_WRITE_MODES = [
  MODE_APPEND_NEW && "--append-new",
  MODE_INITIALIZE && "--initialize",
].filter(Boolean);
if (MODE_VERIFY_AGAINST_REF && ACTIVE_WRITE_MODES.length > 0) {
  console.error(
    "BLOCK: --verify-against-ref is mutually exclusive with write modes " +
      `(${ACTIVE_WRITE_MODES.join(", ")}).`,
  );
  process.exit(1);
}

if (MODE_VERIFY_AGAINST_REF === "") {
  console.error(
    "BLOCK: --verify-against-ref requires a non-empty git ref, " +
      "e.g. --verify-against-ref=origin/main",
  );
  process.exit(1);
}

// CI safety: --initialize rewrites the entire manifest from scratch,
// defeating the immutability gate. It is a one-time local bootstrap
// tool only. In CI the manifest MUST already exist and be appended-to
// via --append-new. Refuse --initialize outright when the
// CI_DISALLOW_INITIALIZE env var is set (the CI workflow sets it).
if (MODE_INITIALIZE && process.env.CI_DISALLOW_INITIALIZE === "true") {
  console.error(
    "BLOCK: --initialize is not allowed in CI (CI_DISALLOW_INITIALIZE=true). " +
      "--initialize rewrites the entire manifest from scratch, which " +
      "defeats the immutability gate. Run --initialize locally once to " +
      "bootstrap, then use --append-new to register new migrations.",
  );
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

/**
 * Run a git command and return its stdout as a string.
 *
 * Used by --verify-against-ref to read historical manifest and
 * migration content from a git ref. We use execFileSync (not spawn)
 * because we want the full stdout in memory and we want a clean
 * non-zero exit on failure.
 *
 * The git command runs in the project ROOT directory. We deliberately
 * do NOT pass a shell — execFileSync with an arg array is shell-less
 * and safe against argument injection.
 */
function gitShow(ref, relPath) {
  try {
    const stdout = execFileSync(
      "git",
      ["show", `${ref}:${relPath}`],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return stdout;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : "";
    const msg = stderr || err.message;
    const e = new Error(`git show ${ref}:${relPath} failed: ${msg}`);
    e.code = err.status === 128 ? "GIT_MISSING_OBJECT" : "GIT_ERROR";
    throw e;
  }
}

/**
 * --verify-against-ref=<git-ref>
 *
 * Trust baseline check. Reads the manifest at <git-ref> via
 * `git show <ref>:docs/MIGRATION_SHA256_MANIFEST.txt`, then verifies:
 *
 *   1. Every migration registered at <ref> is STILL registered at
 *      HEAD with the SAME sha256. (No silent manifest rewrite.)
 *
 *   2. Every migration file on disk at <ref> still exists at HEAD
 *      with the SAME sha256. (No silent file edit.)
 *
 *   3. New migrations added since <ref> have strictly later
 *      timestamps than the last <ref> migration, AND their on-disk
 *      hash matches the HEAD manifest entry. (No backdating, no
 *      hash mismatch.)
 *
 * This mode is the trust baseline. The default modeVerify() only
 * checks that the HEAD manifest is self-consistent with the HEAD
 * on-disk files — a malicious PR that rewrites BOTH the manifest
 * and all migration files in the same commit would pass. This mode
 * anchors to history, so such a rewrite is detected because the
 * historical baseline disagrees.
 *
 * Requires a full clone (CI must use fetch-depth: 0). A shallow
 * clone does not contain the ref and git show will fail with
 * "bad object".
 */
async function modeVerifyAgainstRef(ref) {
  // 1. Read HEAD manifest.
  const headManifestText = await readManifestOrBlock();
  let headEntries;
  try {
    headEntries = parseManifest(headManifestText);
  } catch (err) {
    console.error(`BLOCK: HEAD manifest parse error: ${err.message}`);
    process.exit(1);
  }
  if (headEntries.length === 0) {
    console.error("BLOCK: HEAD manifest is empty.");
    process.exit(1);
  }
  const headByFilename = new Map(headEntries.map((e) => [e.filename, e]));

  // 2. Read ref manifest (historical baseline).
  let refManifestText;
  try {
    refManifestText = gitShow(ref, "docs/MIGRATION_SHA256_MANIFEST.txt");
  } catch (err) {
    if (err.code === "GIT_MISSING_OBJECT") {
      console.error(
        `BLOCK: docs/MIGRATION_SHA256_MANIFEST.txt does not exist at ` +
          `ref '${ref}'. The trust baseline requires that this ref ` +
          `already contains a manifest. Either pick a later ref, or ` +
          `bootstrap the manifest first via --initialize and commit it.`,
      );
      process.exit(1);
    }
    console.error(
      `BLOCK: could not read manifest at ref '${ref}': ${err.message}`,
    );
    console.error(
      `       This usually means the clone is shallow (CI needs ` +
        `fetch-depth: 0) or the ref does not exist locally.`,
    );
    process.exit(1);
  }
  let refEntries;
  try {
    refEntries = parseManifest(refManifestText);
  } catch (err) {
    console.error(
      `BLOCK: manifest at ref '${ref}' is malformed: ${err.message}`,
    );
    process.exit(1);
  }
  if (refEntries.length === 0) {
    console.error(`BLOCK: manifest at ref '${ref}' is empty.`);
    process.exit(1);
  }

  const errors = [];

  // 3. Every ref manifest entry must be present at HEAD with the
  //    SAME sha256, both in the manifest and on disk.
  for (const refEntry of refEntries) {
    const headEntry = headByFilename.get(refEntry.filename);
    if (!headEntry) {
      errors.push(
        `BLOCK: migration '${refEntry.filename}' was registered at ` +
          `ref '${ref}' but is MISSING from the HEAD manifest. ` +
          `Frozen migrations must not be unregistered.`,
      );
      continue;
    }
    if (headEntry.sha256 !== refEntry.sha256) {
      errors.push(
        `BLOCK: manifest hash for '${refEntry.filename}' changed ` +
          `between ref '${ref}' and HEAD.`,
      );
      errors.push(`  ref  sha256: ${refEntry.sha256}`);
      errors.push(`  head sha256: ${headEntry.sha256}`);
      errors.push(
        `  Frozen migration hashes must not change. If the migration ` +
          `file itself is unchanged, the manifest must not be edited.`,
      );
    }

    // Verify the on-disk file still hash-matches the ref baseline.
    const fullPath = join(MIGRATIONS_DIR, refEntry.filename);
    let actualHash;
    try {
      actualHash = await sha256OfFile(fullPath);
    } catch (err) {
      if (err.code === "ENOENT") {
        errors.push(
          `BLOCK: migration '${refEntry.filename}' existed at ref ` +
            `'${ref}' but is MISSING from disk. Frozen migrations ` +
            `must not be deleted.`,
        );
        continue;
      }
      throw err;
    }
    if (actualHash !== refEntry.sha256) {
      errors.push(
        `BLOCK: migration '${refEntry.filename}' on disk has been ` +
          `modified since ref '${ref}'.`,
      );
      errors.push(`  ref     sha256: ${refEntry.sha256}`);
      errors.push(`  on-disk sha256: ${actualHash}`);
      errors.push(
        `  Frozen migrations must not be edited. Add a NEW migration ` +
          `with a strictly later timestamp.`,
      );
    }
  }

  // 4. New migrations at HEAD (not in ref) must have strictly later
  //    timestamps than the last ref migration, and their on-disk
  //    hash must match the HEAD manifest entry.
  const refFilenames = new Set(refEntries.map((e) => e.filename));
  const lastRefTs =
    refEntries.length > 0
      ? refEntries[refEntries.length - 1].timestamp
      : 0;
  const newAtHead = headEntries.filter((e) => !refFilenames.has(e.filename));
  for (const newEntry of newAtHead) {
    if (newEntry.timestamp <= lastRefTs) {
      errors.push(
        `BLOCK: new migration '${newEntry.filename}' has timestamp ` +
          `${newEntry.timestamp} which is not strictly later than ` +
          `the last ref migration timestamp ${lastRefTs}. ` +
          `New migrations must use a strictly later timestamp.`,
      );
    }
    const fullPath = join(MIGRATIONS_DIR, newEntry.filename);
    let actualHash;
    try {
      actualHash = await sha256OfFile(fullPath);
    } catch (err) {
      if (err.code === "ENOENT") {
        errors.push(
          `BLOCK: migration '${newEntry.filename}' is in the HEAD ` +
            `manifest but MISSING from disk.`,
        );
        continue;
      }
      throw err;
    }
    if (actualHash !== newEntry.sha256) {
      errors.push(
        `BLOCK: new migration '${newEntry.filename}' on-disk hash ` +
          `does not match HEAD manifest entry.`,
      );
      errors.push(`  manifest sha256: ${newEntry.sha256}`);
      errors.push(`  on-disk sha256:   ${actualHash}`);
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(
      `\nBLOCK: ${errors.length} immutability violation(s) detected ` +
        `against ref '${ref}'.`,
    );
    process.exit(1);
  }

  console.log(
    `PASS: ${refEntries.length} migration(s) verified unchanged ` +
      `against ref '${ref}'.`,
  );
  console.log(
    `      ${newAtHead.length} new migration(s) correctly appended ` +
      `since ref.`,
  );
  console.log(`      HEAD manifest total: ${headEntries.length} entries.`);
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
  if (MODE_VERIFY_AGAINST_REF) {
    await modeVerifyAgainstRef(MODE_VERIFY_AGAINST_REF);
    return;
  }
  await modeVerify();
}

main().catch((err) => {
  console.error("check-migration-immutability failed:", err);
  process.exit(1);
});
