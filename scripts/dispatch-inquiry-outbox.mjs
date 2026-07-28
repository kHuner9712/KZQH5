#!/usr/bin/env node
// ============================================================
// Outbox Dispatcher — controlled operations entrypoint.
//
// This script invokes the canonical Outbox Dispatcher HTTP route
// (POST /api/internal/outbox/dispatch) which calls
// `processInquiryOutbox` from lib/services/inquiries/outbox-processor.ts.
// It does NOT contain its own delivery state machine — the route is
// the single source of truth for:
//   - claim_inquiry_outbox_deliveries (FOR UPDATE SKIP LOCKED)
//   - per-provider adapter invocation (Resend email / WeCom webhook)
//   - mark_delivery_sent / fail_delivery_event
//   - Resend Idempotency-Key Header dedup
//   - WeCom at-least-once semantics
//   - Stale-claim recovery
//   - AbortController-driven timeout that aborts the in-flight
//     provider HTTP request, not just the route-level await.
//
// AUTHENTICATION
//   The route is authenticated with a static bearer secret
//   (OUTBOX_DISPATCH_SECRET). This script reads the secret from the
//   environment and never logs it. The secret must be at least 16
//   characters; the route returns 503 if it is missing or too short.
//
// URL RESTRICTION (Section 11.1 — lock dispatcher destination)
//   The target URL is read from the OUTBOX_DISPATCH_URL environment
//   variable, NOT from a CLI flag. This prevents an operator from
//   accidentally pointing the script at an arbitrary HTTPS host and
//   leaking the bearer secret.
//
//   OUTBOX_DISPATCH_URL must satisfy ALL of:
//     - protocol = https (http only for loopback dev)
//     - host is one of:
//         * loopback: localhost | 127.0.0.1 | [::1]
//         * present in OUTBOX_DISPATCH_ALLOWED_HOSTS (comma-separated)
//     - pathname === "/api/internal/outbox/dispatch" (exact match)
//     - no username / password
//     - no port (except loopback, where any port is allowed)
//     - no query string
//     - no hash
//
//   fetch() is called with `redirect: "error"` so an attacker cannot
//   trick the route into forwarding the secret to a different host.
//
// USAGE
//   OUTBOX_DISPATCH_SECRET=<secret> \
//   OUTBOX_DISPATCH_URL=https://staging.example.com/api/internal/outbox/dispatch \
//   [OUTBOX_DISPATCH_ALLOWED_HOSTS=staging.example.com] \
//     node scripts/dispatch-inquiry-outbox.mjs [--batch-size 10]
//
//   Local development (loopback is always allowed):
//     OUTBOX_DISPATCH_SECRET=dev-dispatch-secret-1234567890 \
//     OUTBOX_DISPATCH_URL=http://127.0.0.1:3000/api/internal/outbox/dispatch \
//       node scripts/dispatch-inquiry-outbox.mjs
//
// EXIT CODES
//   0 — dispatcher ran successfully (may include 0 deliveries processed)
//   1 — invalid arguments (missing/invalid OUTBOX_DISPATCH_URL, missing secret)
//   2 — HTTP / network error contacting the route
//   3 — route returned non-200 (auth failure, server error, timeout, etc.)
//
// SAFETY
//   - This script NEVER calls Supabase directly.
//   - It NEVER sends notifications directly.
//   - It logs ONLY coarse-grained counters from the route response,
//     never inquiry PII, provider response bodies, or internal errors.
//   - It NEVER logs the raw response body — only fixed coarse codes
//     extracted via regex. An unexpected JSON body is not echoed.
//   - It does not retry — operators should re-invoke the script or
//     configure a platform cron that calls the route directly.
// ============================================================

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 60_000;
const REQUIRED_PATHNAME = "/api/internal/outbox/dispatch";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseArgs(argv) {
  const args = { batchSize: DEFAULT_BATCH_SIZE };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--batch-size") {
      const raw = Number.parseInt(argv[++i] || "", 10);
      if (Number.isFinite(raw) && raw >= 1) {
        args.batchSize = Math.min(raw, MAX_BATCH_SIZE);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: OUTBOX_DISPATCH_URL=<url> OUTBOX_DISPATCH_SECRET=<secret> \\
       node scripts/dispatch-inquiry-outbox.mjs [options]

Options:
  --batch-size <n>     Batch size 1..${MAX_BATCH_SIZE} (default: ${DEFAULT_BATCH_SIZE})
  --help               Show this help message

Required environment:
  OUTBOX_DISPATCH_URL              Target URL (strict validated; see source)
  OUTBOX_DISPATCH_SECRET           Bearer secret (>= 16 chars)

Optional environment:
  OUTBOX_DISPATCH_ALLOWED_HOSTS    Comma-separated allowlist of non-loopback hosts
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
 * Validate the target URL against the Section 11.1 contract.
 * Returns the validated URL object, or fails with exit code 1.
 *
 * Allowed:
 *   - https://<allowed-host>/api/internal/outbox/dispatch
 *   - http://<loopback>:<port>/api/internal/outbox/dispatch
 *
 * Rejected:
 *   - any URL with username/password (userinfo)
 *   - any URL with a query string or hash
 *   - any URL whose pathname is not exactly the required path
 *   - any non-loopback host with a port
 *   - any non-loopback host not in OUTBOX_DISPATCH_ALLOWED_HOSTS
 *   - http:// for non-loopback hosts
 *   - protocols other than http/https
 */
function validateTargetUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(1, `ERROR: OUTBOX_DISPATCH_URL is not a valid URL`);
  }

  // Protocol: only https (http only for loopback).
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail(1, `ERROR: OUTBOX_DISPATCH_URL must use http(s) protocol`);
  }

  // No userinfo.
  if (url.username || url.password) {
    fail(1, `ERROR: OUTBOX_DISPATCH_URL must not contain username/password`);
  }

  // No hash.
  if (url.hash) {
    fail(1, `ERROR: OUTBOX_DISPATCH_URL must not contain a hash fragment`);
  }

  // No query string.
  if (url.search) {
    fail(1, `ERROR: OUTBOX_DISPATCH_URL must not contain a query string`);
  }

  // Pathname must be exactly the required path.
  if (url.pathname !== REQUIRED_PATHNAME) {
    fail(
      1,
      `ERROR: OUTBOX_DISPATCH_URL pathname must be exactly ${REQUIRED_PATHNAME} (got ${url.pathname})`,
    );
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (isLoopback) {
    // Loopback: http or https, any port allowed.
    if (url.protocol === "http:") {
      // Allow http on loopback for dev.
    } else if (url.protocol !== "https:") {
      fail(1, `ERROR: OUTBOX_DISPATCH_URL must use http or https`);
    }
  } else {
    // Non-loopback: must be https, no port, host must be allowlisted.
    if (url.protocol !== "https:") {
      fail(
        1,
        `ERROR: OUTBOX_DISPATCH_URL must use https for non-loopback hosts (got ${url.protocol})`,
      );
    }
    if (url.port) {
      fail(
        1,
        `ERROR: OUTBOX_DISPATCH_URL must not specify a port for non-loopback hosts (got :${url.port})`,
      );
    }
    const allowedHosts = (process.env.OUTBOX_DISPATCH_ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (!allowedHosts.includes(url.hostname)) {
      fail(
        1,
        `ERROR: host ${url.hostname} is not allowed. Add it to OUTBOX_DISPATCH_ALLOWED_HOSTS or use a loopback address.`,
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
  const rawUrl = process.env.OUTBOX_DISPATCH_URL;
  if (!rawUrl) {
    fail(
      1,
      "ERROR: OUTBOX_DISPATCH_URL environment variable is not set. The --url CLI flag has been removed for safety (Section 11.1).",
    );
  }
  const url = validateTargetUrl(rawUrl);

  // 2. Read the secret.
  const secret = process.env.OUTBOX_DISPATCH_SECRET;
  if (!secret) {
    fail(1, "ERROR: OUTBOX_DISPATCH_SECRET environment variable is not set");
  }
  if (secret.length < 16) {
    fail(1, "ERROR: OUTBOX_DISPATCH_SECRET must be at least 16 characters");
  }

  // 3. Call the route with redirect: "error" so no 3xx can forward
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
      body: JSON.stringify({ batchSize: args.batchSize }),
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.name : "UnknownError";
    fail(2, `ERROR: failed to reach dispatcher route (code=${reason})`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Read the body to extract a fixed coarse code, but NEVER log the
    // raw body — it could contain provider response payloads, SQL
    // text, or PII from the inquiry.
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore — body is only used for code extraction
    }
    const errorCode = extractErrorCode(body);
    if (response.status === 504) {
      console.error(
        `ERROR: dispatcher timed out (status=504, code=${errorCode}). In-flight sends were aborted; claimed deliveries will be re-claimed by stale recovery.`,
      );
    } else {
      console.error(
        `ERROR: dispatcher returned status=${response.status} code=${errorCode}`,
      );
    }
    fail(3, `ERROR: dispatch failed (status ${response.status})`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON success body — log only the fixed coarse string.
    console.error("ERROR: dispatcher returned non-JSON response");
    fail(3, "ERROR: dispatcher returned non-JSON response");
  }

  if (!payload || payload.ok !== true || payload.processed !== true) {
    // The dispatcher explicitly returned ok=false or processed=false.
    // Log only the coarse reason — never JSON.stringify the payload,
    // which could include unexpected fields from a misconfigured route.
    const reason =
      payload && typeof payload.error === "string"
        ? payload.error
        : payload && payload.processed === false
          ? "not_processed"
          : "unexpected_response";
    console.error(`ERROR: dispatcher did not process (code=${reason})`);
    fail(3, `ERROR: dispatch did not process (code=${reason})`);
  }

  const result = payload.result || {};

  // Phase 2: Double-safety — even though the route contract guarantees
  // that aborted=true returns 504 (caught by !response.ok above), verify
  // the field in case a future route change accidentally returns 200
  // with aborted=true. This must fail the workflow so the scheduler
  // does not report success for an aborted dispatch.
  if (result.aborted === true) {
    console.error(
      `ERROR: dispatcher returned 200 but result.aborted=true (skippedDueToAbort=${result.skippedDueToAbort ?? 0}). This violates the route contract — the route should have returned 504.`,
    );
    fail(3, "ERROR: dispatch aborted but returned 200 (contract violation)");
  }

  console.log("Outbox dispatch completed");
  console.log(`  initialized:  ${result.initialized ?? 0}`);
  console.log(`  claimed:      ${result.claimed ?? 0}`);
  console.log(`  sent:         ${result.sent ?? 0}`);
  console.log(`  failed:       ${result.failed ?? 0}`);
  console.log(`  dead_lettered:${result.deadLettered ?? 0}`);
  process.exit(0);
}

main().catch((err) => {
  const reason = err instanceof Error ? err.name : "UnknownError";
  fail(1, `ERROR: unhandled exception (code=${reason})`);
});
