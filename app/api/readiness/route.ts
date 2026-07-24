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
//       3. Storage (Supabase Storage bucket is reachable)
//
// Security contract:
//   - Returns HTTP 200 when all checks pass, HTTP 503 when any fails.
//   - Default response body contains ONLY booleans and coarse latency
//     buckets ("fast" / "slow" / "timeout" / "error"). No schema details,
//     no error messages, no secrets.
//   - If READINESS_TOKEN env var is set and the request sends
//     `Authorization: Bearer <token>`, the response includes per-check
//     detail (still sanitized — no raw error text).
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5_000;
const SLOW_THRESHOLD_MS = 500;

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
 * Checks that Supabase Storage is reachable by making a HEAD request to the
 * storage API root. We don't check a specific bucket to avoid leaking
 * bucket names; we only verify the storage service responds.
 */
async function checkStorage(): Promise<CheckResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return { name: "storage", ready: false, latency: "error" };
  }
  const start = Date.now();
  try {
    // HEAD the storage/v1/bucket endpoint. A 401/403 is actually a PASS
    // because it means the storage service is alive — we just don't have
    // permission to list buckets with the anon key (which is correct).
    // A 404 or 500 means storage is broken.
    const res = await fetch(`${url}/storage/v1/bucket`, {
      method: "HEAD",
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const elapsed = Date.now() - start;
    // 200, 401, 403 all indicate the storage service is alive.
    if (res.status === 200 || res.status === 401 || res.status === 403) {
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
 * Checks if the request is authorized to see detailed readiness info.
 * Returns true if READINESS_TOKEN is set and the request sends a matching
 * Bearer token. If READINESS_TOKEN is not set, detailed mode is disabled.
 */
function isAuthorizedForDetail(request: NextRequest): boolean {
  const token = process.env.READINESS_TOKEN;
  if (!token) return false;
  const authHeader = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return false;
  // Constant-time comparison to prevent timing attacks.
  const provided = match[1];
  if (provided.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= provided.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

export async function GET(request: NextRequest) {
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

  // Build the response body. Without detail authorization, we only expose
  // the check name, ready boolean, and latency bucket. With authorization,
  // we also include the sanitized detail string.
  const body = {
    ready: allReady,
    checks: checks.map((c) => ({
      name: c.name,
      ready: c.ready,
      latency: c.latency,
      ...(includeDetail && c.detail ? { detail: c.detail } : {}),
    })),
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: allReady ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
