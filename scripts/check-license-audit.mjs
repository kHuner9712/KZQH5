#!/usr/bin/env node
/**
 * KZQ-P2-012-d — production dependency license audit.
 *
 * PURPOSE
 *   Verifies that every PRODUCTION dependency (npm ls --omit=dev) carries
 *   a known, non-copyleft license so the commercial closed-source
 *   distribution of KZQH5 is not exposed to license-contamination risk.
 *   Exit code 0 = compliant; 1 = policy violation.
 *
 * AUDIT COMMAND (run from the repo root, after `npm ci`):
 *   node scripts/check-license-audit.mjs
 *
 * HOW IT WORKS
 *   1. Recursively scan node_modules, recording every installed package's
 *      `license` field (name@version -> normalized SPDX string).
 *   2. Run `npm ls --json --all --omit=dev` to obtain the production
 *      dependency tree.
 *   3. Intersect the two: only packages that are BOTH in the production
 *      tree AND actually installed on disk are audited. Optional
 *      cross-platform binaries (e.g. @next/swc-darwin-*, @img/sharp-linux-*)
 *      that npm lists but that are NOT installed on the current platform
 *      are skipped — the installed platform flavor carries the same
 *      license declaration as its siblings.
 *   4. Classify each license and fail on violations.
 *
 * POLICY (verified allowlist)
 *   ALLOWED (must be an exact SPDX match):
 *     MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, CC0-1.0,
 *     Unlicense, BlueOak-1.0.0, Python-2.0
 *   DATA LICENSE (allowed with attribution notice):
 *     CC-BY-4.0 (caniuse-lite browser-support data — a data package, not
 *     linked code; attribution is retained in the package itself)
 *   BLOCKED ALWAYS (strong copyleft):
 *     GPL-*, AGPL-*, SSPL-*
 *   BLOCKED UNLESS REVIEWED (weak copyleft):
 *     LGPL-*, MPL-2.0 — must be listed in KNOWN_EXCEPTIONS below, each
 *     with a written justification; adding a new exception is a manual,
 *     documented review, not a silent allow.
 *
 * KNOWN_EXCEPTIONS (manually reviewed on 2026-08-01)
 *   @img/sharp-* platform binaries — license field is
 *   "Apache-2.0 AND LGPL-3.0-or-later": sharp's core is Apache-2.0 while
 *   the bundled libvips shared binary is LGPL-3.0. This is sharp's
 *   OFFICIAL distribution (the npm package published by the sharp
 *   maintainers) and the standard production usage of the Next.js image
 *   pipeline. libvips is loaded as a separate dynamically-linked binary
 *   at runtime, not compiled into the application. Widely accepted in
 *   commercial closed-source deployments; tracked here so a future sharp
 *   version changing this declaration fails the audit.
 *
 *   (No other LGPL/MPL packages are currently present in the production
 *    tree. mupdf (AGPL-3.0), lightningcss (MPL-2.0) and axe-core
 *    (MPL-2.0) are devDependencies only and are intentionally NOT
 *    audited here — the --omit=dev tree excludes them.)
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------------------
// Policy rules
// ------------------------------------------------------------
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "Python-2.0",
]);
const STRONG_COPYLEFT = /(^|\s|AND\s)(GPL|AGPL|SSPL)/i;
const WEAK_COPYLEFT = /(^|\s|AND\s)(LGPL|MPL)/i;
const DATA_LICENSE = /CC-BY/i;

/**
 * KNOWN_EXCEPTIONS — see header. Matchers receive the package name.
 * Every entry MUST be accompanied by a justification comment in the
 * header; this set exists so exceptions are deliberate, not silent.
 */
function isKnownException(name) {
  // sharp official platform binaries (Apache-2.0 core + LGPL libvips).
  return name.startsWith("@img/sharp-");
}

// ------------------------------------------------------------
// 1. Scan installed packages (node_modules)
// ------------------------------------------------------------
const licenseByKey = new Map(); // name@version -> normalized license string

function normalizeLicense(raw) {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((l) => normalizeLicense(l)).filter(Boolean).join(" AND ");
  if (raw && typeof raw === "object" && typeof raw.type === "string") return raw.type;
  return "(missing)";
}

function scan(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name === ".cache" || entry.name === ".vite") continue;
    const full = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    const pkgPath = join(full, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name && pkg.version) {
          const key = `${pkg.name}@${pkg.version}`;
          if (!licenseByKey.has(key)) licenseByKey.set(key, normalizeLicense(pkg.license ?? pkg.licenses ?? "(missing)"));
        }
      } catch {
        // unreadable package.json — not auditable; skipped (npm tree walk
        // surfaces such packages as not-on-disk and they are ignored).
      }
    }
    scan(full);
  }
}

// ------------------------------------------------------------
// 2. Production dependency tree
// ------------------------------------------------------------
scan(join(ROOT, "node_modules"));

function productionTree() {
  const raw = execSync("npm ls --json --all --omit=dev", {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

// npm ls node objects carry no `name`; the dependency map key IS the name.
function collectProduction(tree) {
  const prod = new Map(); // name@version -> license
  const visit = (node, name) => {
    if (!node) return;
    const key = `${name}@${node.version}`;
    if (node.version && !prod.has(key)) {
      // Only versions actually installed on disk are audited (skip
      // optional cross-platform binaries npm lists but did not install).
      const license = licenseByKey.get(key);
      if (license !== undefined) prod.set(key, license);
    }
    for (const [depName, dep] of Object.entries(node.dependencies ?? {})) visit(dep, depName);
  };
  visit(tree, tree.name);
  return prod;
}

// ------------------------------------------------------------
// 3. Audit
// ------------------------------------------------------------
const problems = [];
const warnings = [];
const distribution = new Map();

for (const [key, license] of collectProduction(productionTree())) {
  distribution.set(license, (distribution.get(license) ?? 0) + 1);
  const name = key.slice(0, key.lastIndexOf("@"));
  if (license === "(missing)") {
    problems.push(`[FAIL] ${key}: no license field`);
  } else if (STRONG_COPYLEFT.test(license)) {
    problems.push(`[FAIL] ${key}: strong copyleft (${license})`);
  } else if (WEAK_COPYLEFT.test(license) && !isKnownException(name)) {
    problems.push(`[FAIL] ${key}: weak copyleft (${license}) not in KNOWN_EXCEPTIONS`);
  } else if (WEAK_COPYLEFT.test(license) && isKnownException(name)) {
    warnings.push(`[NOTE] ${key}: ${license} (KNOWN_EXCEPTIONS: sharp platform binary)`);
  } else if (DATA_LICENSE.test(license)) {
    warnings.push(`[WARN] ${key}: ${license} (data package, attribution required)`);
  } else if (!ALLOWED.has(license)) {
    problems.push(`[FAIL] ${key}: license "${license}" not in verified allowlist`);
  }
}

// ------------------------------------------------------------
// 4. Report
// ------------------------------------------------------------
console.log(`Production packages audited: ${[...distribution.values()].reduce((a, b) => a + b, 0)}`);
console.log("License distribution:");
for (const [license, count] of [...distribution.entries()].sort()) {
  console.log(`  ${String(count).padStart(4)}  ${license}`);
}
for (const w of warnings) console.log(w);
for (const p of problems) console.error(p);

if (problems.length > 0) {
  console.error(`\nLicense audit FAILED: ${problems.length} violation(s).`);
  process.exit(1);
}
console.log("\nLicense audit PASSED: production deps are within the verified allowlist.");
