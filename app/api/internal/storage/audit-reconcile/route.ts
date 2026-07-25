import { NextRequest, NextResponse } from "next/server";
import { safeSecretEqual } from "@/lib/services/timing-safe-equal";
import { readJsonBody } from "@/lib/services/http-security";
import { reconcilePendingStorageAudit } from "@/lib/services/storage-upload";

/**
 * Storage Audit Reconciliation — internal entrypoint. (Section 10)
 *
 * Drives the reconciliation of long-pending rows in
 * `admin_storage_operations`. Pending rows are audit records where
 * the storage upload/delete completed but the audit row was never
 * finalized (e.g. worker crashed between Storage response and
 * `complete_storage_operation` RPC). The reconciler checks the
 * actual Storage state and finalizes the audit row accordingly.
 *
 * AUTHENTICATION CONTRACT
 *   - Server-side only. Browser Admin cookies are NEVER used.
 *   - Authentication is a single static bearer secret:
 *       Authorization: Bearer <STORAGE_MAINTENANCE_SECRET>
 *   - The secret is read from process.env.STORAGE_MAINTENANCE_SECRET
 *     and MAY be shared with the storage-maintenance concern (the
 *     cleanup dispatcher uses a SEPARATE STORAGE_CLEANUP_DISPATCH_SECRET
 *     per Section 9). A distinct maintenance secret is allowed so
 *     operators can rotate audit-reconcile access without rotating
 *     cleanup access.
 *   - Secret missing / too short  → 503 Service Unavailable
 *     (fail-closed: the reconciler is intentionally disabled).
 *   - Authorization header missing / malformed  → 401.
 *   - Token mismatch  → 403 (timing-safe).
 *
 * REQUEST CONTRACT
 *   - Content-Type: application/json
 *   - Body (optional):
 *       {
 *         "minAgeSeconds"?: number,   // default 300, minimum 60
 *         "limit"?:        number,    // default 50, clamped [1, 200]
 *         "staleTimeoutSeconds"?: number // default 300, minimum 60
 *       }
 *
 * CONCURRENCY CONTRACT (Section 10 修复要求)
 *   - The reconciler does NOT directly query the pending rows.
 *     Instead it calls `claim_storage_audit_reconcile` RPC which:
 *       * Uses FOR UPDATE SKIP LOCKED — concurrent workers never
 *         claim the same row.
 *       * Generates a per-row `reconcile_lock_token` that MUST be
 *         passed back to `complete_storage_audit_reconcile` to
 *         finalize the row.
 *       * Re-claims rows whose `reconcile_locked_at` is older than
 *         `staleTimeoutSeconds` (stale-lock recovery).
 *   - Completion requires `complete_storage_audit_reconcile` RPC,
 *     which verifies the lock_token AND that the row is still
 *     pending. A concurrent worker that already finalized the row
 *     gets `NOT_FOUND_OR_TOKEN_MISMATCH` and does NOT count it as
 *     processed.
 *   - `processed` in the response counts ONLY rows actually claimed
 *     and finalized by this worker (not rows skipped due to lock
 *     conflict or query failure).
 *
 * PATH EXISTENCE CHECK CONTRACT (Section 10 修复要求)
 *   - The reconciler uses the FULL parent directory when listing
 *     (e.g. for "products/covers/abc.jpg" it lists "products/covers",
 *     NOT just "products").
 *   - The object match is exact: `item.name === filename && !item.isDir`.
 *     Fuzzy search results from Supabase Storage .list() are not
 *     trusted as authoritative.
 *
 * TIMEOUT / CANCELLATION CONTRACT
 *   - The route runs with RECONCILE_TIMEOUT_MS.
 *   - On timeout the route returns 504; in-flight Storage .list()
 *     calls are awaited. Claimed rows remain in 'claimed' state and
 *     are re-claimed by stale recovery (staleTimeoutSeconds).
 *   - This is "at-least-once reconcile" — a row may be checked twice
 *     by different workers, but the lock_token contract ensures only
 *     one worker finalizes it.
 *
 * RESPONSE CONTRACT
 *   - 200: { ok, result: { processed, completed, failed } }
 *     `result` contains ONLY coarse counters. It NEVER contains
 *     object paths, bucket names, operation ids, or internal errors.
 *   - 503: secret not configured.
 *   - 401: missing/malformed Authorization header.
 *   - 403: token mismatch.
 *   - 400: invalid JSON body.
 *   - 504: reconcile timeout.
 *   - 500: unexpected internal error (fixed coarse code only).
 *
 * DEPLOYMENT STATUS
 *   Implemented but NOT deployed as an always-on worker. Operators
 *   invoke on-demand via:
 *     scripts/dispatch-storage-audit-reconcile.mjs
 *   or via a platform cron that supplies the bearer secret.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** Fixed maximum batch size per invocation. */
const MAX_LIMIT = 200;
/** Default batch size when the caller does not supply one. */
const DEFAULT_LIMIT = 50;
/** Default minimum age (seconds) before a pending row is eligible. */
const DEFAULT_MIN_AGE_SECONDS = 300;
/** Default stale-lock recovery timeout (seconds). */
const DEFAULT_STALE_TIMEOUT_SECONDS = 300;
/** Fixed execution timeout (ms) for the entire reconcile operation. */
const RECONCILE_TIMEOUT_MS = 90_000;

interface ReconcileRequestBody {
  minAgeSeconds?: unknown;
  limit?: unknown;
  staleTimeoutSeconds?: unknown;
}

interface CoarseReconcileResult {
  processed: number;
  completed: number;
  failed: number;
}

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const trimmed = header.trim();
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(trimmed);
  return match ? match[1]! : null;
}

function coercePositiveInt(
  value: unknown,
  defaultValue: number,
  minValue: number,
  maxValue: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  const floored = Math.floor(value);
  if (floored < minValue) return minValue;
  return Math.min(floored, maxValue);
}

export async function POST(request: NextRequest) {
  // Step 1: Secret presence (fail-closed 503 when unconfigured).
  // The maintenance secret is distinct from OUTBOX_DISPATCH_SECRET
  // and from STORAGE_CLEANUP_DISPATCH_SECRET (Section 9).
  const secret = process.env.STORAGE_MAINTENANCE_SECRET;
  if (!secret || secret.length < 16) {
    return NextResponse.json(
      { ok: false, error: "reconcile_disabled" },
      { status: 503 },
    );
  }

  // Step 2: Authorization header presence + format.
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "missing_or_malformed_authorization" },
      { status: 401 },
    );
  }

  // Step 3: Timing-safe token comparison.
  if (!safeSecretEqual(token, secret)) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  // Step 4: Body validation.
  const parsed = await readJsonBody<ReconcileRequestBody>(request, 4 * 1024);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: parsed.status },
    );
  }
  const body = parsed.value;
  const minAgeSeconds = coercePositiveInt(
    body.minAgeSeconds,
    DEFAULT_MIN_AGE_SECONDS,
    60,
    86_400,
  );
  const limit = coercePositiveInt(
    body.limit,
    DEFAULT_LIMIT,
    1,
    MAX_LIMIT,
  );
  const staleTimeoutSeconds = coercePositiveInt(
    body.staleTimeoutSeconds,
    DEFAULT_STALE_TIMEOUT_SECONDS,
    60,
    86_400,
  );

  // Step 5: Reconcile with a hard route-level timeout.
  //   - reconcilePendingStorageAudit uses claim_storage_audit_reconcile
  //     (FOR UPDATE SKIP LOCKED + per-row lock_token) so concurrent
  //     workers do not collide.
  //   - On timeout, claimed rows stay 'claimed' and stale recovery
  //     re-claims them on a subsequent invocation.
  const timer = setTimeout(() => {
    // The route will return 504 on the next await; we cannot actively
    // abort in-flight Storage .list() calls, but the timeout ensures
    // the route does not hang indefinitely.
  }, RECONCILE_TIMEOUT_MS);

  try {
    const result = await Promise.race([
      reconcilePendingStorageAudit({
        minAgeSeconds,
        limit,
        staleTimeoutSeconds,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("reconcile_timeout")),
          RECONCILE_TIMEOUT_MS,
        ),
      ),
    ]);

    if (!result.ok) {
      // Reconcile returned a structured failure (e.g. admin client
      // unavailable, claim RPC failed). Return a coarse 500 — never
      // expose the internal code.
      console.error("STORAGE_AUDIT_RECONCILE_FAILED");
      return NextResponse.json(
        { ok: false, error: "reconcile_failed" },
        { status: 500 },
      );
    }

    const coarse: CoarseReconcileResult = {
      processed: result.processed,
      completed: result.completed,
      failed: result.failed,
    };
    return NextResponse.json({
      ok: true,
      result: coarse,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "reconcile_timeout") {
      console.error("STORAGE_AUDIT_RECONCILE_TIMEOUT");
      return NextResponse.json(
        { ok: false, error: "reconcile_timeout" },
        { status: 504 },
      );
    }
    console.error("STORAGE_AUDIT_RECONCILE_EXCEPTION");
    return NextResponse.json(
      { ok: false, error: "reconcile_failed" },
      { status: 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}

export function GET() {
  return NextResponse.json(
    { ok: false, error: "Method Not Allowed" },
    { status: 405 },
  );
}
