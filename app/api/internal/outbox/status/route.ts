import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { safeSecretEqual } from "@/lib/services/timing-safe-equal";

/**
 * Outbox Health Snapshot — internal status endpoint.
 *
 * Work Package E: surfaces coarse-grained, PII-free runtime metrics
 * so operators can monitor the Outbox without querying the database
 * directly. Intended for cron-based monitoring, alerting, and on-
 * demand operator checks.
 *
 * AUTHENTICATION CONTRACT
 *   - Server-side only. Browser Admin cookies are NEVER used.
 *   - Authentication is the SAME static bearer secret used by the
 *     dispatcher route, read from process.env.OUTBOX_DISPATCH_SECRET:
 *         Authorization: Bearer <OUTBOX_DISPATCH_SECRET>
 *     (Re-use is acceptable here because both routes already trust
 *      the same secret and both are operational/internal-only. A
 *      separate OUTBOX_STATUS_SECRET can be added later if their
 *      trust boundaries diverge.)
 *   - Secret missing / too short  → 503 Service Unavailable.
 *   - Authorization header missing / malformed  → 401.
 *   - Token mismatch  → 403 (timing-safe).
 *
 * RESPONSE CONTRACT
 *   - 200: { ok: true, snapshot: {...} }
 *     The snapshot object contains ONLY coarse-grained metrics:
 *       pending_count, retry_count, claimed_count, sent_count,
 *       dead_letter_count, cancelled_count,
 *       oldest_pending_age_seconds, oldest_claimed_age_seconds,
 *       oldest_dead_letter_age_seconds,
 *       last_sent_at, last_failed_at, evaluated_at
 *     It NEVER contains inquiry ids, lock tokens, provider message
 *     ids, last_error_code values (which may carry PII), or any
 *     row-level data.
 *   - 401: missing or malformed Authorization header.
 *   - 403: token mismatch.
 *   - 500: RPC failure or unexpected error. The body is a fixed
 *     string; details are logged server-side with a fixed code only.
 *   - 503: OUTBOX_DISPATCH_SECRET not configured.
 *
 * RATE LIMITING
 *   This endpoint is cheap (one cached RPC), but we still enforce a
 *   short-circuit Cache-Control: private, no-store to prevent
 *   accidental CDN caching and to discourage abuse. EdgeOne WAF
 *   rate-limiting should be configured externally for the /api/internal
 *   path prefix.
 *
 * DEMO MODE
 *   In Demo mode, the route still requires the secret (if configured)
 *   and returns the snapshot from the (likely empty) demo database.
 *   When the secret is NOT configured in Demo mode, the route returns
 *   503 — same as production. This is intentional: the contract is
 *   uniform across modes.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

interface HealthSnapshot {
  pending_count: number;
  retry_count: number;
  claimed_count: number;
  sent_count: number;
  dead_letter_count: number;
  cancelled_count: number;
  oldest_pending_age_seconds: number | null;
  oldest_claimed_age_seconds: number | null;
  oldest_dead_letter_age_seconds: number | null;
  last_sent_at: string | null;
  last_failed_at: string | null;
  evaluated_at: string;
}

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const trimmed = header.trim();
  // Match "Bearer <token>" case-insensitively, single space only.
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(trimmed);
  return match ? match[1]! : null;
}

export async function GET(request: NextRequest) {
  // Step 1: Secret presence (fail-closed 503 when unconfigured).
  const secret = process.env.OUTBOX_DISPATCH_SECRET;
  if (!secret || secret.length < 16) {
    return NextResponse.json(
      { ok: false, error: "status_disabled" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  // Step 2: Authorization header presence + format.
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "missing_or_malformed_authorization" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  // Step 3: Timing-safe token comparison.
  if (!safeSecretEqual(token, secret)) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  // Step 4: Invoke the health snapshot RPC.
  try {
    const client = createAdminSupabaseClient();
    const { data, error } = await client.rpc("get_outbox_health_snapshot");
    if (error) {
      // Log a fixed coarse code only — never the raw Supabase error.
      console.error("OUTBOX_HEALTH_SNAPSHOT_FAILED");
      return NextResponse.json(
        { ok: false, error: "snapshot_failed" },
        { status: 500, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (!data || (Array.isArray(data) && data.length === 0)) {
      // Should not happen — the RPC always returns exactly one row.
      console.error("OUTBOX_HEALTH_SNAPSHOT_EMPTY");
      return NextResponse.json(
        { ok: false, error: "snapshot_empty" },
        { status: 500, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const row = (Array.isArray(data) ? data[0] : data) as HealthSnapshot;
    return NextResponse.json(
      { ok: true, snapshot: row },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    // Defensive — never leak the raw error to the response body.
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        (typeof DOMException !== "undefined" &&
          error instanceof DOMException &&
          error.name === "AbortError"));
    if (isAbort) {
      return NextResponse.json(
        { ok: false, error: "snapshot_timeout" },
        { status: 504, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    console.error("OUTBOX_HEALTH_SNAPSHOT_EXCEPTION");
    return NextResponse.json(
      { ok: false, error: "snapshot_failed" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export function POST() {
  return NextResponse.json(
    { ok: false, error: "Method Not Allowed" },
    { status: 405, headers: { "Cache-Control": "private, no-store" } },
  );
}
