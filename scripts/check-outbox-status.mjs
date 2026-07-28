#!/usr/bin/env node
// ============================================================
// Outbox Status Monitor (Phase 2 Task 2)
//
// Calls GET /api/internal/outbox/status and checks threshold
// conditions. If any threshold is exceeded, exits with code 1
// to fail the GitHub Actions workflow (which serves as the
// minimum alerting channel).
//
// AUTHENTICATION
//   Same as dispatch: Authorization: Bearer <OUTBOX_DISPATCH_SECRET>
//   via the OUTBOX_DISPATCH_SECRET environment variable.
//
// URL RESTRICTION
//   Same as dispatch: OUTBOX_DISPATCH_URL must be https (or http
//   for loopback), pathname must be exactly
//   /api/internal/outbox/status, host must be loopback or in
//   OUTBOX_DISPATCH_ALLOWED_HOSTS.
//
// THRESHOLDS (overridable via environment variables)
//   OUTBOX_PENDING_AGE_THRESHOLD_SECONDS   default: 300
//   OUTBOX_CLAIMED_AGE_THRESHOLD_SECONDS   default: 600
//   OUTBOX_DEAD_LETTER_THRESHOLD           default: 0
//
// EXIT CODES
//   0 — all thresholds passed (or snapshot has no concerning values)
//   1 — invalid arguments (missing/invalid URL, missing secret)
//   2 — HTTP/network error
//   3 — route returned non-200 or malformed response
//   4 — one or more thresholds exceeded
//
// SAFETY
//   - Never logs the secret, Authorization header, or raw response body.
//   - Logs only coarse-grained counts and threshold violations.
//   - Never logs inquiry PII, provider message IDs, or error codes
//     that might contain PII.
// ============================================================

const REQUEST_TIMEOUT_MS = 30_000;
const REQUIRED_PATHNAME = "/api/internal/outbox/status";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const DEFAULT_PENDING_AGE_THRESHOLD = 300;
const DEFAULT_CLAIMED_AGE_THRESHOLD = 600;
const DEFAULT_DEAD_LETTER_THRESHOLD = 0;

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function validateTargetUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(1, "ERROR: OUTBOX_DISPATCH_URL is not a valid URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail(1, "ERROR: OUTBOX_DISPATCH_URL must use http(s) protocol");
  }
  if (url.username || url.password) {
    fail(1, "ERROR: OUTBOX_DISPATCH_URL must not contain username/password");
  }
  if (url.hash) {
    fail(1, "ERROR: OUTBOX_DISPATCH_URL must not contain a hash fragment");
  }
  if (url.search) {
    fail(1, "ERROR: OUTBOX_DISPATCH_URL must not contain a query string");
  }
  if (url.pathname !== REQUIRED_PATHNAME) {
    fail(
      1,
      `ERROR: OUTBOX_DISPATCH_URL pathname must be exactly ${REQUIRED_PATHNAME} (got ${url.pathname})`,
    );
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (isLoopback) {
    // Loopback: http or https, any port allowed.
  } else {
    if (url.protocol !== "https:") {
      fail(
        1,
        "ERROR: OUTBOX_DISPATCH_URL must use https for non-loopback hosts",
      );
    }
    if (url.port) {
      fail(
        1,
        "ERROR: OUTBOX_DISPATCH_URL must not specify a port for non-loopback hosts",
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
 * Validate the snapshot object has all required fields with
 * correct types. This is runtime schema validation — we do
 * not blindly trust the JSON shape from the API.
 */
function validateSnapshot(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, reason: "snapshot_not_object" };
  }
  if (payload.ok !== true) {
    return { valid: false, reason: "ok_not_true" };
  }
  const snap = payload.snapshot;
  if (!snap || typeof snap !== "object") {
    return { valid: false, reason: "snapshot_missing" };
  }

  const requiredNumbers = [
    "pending_count",
    "retry_count",
    "claimed_count",
    "sent_count",
    "dead_letter_count",
    "cancelled_count",
  ];
  for (const field of requiredNumbers) {
    if (typeof snap[field] !== "number" || !Number.isFinite(snap[field])) {
      return { valid: false, reason: `field_${field}_invalid` };
    }
  }

  const requiredNullableNumbers = [
    "oldest_pending_age_seconds",
    "oldest_claimed_age_seconds",
    "oldest_dead_letter_age_seconds",
  ];
  for (const field of requiredNullableNumbers) {
    const val = snap[field];
    if (val !== null && (typeof val !== "number" || !Number.isFinite(val))) {
      return { valid: false, reason: `field_${field}_invalid` };
    }
  }

  if (typeof snap.evaluated_at !== "string" || !snap.evaluated_at) {
    return { valid: false, reason: "field_evaluated_at_invalid" };
  }

  return { valid: true, snapshot: snap };
}

async function main() {
  // 1. Validate URL before reading secret.
  const rawUrl = process.env.OUTBOX_DISPATCH_URL;
  if (!rawUrl) {
    fail(
      1,
      "ERROR: OUTBOX_DISPATCH_URL environment variable is not set",
    );
  }
  const url = validateTargetUrl(rawUrl);

  // 2. Read secret.
  const secret = process.env.OUTBOX_DISPATCH_SECRET;
  if (!secret) {
    fail(1, "ERROR: OUTBOX_DISPATCH_SECRET environment variable is not set");
  }
  if (secret.length < 16) {
    fail(1, "ERROR: OUTBOX_DISPATCH_SECRET must be at least 16 characters");
  }

  // 3. Read thresholds from env (overridable by workflow).
  const pendingAgeThreshold = parseInt(
    process.env.OUTBOX_PENDING_AGE_THRESHOLD_SECONDS ||
      String(DEFAULT_PENDING_AGE_THRESHOLD),
    10,
  );
  const claimedAgeThreshold = parseInt(
    process.env.OUTBOX_CLAIMED_AGE_THRESHOLD_SECONDS ||
      String(DEFAULT_CLAIMED_AGE_THRESHOLD),
    10,
  );
  const deadLetterThreshold = parseInt(
    process.env.OUTBOX_DEAD_LETTER_THRESHOLD ||
      String(DEFAULT_DEAD_LETTER_THRESHOLD),
    10,
  );

  // 4. Call the status route.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.name : "UnknownError";
    fail(2, `ERROR: failed to reach status route (code=${reason})`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    const match = body.match(/"error"\s*:\s*"([^"]+)"/);
    const errorCode = match ? match[1] : "unknown";
    console.error(
      `ERROR: status route returned status=${response.status} code=${errorCode}`,
    );
    fail(3, `ERROR: status check failed (status ${response.status})`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error("ERROR: status route returned non-JSON response");
    fail(3, "ERROR: status route returned non-JSON response");
  }

  // 5. Runtime schema validation.
  const validation = validateSnapshot(payload);
  if (!validation.valid) {
    console.error(
      `ERROR: status snapshot schema validation failed (reason=${validation.reason})`,
    );
    fail(3, `ERROR: status snapshot invalid (reason=${validation.reason})`);
  }

  const snap = validation.snapshot;
  const violations = [];

  // 6. Check thresholds.
  if (
    snap.oldest_pending_age_seconds !== null &&
    snap.oldest_pending_age_seconds > pendingAgeThreshold
  ) {
    violations.push(
      `oldest_pending_age_seconds=${snap.oldest_pending_age_seconds} > ${pendingAgeThreshold}`,
    );
  }

  if (
    snap.oldest_claimed_age_seconds !== null &&
    snap.oldest_claimed_age_seconds > claimedAgeThreshold
  ) {
    violations.push(
      `oldest_claimed_age_seconds=${snap.oldest_claimed_age_seconds} > ${claimedAgeThreshold}`,
    );
  }

  if (snap.dead_letter_count > deadLetterThreshold) {
    violations.push(
      `dead_letter_count=${snap.dead_letter_count} > ${deadLetterThreshold}`,
    );
  }

  // 7. Log safe summary.
  console.log("Outbox status check completed");
  console.log(`  pending_count:           ${snap.pending_count}`);
  console.log(`  retry_count:             ${snap.retry_count}`);
  console.log(`  claimed_count:           ${snap.claimed_count}`);
  console.log(`  sent_count:              ${snap.sent_count}`);
  console.log(`  dead_letter_count:       ${snap.dead_letter_count}`);
  console.log(`  cancelled_count:         ${snap.cancelled_count}`);
  console.log(`  oldest_pending_age:      ${snap.oldest_pending_age_seconds ?? "null"}`);
  console.log(`  oldest_claimed_age:      ${snap.oldest_claimed_age_seconds ?? "null"}`);
  console.log(`  oldest_dead_letter_age:  ${snap.oldest_dead_letter_age_seconds ?? "null"}`);
  console.log(`  evaluated_at:            ${snap.evaluated_at}`);

  if (violations.length > 0) {
    console.error("THRESHOLD VIOLATIONS:");
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    fail(4, `ERROR: ${violations.length} threshold violation(s)`);
  }

  console.log("All thresholds passed.");
  process.exit(0);
}

main().catch((err) => {
  const reason = err instanceof Error ? err.name : "UnknownError";
  fail(1, `ERROR: unhandled exception (code=${reason})`);
});
