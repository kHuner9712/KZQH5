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
 * TIMEOUT / CANCELLATION CONTRACT — Section 10 方案 A
 *   - The route does NOT set a fake route-level setTimeout. The prior
 *     implementation used `Promise.race` against a `setTimeout` with
 *     an empty callback — that left the reconcile running in the
 *     background after the route had already responded 504, which is
 *     the bug Section 10 forbids ("不得声称任务停止, 实际后台仍继续").
 *   - It now relies on: (a) fixed batch size (MAX_LIMIT), (b) the
 *     platform's per-request timeout, (c) per-Storage-call timeouts
 *     enforced by the Supabase client, and (d) stale recovery in
 *     claim_storage_audit_reconcile (staleTimeoutSeconds).
 *   - Reconciliation is idempotent — a row whose check was started
 *     but not finalized will be re-claimed and re-checked safely.
 *     The lock_token contract ensures only one worker finalizes it.
 *   - The response is returned as soon as the batch finishes; there
 *     is no Promise.race against a timer.
 *
 * RESPONSE CONTRACT
 *   - 200: { ok, result: { processed, completed, failed } }
 *     `result` contains ONLY coarse counters. It NEVER contains
 *     object paths, bucket names, operation ids, or internal errors.
 *   - 503: secret not configured.
 *   - 401: missing/malformed Authorization header.
 *   - 403: token mismatch.
 *   - 400: invalid JSON body.
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

  // Step 5: Reconcile. Section 10 方案 A: no fake route timeout.
  //   - reconcilePendingStorageAudit uses claim_storage_audit_reconcile
  //     (FOR UPDATE SKIP LOCKED + per-row lock_token) so concurrent
  //     workers do not collide.
  //   - We rely on: (a) fixed batch size (MAX_LIMIT), (b) the
  //     platform's per-request timeout, (c) per-Storage-call timeouts,
  //     (d) stale recovery (staleTimeoutSeconds). Reconciliation is
  //     idempotent — a row whose check was started but not finalized
  //     will be re-claimed and re-checked safely.
  //   - The previous `Promise.race` against a `setTimeout` with an
  //     empty callback was a bug (Section 10): it left the reconcile
  //     running in the background after the route had already
  //     responded 504. That is now removed.
  try {
    const result = await reconcilePendingStorageAudit({
      minAgeSeconds,
      limit,
      staleTimeoutSeconds,
    });

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
  } catch {
    console.error("STORAGE_AUDIT_RECONCILE_EXCEPTION");
    return NextResponse.json(
      { ok: false, error: "reconcile_failed" },
      { status: 500 },
    );
  }
}

export function GET() {
  return NextResponse.json(
    { ok: false, error: "Method Not Allowed" },
    { status: 405 },
  );
}
