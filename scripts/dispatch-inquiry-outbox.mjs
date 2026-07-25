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
//
// AUTHENTICATION
//   The route is authenticated with a static bearer secret
//   (OUTBOX_DISPATCH_SECRET). This script reads the secret from the
//   environment and never logs it. The secret must be at least 16
//   characters; the route returns 503 if it is missing or too short.
//
// USAGE
//   OUTBOX_DISPATCH_SECRET=<secret> \
//     node scripts/dispatch-inquiry-outbox.mjs \
//     --url https://staging.example.com/api/internal/outbox/dispatch \
//     [--batch-size 10]
//
//   Local development:
//     # Start the Next.js dev server in one shell, then:
//     OUTBOX_DISPATCH_SECRET=dev-dispatch-secret-1234567890 \
//       node scripts/dispatch-inquiry-outbox.mjs \
//       --url http://127.0.0.1:3000/api/internal/outbox/dispatch
//
// EXIT CODES
//   0 — dispatcher ran successfully (may include 0 deliveries processed)
//   1 — invalid arguments (missing --url, missing secret)
//   2 — HTTP / network error contacting the route
//   3 — route returned non-200 (auth failure, server error, etc.)
//
// SAFETY
//   - This script NEVER calls Supabase directly.
//   - It NEVER sends notifications directly.
//   - It logs ONLY coarse-grained counters from the route response,
//     never inquiry PII, provider response bodies, or internal errors.
//   - It does not retry — operators should re-invoke the script or
//     configure a platform cron that calls the route directly.
// ============================================================

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const args = { url: null, batchSize: DEFAULT_BATCH_SIZE };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") {
      args.url = argv[++i] || null;
    } else if (arg === "--batch-size") {
      const raw = Number.parseInt(argv[++i] || "", 10);
      if (Number.isFinite(raw) && raw >= 1) {
        args.batchSize = Math.min(raw, MAX_BATCH_SIZE);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/dispatch-inquiry-outbox.mjs --url <url> [options]

Options:
  --url <url>          Dispatcher route URL (required)
  --batch-size <n>     Batch size 1..${MAX_BATCH_SIZE} (default: ${DEFAULT_BATCH_SIZE})
  --help               Show this help message

Environment:
  OUTBOX_DISPATCH_SECRET  Bearer secret (required, >= 16 chars)
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

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    fail(1, "ERROR: --url is required");
  }
  let url;
  try {
    url = new URL(args.url);
  } catch {
    fail(1, `ERROR: --url is not a valid URL: ${args.url}`);
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    // Allow http:// only for loopback dev. Staging/prod must use https.
    // (The route still enforces auth regardless of protocol.)
    if (url.protocol === "http:") {
      fail(1, `ERROR: http:// is only allowed for loopback (127.0.0.1 / localhost / ::1). Use https:// for ${url.hostname}.`);
    } else {
      fail(1, `ERROR: unsupported protocol: ${url.protocol}`);
    }
  }

  const secret = process.env.OUTBOX_DISPATCH_SECRET;
  if (!secret) {
    fail(1, "ERROR: OUTBOX_DISPATCH_SECRET environment variable is not set");
  }
  if (secret.length < 16) {
    fail(1, "ERROR: OUTBOX_DISPATCH_SECRET must be at least 16 characters");
  }

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
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.name : "UnknownError";
    fail(2, `ERROR: failed to reach dispatcher route (code=${reason})`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore — body is only used for diagnostic logging
    }
    // Never log the body if it could contain secret/PII; only log status.
    console.error(`ERROR: dispatcher returned status=${response.status}`);
    if (body && body.length <= 200) {
      // Route returns fixed coarse strings; safe to log briefly.
      console.error(`body: ${body}`);
    }
    fail(3, `ERROR: dispatch failed (status ${response.status})`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(3, "ERROR: dispatcher returned non-JSON response");
  }

  if (!payload || payload.ok !== true || payload.processed !== true) {
    console.error("ERROR: dispatcher response missing expected fields");
    console.error(JSON.stringify(payload, null, 2));
    fail(3, "ERROR: dispatch did not process (see response above)");
  }

  const result = payload.result || {};
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
