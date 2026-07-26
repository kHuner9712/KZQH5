#!/usr/bin/env node
// ============================================================
// Storage Audit Reconciliation — controlled operations entrypoint.
//
// This script invokes the canonical Storage Audit Reconciliation
// HTTP route (POST /api/internal/storage/audit-reconcile) which
// drives the reconciliation of long-pending rows in
// `admin_storage_operations`. It does NOT contain its own reconcile
// state machine — the route is the single source of truth for:
//   - claim_storage_audit_reconcile (FOR UPDATE SKIP LOCKED +
//     per-row lock_token + stale recovery)
//   - Storage .list() via service_role (full parent directory,
//     exact filename match)
//   - complete_storage_audit_reconcile (token-verified finalize)
//
// AUTHENTICATION
//   The route is authenticated with a static bearer secret
//   (STORAGE_MAINTENANCE_SECRET). This secret MUST be distinct
//   from OUTBOX_DISPATCH_SECRET and SHOULD be distinct from
//   STORAGE_CLEANUP_DISPATCH_SECRET (a separate maintenance secret
//   is allowed so operators can rotate audit-reconcile access
//   without rotating cleanup access). The script reads the secret
//   from the environment and never logs it. The secret must be at
//   least 16 characters; the route returns 503 if it is missing
//   or too short.
//
// URL RESTRICTION (mirrors Section 9 lock pattern)
//   The target URL is read from the STORAGE_AUDIT_RECONCILE_URL
//   environment variable, NOT from a CLI flag. This prevents an
//   operator from accidentally pointing the script at an arbitrary
//   HTTPS host and leaking the bearer secret.
//
//   STORAGE_AUDIT_RECONCILE_URL must satisfy ALL of:
//     - protocol = https (http only for loopback dev)
//     - host is one of:
//         * loopback: localhost | 127.0.0.1 | [::1]
//         * present in STORAGE_AUDIT_RECONCILE_ALLOWED_HOSTS
//           (comma-separated)
//     - pathname === "/api/internal/storage/audit-reconcile"
//       (exact match)
//     - no username / password
//     - no port (except loopback, where any port is allowed)
//     - no query string
//     - no hash
//
//   fetch() is called with `redirect: "error"` so an attacker cannot
//   trick the route into forwarding the secret to a different host.
//
// USAGE
//   STORAGE_MAINTENANCE_SECRET=<secret> \
//   STORAGE_AUDIT_RECONCILE_URL=https://staging.example.com/api/internal/storage/audit-reconcile \
//   [STORAGE_AUDIT_RECONCILE_ALLOWED_HOSTS=staging.example.com] \
//     node scripts/dispatch-storage-audit-reconcile.mjs \
//       [--min-age-seconds 300] [--limit 50] [--stale-timeout-seconds 300]
//
//   Local development (loopback is always allowed):
//     STORAGE_MAINTENANCE_SECRET=dev-maintenance-secret-1234567890 \
//     STORAGE_AUDIT_RECONCILE_URL=http://127.0.0.1:3000/api/internal/storage/audit-reconcile \
//       node scripts/dispatch-storage-audit-reconcile.mjs
//
// EXIT CODES
//   0 — reconciler ran successfully (may include 0 rows processed)
//   1 — invalid arguments (missing/invalid URL, missing secret)
//   2 — HTTP / network error contacting the route
//   3 — route returned non-200 (auth failure, server error, timeout)
//
// SAFETY
//   - This script NEVER calls Supabase directly.
//   - It NEVER finalizes audit rows directly.
//   - It logs ONLY coarse-grained counters from the route response,
//     never object paths, bucket names, operation ids, or internal
//     error codes.
//   - It NEVER logs the raw response body — only fixed coarse codes
//     extracted via regex. An unexpected JSON body is not echoed.
//   - It does not retry — operators should re-invoke the script or
//     configure a platform cron that calls the route directly.
// ============================================================

const DEFAULT_MIN_AGE_SECONDS = 300;
const DEFAULT_LIMIT = 50;
const DEFAULT_STALE_TIMEOUT_SECONDS = 300;
const MAX_MIN_AGE_SECONDS = 86_400;
const MAX_LIMIT = 200;
const MAX_STALE_TIMEOUT_SECONDS = 86_400;
const REQUEST_TIMEOUT_MS = 120_000;
const REQUIRED_PATHNAME = "/api/internal/storage/audit-reconcile";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseArgs(argv) {
  const args = {
    minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
    limit: DEFAULT_LIMIT,
    staleTimeoutSeconds: DEFAULT_STALE_TIMEOUT_SECONDS,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--min-age-seconds") {
      const raw = Number.parseInt(argv[++i] || "", 10);
      if (Number.isFinite(raw) && raw >= 60) {
        args.minAgeSeconds = Math.min(raw, MAX_MIN_AGE_SECONDS);
      }
    } else if (arg === "--limit") {
      const raw = Number.parseInt(argv[++i] || "", 10);
      if (Number.isFinite(raw) && raw >= 1) {
        args.limit = Math.min(raw, MAX_LIMIT);
      }
    } else if (arg === "--stale-timeout-seconds") {
      const raw = Number.parseInt(argv[++i] || "", 10);
      if (Number.isFinite(raw) && raw >= 60) {
        args.staleTimeoutSeconds = Math.min(raw, MAX_STALE_TIMEOUT_SECONDS);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: STORAGE_AUDIT_RECONCILE_URL=<url> STORAGE_MAINTENANCE_SECRET=<secret> \\
       node scripts/dispatch-storage-audit-reconcile.mjs [options]

Options:
  --min-age-seconds <n>        Min pending age 60..${MAX_MIN_AGE_SECONDS} (default: ${DEFAULT_MIN_AGE_SECONDS})
  --limit <n>                  Batch size 1..${MAX_LIMIT} (default: ${DEFAULT_LIMIT})
  --stale-timeout-seconds <n>  Stale-lock recovery 60..${MAX_STALE_TIMEOUT_SECONDS} (default: ${DEFAULT_STALE_TIMEOUT_SECONDS})
  --help                       Show this help message

Required environment:
  STORAGE_AUDIT_RECONCILE_URL              Target URL (strict validated; see source)
  STORAGE_MAINTENANCE_SECRET               Bearer secret (>= 16 chars, MUST be
                                           distinct from OUTBOX_DISPATCH_SECRET)

Optional environment:
  STORAGE_AUDIT_RECONCILE_ALLOWED_HOSTS    Comma-separated allowlist of non-loopback hosts
`);
      process.exit(0);
    }
  }
  return args;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

/**
 * Validate the target URL against the contract.
 * Returns the validated URL object, or fails with exit code 1.
 *
 * Allowed:
 *   - https://<allowed-host>/api/internal/storage/audit-reconcile
 *   - http://<loopback>:<port>/api/internal/storage/audit-reconcile
 *
 * Rejected:
 *   - any URL with username/password (userinfo)
 *   - any URL with a query string or hash
 *   - any URL whose pathname is not exactly the required path
 *   - any non-loopback host with a port
 *   - any non-loopback host not in STORAGE_AUDIT_RECONCILE_ALLOWED_HOSTS
 *   - http:// for non-loopback hosts
 *   - protocols other than http/https
 */
function validateTargetUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(1, `ERROR: STORAGE_AUDIT_RECONCILE_URL is not a valid URL`);
  }

  // Protocol: only https (http only for loopback).
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail(1, `ERROR: STORAGE_AUDIT_RECONCILE_URL must use http(s) protocol`);
  }

  // No userinfo.
  if (url.username || url.password) {
    fail(1, `ERROR: STORAGE_AUDIT_RECONCILE_URL must not contain username/password`);
  }

  // No hash.
  if (url.hash) {
    fail(1, `ERROR: STORAGE_AUDIT_RECONCILE_URL must not contain a hash fragment`);
  }

  // No query string.
  if (url.search) {
    fail(1, `ERROR: STORAGE_AUDIT_RECONCILE_URL must not contain a query string`);
  }

  // Pathname must be exactly the required path.
  if (url.pathname !== REQUIRED_PATHNAME) {
    fail(
      1,
      `ERROR: STORAGE_AUDIT_RECONCILE_URL pathname must be exactly ${REQUIRED_PATHNAME} (got ${url.pathname})`,
    );
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (isLoopback) {
    // Loopback: http or https, any port allowed.
    if (url.protocol === "http:") {
      // Allow http on loopback for dev.
    } else if (url.protocol !== "https:") {
      fail(1, `ERROR: STORAGE_AUDIT_RECONCILE_URL must use http or https`);
    }
  } else {
    // Non-loopback: must be https, no port, host must be allowlisted.
    if (url.protocol !== "https:") {
      fail(
        1,
        `ERROR: STORAGE_AUDIT_RECONCILE_URL must use https for non-loopback hosts (got ${url.protocol})`,
      );
    }
    if (url.port) {
      fail(
        1,
        `ERROR: STORAGE_AUDIT_RECONCILE_URL must not specify a port for non-loopback hosts (got :${url.port})`,
      );
    }
    const allowedHosts = (process.env.STORAGE_AUDIT_RECONCILE_ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (!allowedHosts.includes(url.hostname)) {
      fail(
        1,
        `ERROR: host ${url.hostname} is not allowed. Add it to STORAGE_AUDIT_RECONCILE_ALLOWED_HOSTS or use a loopback address.`,
      );
    }
  }

  return url;
}

/**
 * Extract a fixed coarse error code from a non-JSON or error body.
 * NEVER returns the body itself — only a fixed code or "unknown".
 */
function extractErrorCode(body) {
  if (typeof body !== "string" || !body) return "unknown";
  const match = body.match(/"error"\s*:\s*"([^"]+)"/);
  return match ? match[1] : "unknown";
}

async function main() {
  const args = parseArgs(process.argv);

  // 1. Validate the target URL BEFORE reading the secret, so a bad URL
  //    cannot leak the secret to an unintended host.
  const rawUrl = process.env.STORAGE_AUDIT_RECONCILE_URL;
  if (!rawUrl) {
    fail(
      1,
      "ERROR: STORAGE_AUDIT_RECONCILE_URL environment variable is not set.",
    );
  }
  const url = validateTargetUrl(rawUrl);

  // 2. Read the secret.
  const secret = process.env.STORAGE_MAINTENANCE_SECRET;
  if (!secret) {
    fail(1, "ERROR: STORAGE_MAINTENANCE_SECRET environment variable is not set");
  }
  if (secret.length < 16) {
    fail(1, "ERROR: STORAGE_MAINTENANCE_SECRET must be at least 16 characters");
  }

  // 3. Defense in depth: warn if the maintenance secret equals the
  //    outbox secret — operators should keep the two concerns separated.
  const outboxSecret = process.env.OUTBOX_DISPATCH_SECRET;
  if (outboxSecret && outboxSecret === secret) {
    fail(
      1,
      "ERROR: STORAGE_MAINTENANCE_SECRET must be distinct from OUTBOX_DISPATCH_SECRET. The maintenance and notification concerns must not share credentials.",
    );
  }

  // 4. Call the route with redirect: "error" so no 3xx can forward
  //    the bearer secret to a different host.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        minAgeSeconds: args.minAgeSeconds,
        limit: args.limit,
        staleTimeoutSeconds: args.staleTimeoutSeconds,
      }),
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.name : "UnknownError";
    fail(2, `ERROR: failed to reach audit-reconcile route (code=${reason})`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Read the body to extract a fixed coarse code, but NEVER log the
    // raw body — it could contain operation ids, bucket names, or
    // internal error details.
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore — body is only used for code extraction
    }
    const errorCode = extractErrorCode(body);
    if (response.status === 504) {
      console.error(
        `ERROR: audit-reconcile timed out (status=504, code=${errorCode}). Claimed rows stay 'claimed' and will be re-claimed by stale recovery.`,
      );
    } else {
      console.error(
        `ERROR: audit-reconcile returned status=${response.status} code=${errorCode}`,
      );
    }
    fail(3, `ERROR: audit reconcile failed (status ${response.status})`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON success body — log only the fixed coarse string.
    console.error("ERROR: audit-reconcile returned non-JSON response");
    fail(3, "ERROR: audit-reconcile returned non-JSON response");
  }

  if (!payload || payload.ok !== true) {
    // The reconciler explicitly returned ok=false.
    // Log only the coarse reason — never JSON.stringify the payload.
    const reason =
      payload && typeof payload.error === "string"
        ? payload.error
        : "unexpected_response";
    console.error(`ERROR: audit-reconcile did not process (code=${reason})`);
    fail(3, `ERROR: audit reconcile did not process (code=${reason})`);
  }

  const result = payload.result || {};
  console.log("Storage audit reconcile completed");
  console.log(`  processed: ${result.processed ?? 0}`);
  console.log(`  completed: ${result.completed ?? 0}`);
  console.log(`  failed:    ${result.failed ?? 0}`);
  process.exit(0);
}

main().catch((err) => {
  const reason = err instanceof Error ? err.name : "UnknownError";
  fail(1, `ERROR: unhandled exception (code=${reason})`);
});
