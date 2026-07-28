// ============================================================
// Middleware Edge Runtime Compatibility Checker
// ------------------------------------------------------------
// Scans the Next.js build output for Edge Runtime warnings that
// indicate a Node.js-only API was bundled into the middleware.
//
// The check looks for warning patterns like:
//   - "uses process.version"
//   - "not supported in the Edge Runtime"
//   - "A Node.js module is loaded"
//   - "which is not supported in the Edge Runtime"
//
// If any of these patterns are found, the script exits with code 1
// (CI failure), UNLESS the middleware has been explicitly switched to
// Node.js runtime AND the runtime has been verified against EdgeOne
// Staging. Currently the middleware uses Edge Runtime (the EdgeOne
// default), so ANY Edge Runtime warning is a CI failure.
//
// Usage:
//   node scripts/check-middleware-edge-runtime.mjs <build-log-file>
//   npm run build 2>&1 | node scripts/check-middleware-edge-runtime.mjs
//
// Exit codes:
//   0 — no Edge Runtime warnings found
//   1 — Edge Runtime warnings detected (middleware bundle incompatible)
//   2 — could not read input (file missing or stdin empty)
// ============================================================

import { readFileSync, existsSync } from "node:fs";

// Warning patterns that indicate a Node.js-only API was bundled
// into the middleware. Each pattern is a regex that is matched
// case-insensitively against each line of the build log.
const EDGE_RUNTIME_WARNING_PATTERNS = [
  /uses\s+process\.version/i,
  /not\s+supported\s+in\s+(?:the\s+)?Edge\s+Runtime/i,
  /A\s+Node\.js\s+module\s+is\s+loaded/i,
  /which\s+is\s+unsupported\s+in\s+Edge\s+Runtime/i,
  /process\.version.*unsupported/i,
  /Node\.js\s+API.*not\s+supported\s+in\s+(?:the\s+)?Edge/i,
];

function checkLog(logContent) {
  const lines = logContent.split("\n");
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of EDGE_RUNTIME_WARNING_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          line: i + 1,
          content: line.trim(),
          pattern: pattern.source,
        });
      }
    }
  }

  return violations;
}

function main() {
  const arg = process.argv[2];

  let logContent = "";

  if (arg) {
    // Read from file
    if (!existsSync(arg)) {
      console.error(`ERROR: build log file not found: ${arg}`);
      process.exit(2);
    }
    logContent = readFileSync(arg, "utf-8");
  } else if (!process.stdin.isTTY) {
    // Read from stdin (piped input)
    try {
      logContent = readFileSync(0, "utf-8");
    } catch {
      console.error("ERROR: could not read from stdin");
      process.exit(2);
    }
  } else {
    console.error("Usage: node scripts/check-middleware-edge-runtime.mjs <build-log-file>");
    console.error("       npm run build 2>&1 | node scripts/check-middleware-edge-runtime.mjs");
    process.exit(2);
  }

  if (!logContent.trim()) {
    console.error("ERROR: build log is empty");
    process.exit(2);
  }

  const violations = checkLog(logContent);

  if (violations.length === 0) {
    console.log("PASS: no Edge Runtime warnings detected in build output.");
    console.log("      Middleware bundle is Edge Runtime compatible.");
    process.exit(0);
  }

  console.error("FAIL: Edge Runtime warnings detected in build output.");
  console.error("      The middleware bundle contains Node.js-only APIs.");
  console.error("");
  console.error(`      ${violations.length} violation(s) found:`);
  for (const v of violations) {
    console.error(`        Line ${v.line}: ${v.content}`);
    console.error(`        Pattern: /${v.pattern}/`);
  }
  console.error("");
  console.error("      The middleware must NOT depend on @supabase/ssr or");
  console.error("      @supabase/supabase-js (which use process.version).");
  console.error("      Use lib/supabase/middleware-session.ts which uses");
  console.error("      only Web APIs (fetch, Headers, TextEncoder, atob).");
  process.exit(1);
}

main();
