// ============================================================
// KZQ Readiness Check — /api/readiness
//
// Phase 10: A secure readiness endpoint distinct from /api/health.
//
// Difference from /api/health:
//   - /api/health is a LIVENESS probe: it only proves the Node.js process
//     can run and respond. It does NOT claim Supabase is healthy.
//   - /api/readiness is a READINESS probe: it verifies that the application
//     can actually serve requests by checking:
//       1. Public product query (Supabase REST is reachable + RLS works)
//       2. Critical RPC (verify_schema_readiness is callable via service_role)
//       3. Storage canary object (Supabase Storage can serve public objects)
//
// Security contract:
//   - Returns HTTP 200 when all checks pass, HTTP 503 when any fails.
//   - Work Package G: rate-limited per IP (12 / 60s) to prevent abuse.
//   - Work Package G: default response body contains ONLY `{ ready,
//     timestamp }` — the per-check array is gated behind READINESS_TOKEN
//     to prevent attackers from enumerating which subsystem is failing.
//   - With READINESS_TOKEN, the response includes per-check `name`,
//     `ready`, `latency` (coarse bucket), and a sanitized `detail`
//     string. No raw error text, no Supabase error messages, no secrets.
//   - Work Package G: storage check now fetches a public canary object
//     instead of HEAD-ing the bucket root. This verifies end-to-end
//     Storage retrieval (not just HTTP service liveness). The canary
//     is a small fixed-size object under a public path; HEAD on the
//     bucket root previously accepted 401/403 as "ready" which is a
//     fail-open behavior (a broken bucket policy could still 401).
//   - Work Package G: token comparison uses crypto.timingSafeEqual
//     via safeSecretEqualBuffer instead of a hand-rolled charCodeAt
//     loop.
//   - Cache-Control: no-store (readiness must be checked fresh each time).
//   - runtime = nodejs, dynamic = force-dynamic (never cached at CDN).
//
// Latency buckets:
//   - "fast"   : < 500ms
//   - "slow"   : 500ms – 2000ms
//   - "timeout": request timed out (> 2000ms or AbortSignal fired)
//   - "error"  : request failed (network, HTTP error, parse error)
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import { logServerError } from "@/lib/logging/server-log";
import {
  ephemeralRateKey,
  safeSecretEqualBuffer,
} from "@/lib/services/http-security";
import { getReadinessRateLimiter } from "@/lib/services/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5_000;
const SLOW_THRESHOLD_MS = 500;

// Work Package G: canary object path. This is a small (1x1 placeholder)
// image stored at a fixed path in the public Supabase Storage bucket.
// Its existence is intentional and non-sensitive — it carries no PII
// and exists solely for the readiness probe. The path is intentionally
// NOT configurable via env to prevent operators from accidentally
// pointing the probe at a private object (which would leak via the
// readiness response code).
const STORAGE_CANARY_PATH = "public-assets/canary/canary-1x1.png";

type LatencyBucket = "fast" | "slow" | "timeout" | "error";

interface CheckResult {
  name: string;
  ready: boolean;
  latency: LatencyBucket;
  detail?: string;
}

function classifyLatency(ms: number): LatencyBucket {
  if (ms < SLOW_THRESHOLD_MS) return "fast";
  return "slow";
}

/**
 * Checks that the public Supabase REST endpoint can return published products.
 * Uses the anon key (not service_role) so this also validates RLS.
 */
async function checkPublicProducts(): Promise<CheckResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return { name: "public_products", ready: false, latency: "error" };
  }
  const start = Date.now();
  try {
    const res = await fetch(
      `${url}/rest/v1/products?select=id&is_published=eq.true&limit=1`,
      {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const elapsed = Date.now() - start;
    if (res.ok) {
      return {
        name: "public_products",
        ready: true,
        latency: classifyLatency(elapsed),
      };
    }
    return {
      name: "public_products",
      ready: false,
      latency: classifyLatency(elapsed),
      detail: `HTTP ${res.status}`,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      name: "public_products",
      ready: false,
      latency: isTimeout ? "timeout" : "error",
    };
  }
}

/**
 * Checks that the verify_schema_readiness() RPC is callable via service_role.
 * This validates both DB connectivity and that critical migrations are applied.
 */
async function checkCriticalRpc(): Promise<CheckResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return { name: "critical_rpc", ready: false, latency: "error" };
  }
  const start = Date.now();
  try {
    const res = await fetch(`${url}/rest/v1/rpc/verify_schema_readiness`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const elapsed = Date.now() - start;
    if (res.ok) {
      const body = await res.json();
      // We only check the top-level ok flag, never the detailed checks array
      // (which could leak schema info if exposed in the response).
      const ok =
        typeof body === "object" &&
        body !== null &&
        typeof body.ok === "boolean" &&
        body.ok === true;
      return {
        name: "critical_rpc",
        ready: ok,
        latency: classifyLatency(elapsed),
      };
    }
    return {
      name: "critical_rpc",
      ready: false,
      latency: classifyLatency(elapsed),
      detail: `HTTP ${res.status}`,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      name: "critical_rpc",
      ready: false,
      latency: isTimeout ? "timeout" : "error",
    };
  }
}

/**
 * Work Package G: storage check via a public canary object.
 *
 * Previously: HEAD on /storage/v1/bucket and treated 200/401/403 as
 * "ready" (fail-open). A 401/403 only proves the storage HTTP service
 * is alive — it does NOT prove that any object can actually be
 * retrieved (a broken bucket policy or missing canary would still 401).
 *
 * New behavior: GET the public canary object. Only HTTP 200 indicates
 * readiness; any other status (including 401/403/404) is a failure.
 * The canary is a small fixed-size image with no PII; its path is
 * hardcoded (not env-configurable) to prevent operators from
 * accidentally pointing the probe at a private object.
 */
async function checkStorage(): Promise<CheckResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    return { name: "storage", ready: false, latency: "error" };
  }
  const start = Date.now();
  try {
    // The Supabase Storage public URL pattern is:
    //   {SUPABASE_URL}/storage/v1/object/public/{path}
    // Public buckets don't require Authorization; if a request with
    // no Authorization returns 200, the public read path is healthy.
    const res = await fetch(
      `${url}/storage/v1/object/public/${STORAGE_CANARY_PATH}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const elapsed = Date.now() - start;
    if (res.ok) {
      // We don't read the body — we only care about the HTTP status.
      // Reading the body would consume bandwidth for every probe.
      return {
        name: "storage",
        ready: true,
        latency: classifyLatency(elapsed),
      };
    }
    return {
      name: "storage",
      ready: false,
      latency: classifyLatency(elapsed),
      detail: `HTTP ${res.status}`,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      name: "storage",
      ready: false,
      latency: isTimeout ? "timeout" : "error",
    };
  }
}

/**
 * Work Package G: checks if the request is authorized to see the
 * per-check array. The basic response is `{ ready, timestamp }` only;
 * an authorized request gets the full `checks` array with per-check
 * name / ready / latency / detail.
 *
 * Returns true if READINESS_TOKEN is set and the request sends a matching
 * Bearer token. If READINESS_TOKEN is not set, detail mode is disabled.
 *
 * Uses crypto.timingSafeEqual via safeSecretEqualBuffer instead of a
 * hand-rolled charCodeAt loop.
 */
function isAuthorizedForDetail(request: NextRequest): boolean {
  const token = process.env.READINESS_TOKEN;
  if (!token) return false;
  const authHeader = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return false;
  return safeSecretEqualBuffer(match[1], token);
}

export async function GET(request: NextRequest) {
  // --- Rate limit: 12 / 60s / IP ---
  // Without rate limiting, an attacker could DOS Supabase by repeatedly
  // hitting readiness (which calls Supabase REST + Storage + a service_role
  // RPC) or use it as an oracle to probe service_role behavior.
  const rateKey = ephemeralRateKey(request);
  const limiter = getReadinessRateLimiter();
  const { allowed, retryAfterSeconds } = await limiter.check(rateKey);
  if (!allowed) {
    return NextResponse.json(
      { ready: false, error: "RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const includeDetail = isAuthorizedForDetail(request);

  const checks = await Promise.all([
    checkPublicProducts(),
    checkCriticalRpc(),
    checkStorage(),
  ]);

  const allReady = checks.every((c) => c.ready);

  // Log failures with fixed codes (no PII or secrets).
  if (!allReady) {
    const failedChecks = checks.filter((c) => !c.ready);
    for (const c of failedChecks) {
      logServerError(
        "READINESS_CHECK_FAILED",
        `readiness.${c.name}`,
        c.latency === "timeout" ? "timeout" : "unknown",
      );
    }
  }

  // Build the response body. Work Package G: the per-check array is
  // gated behind READINESS_TOKEN. Without the token, an unauthenticated
  // caller only sees `{ ready, timestamp }` — they cannot enumerate
  // which subsystem is failing (which would leak operational state).
  const body: {
    ready: boolean;
    timestamp: string;
    checks?: Array<{
      name: string;
      ready: boolean;
      latency: LatencyBucket;
      detail?: string;
    }>;
  } = {
    ready: allReady,
    timestamp: new Date().toISOString(),
  };

  if (includeDetail) {
    body.checks = checks.map((c) => ({
      name: c.name,
      ready: c.ready,
      latency: c.latency,
      ...(c.detail ? { detail: c.detail } : {}),
    }));
  }

  return NextResponse.json(body, {
    status: allReady ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
