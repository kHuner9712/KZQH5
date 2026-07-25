import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { safeSecretEqual } from "@/lib/services/timing-safe-equal";
import { readJsonBody } from "@/lib/services/http-security";

/**
 * Storage Cleanup Dispatcher — internal entrypoint. (Section 9)
 *
 * Drives the `storage_cleanup_queue` table: claims pending rows with
 * FOR UPDATE SKIP LOCKED (via claim_storage_cleanup RPC), re-checks
 * that no business table still references the object, and only then
 * deletes it from Storage. The processing unit is ONE cleanup queue
 * row — this route NEVER scans an entire bucket and bulk-deletes.
 *
 * AUTHENTICATION CONTRACT
 *   - Server-side only. Browser Admin cookies are NEVER used.
 *   - Authentication is a single static bearer secret:
 *       Authorization: Bearer <STORAGE_CLEANUP_DISPATCH_SECRET>
 *   - The secret is read from process.env.STORAGE_CLEANUP_DISPATCH_SECRET
 *     and MUST be distinct from OUTBOX_DISPATCH_SECRET — the two
 *     operational concerns must not share credentials, so a leak of
 *     one does not grant the other.
 *   - Secret missing / too short  → 503 Service Unavailable
 *     (fail-closed: the dispatcher is intentionally disabled).
 *   - Authorization header missing / malformed  → 401.
 *   - Token mismatch  → 403 (timing-safe).
 *
 * REQUEST CONTRACT
 *   - Content-Type: application/json
 *   - Body (optional): { "batchSize"?: number }
 *   - batchSize is clamped to [1, MAX_BATCH_SIZE]; non-integer /
 *     negative / missing defaults to DEFAULT_BATCH_SIZE.
 *
 * PROCESSING CONTRACT (per claimed row)
 *   1. claim_storage_cleanup returns rows with (id, bucket, object_path,
 *      lock_token). The lock_token is the single-use authorization to
 *      finalize the row.
 *   2. For each row, re-check references via check_storage_object_referenced.
 *      This is the fail-closed guarantee: even if a business write raced
 *      with the cleanup enqueue, we WILL NOT delete an object that is
 *      currently referenced.
 *   3. If referenced=true → complete_storage_cleanup(success=true)
 *      with error_code="REFERENCED_BLOCKED". The row is marked completed
 *      so it does not retry forever; if the reference is later removed,
 *      a new enqueue will create a new row. (We do NOT delete.)
 *   4. If referenced=false → call Storage .remove([object_path]).
 *       - Success → complete_storage_cleanup(success=true)
 *       - Failure → complete_storage_cleanup(success=false, error_code)
 *   5. If complete_storage_cleanup returns "dead_letter", the row has
 *      exceeded max_attempts and will not be retried automatically.
 *   6. Stale lock recovery is handled inside claim_storage_cleanup: a
 *      row whose locked_at is older than the stale timeout (default
 *      300s) is eligible for re-claim. This means a worker that
 *      crashes mid-deletion does not permanently block the row.
 *
 * TIMEOUT / CANCELLATION CONTRACT
 *   - The route runs with DISPATCH_TIMEOUT_MS.
 *   - On timeout the route returns 504; in-flight Storage .remove()
 *     calls are awaited to completion (we cannot abort a Storage
 *     delete safely — the object may or may not be gone). The rows
 *     remain 'claimed' and stale recovery re-claims them later.
 *   - This is intentionally simpler than the Outbox AbortSignal
 *     threading because Storage delete is idempotent — re-running
 *     it on the same path is safe. The contract is "at-least-once
 *     delete attempt", not "exactly-once".
 *
 * RESPONSE CONTRACT
 *   - 200: { ok, processed, result: { claimed, deleted, blocked,
 *            failed, deadLettered } }
 *     `result` contains ONLY coarse counters. It NEVER contains
 *     object paths, bucket names, source ids, or internal errors.
 *   - 503: secret not configured.
 *   - 401: missing/malformed Authorization header.
 *   - 403: token mismatch.
 *   - 400: invalid JSON body.
 *   - 504: dispatch timeout.
 *   - 500: unexpected internal error (fixed coarse code only).
 *
 * DEPLOYMENT STATUS
 *   Implemented but NOT deployed as an always-on worker. Operators
 *   invoke on-demand via:
 *     scripts/dispatch-storage-cleanup.mjs
 *   or via a platform cron that supplies the bearer secret. Until a
 *   platform cron exists, dead_letter rows require manual review.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** Fixed maximum batch size per invocation. */
const MAX_BATCH_SIZE = 25;
/** Default batch size when the caller does not supply one. */
const DEFAULT_BATCH_SIZE = 10;
/** Fixed execution timeout (ms) for the entire dispatch operation. */
const DISPATCH_TIMEOUT_MS = 60_000;
/** Stale-claim recovery timeout (seconds) for claim_storage_cleanup. */
const STALE_TIMEOUT_SECONDS = 300;

interface DispatchRequestBody {
  batchSize?: unknown;
}

interface ClaimedCleanupRow {
  id: string;
  bucket: "public-assets" | "private-assets";
  object_path: string;
  lock_token: string;
}

interface CoarseDispatchResult {
  claimed: number;
  deleted: number;
  blocked: number;
  failed: number;
  deadLettered: number;
}

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const trimmed = header.trim();
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(trimmed);
  return match ? match[1]! : null;
}

function coerceBatchSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BATCH_SIZE;
  }
  const floored = Math.floor(value);
  if (floored < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(floored, MAX_BATCH_SIZE);
}

/**
 * Re-check references for a single claimed row.
 *
 * Returns true if the object is still referenced (delete MUST be
 * refused); false if it is safe to delete. On RPC error we treat
 * the object as referenced (fail-closed) and mark the row completed
 * with REFERENCED_CHECK_FAILED so it surfaces for review.
 */
async function isStillReferenced(
  client: ReturnType<typeof createAdminSupabaseClient>,
  row: ClaimedCleanupRow,
): Promise<{ referenced: boolean; errorCode: string | null }> {
  try {
    const { data, error } = await client.rpc("check_storage_object_referenced", {
      p_bucket: row.bucket,
      p_object_path: row.object_path,
    });
    if (error) {
      // fail-closed: treat as referenced, do not delete.
      return { referenced: true, errorCode: "REFERENCED_CHECK_FAILED" };
    }
    return { referenced: Boolean(data), errorCode: null };
  } catch {
    return { referenced: true, errorCode: "REFERENCED_CHECK_EXCEPTION" };
  }
}

/**
 * Delete the object from Storage. Returns true on success.
 *
 * Supabase .remove() is idempotent — removing a non-existent path
 * returns success. We treat any explicit error as a deletion failure
 * that should be retried by the cleanup queue.
 */
async function deleteStorageObject(
  client: ReturnType<typeof createAdminSupabaseClient>,
  row: ClaimedCleanupRow,
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const { error } = await client.storage
      .from(row.bucket)
      .remove([row.object_path]);
    if (error) {
      return { ok: false, code: "STORAGE_DELETE_FAILED" };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "STORAGE_DELETE_EXCEPTION" };
  }
}

/**
 * Finalize a claimed cleanup row with the outcome. Returns the final
 * status string from the RPC so the caller can count dead_letter.
 */
async function completeCleanup(
  client: ReturnType<typeof createAdminSupabaseClient>,
  row: ClaimedCleanupRow,
  success: boolean,
  errorCode: string | null,
): Promise<"completed" | "retry" | "dead_letter" | "unknown"> {
  try {
    const { data, error } = await client.rpc("complete_storage_cleanup", {
      p_cleanup_id: row.id,
      p_lock_token: row.lock_token,
      p_success: success,
      p_error_code: errorCode,
    });
    if (error) {
      // The RPC itself failed. The row stays 'claimed' and stale
      // recovery will pick it up. We do not retry here — the route
      // returns and the next invocation will re-claim.
      return "unknown";
    }
    return typeof data === "string" ? (data as "completed" | "retry" | "dead_letter" | "unknown") : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Claim a batch of pending cleanup rows via the trusted RPC.
 *
 * The RPC uses FOR UPDATE SKIP LOCKED so concurrent workers do not
 * collide. It also re-claims rows whose locked_at is older than the
 * stale timeout — a worker that crashed mid-delete does not block
 * the row forever.
 */
async function claimCleanupBatch(
  client: ReturnType<typeof createAdminSupabaseClient>,
  batchSize: number,
): Promise<ClaimedCleanupRow[]> {
  try {
    const { data, error } = await client.rpc("claim_storage_cleanup", {
      p_limit: batchSize,
      p_stale_timeout_seconds: STALE_TIMEOUT_SECONDS,
    });
    if (error) {
      console.error("STORAGE_CLEANUP_CLAIM_FAILED");
      return [];
    }
    if (!Array.isArray(data)) return [];
    // Sanity-shape each row; reject malformed entries.
    return (data as unknown[]).filter((row): row is ClaimedCleanupRow => {
      if (!row || typeof row !== "object") return false;
      const r = row as Record<string, unknown>;
      return (
        typeof r.id === "string" &&
        (r.bucket === "public-assets" || r.bucket === "private-assets") &&
        typeof r.object_path === "string" &&
        typeof r.lock_token === "string"
      );
    }) as ClaimedCleanupRow[];
  } catch {
    console.error("STORAGE_CLEANUP_CLAIM_EXCEPTION");
    return [];
  }
}

async function runCleanupDispatch(
  batchSize: number,
): Promise<CoarseDispatchResult> {
  const client = createAdminSupabaseClient();
  const claimed = await claimCleanupBatch(client, batchSize);
  if (claimed.length === 0) {
    return { claimed: 0, deleted: 0, blocked: 0, failed: 0, deadLettered: 0 };
  }

  let deleted = 0;
  let blocked = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const row of claimed) {
    // Step 1: re-check references. Fail-closed: if the RPC errors,
    // we treat the object as referenced and mark the row completed
    // with an error code so it surfaces for review.
    const { referenced, errorCode: refErrorCode } = await isStillReferenced(client, row);
    if (referenced) {
      // Do NOT delete. Mark as completed with the referenced-blocked
      // code so the row does not retry forever. If the reference is
      // later removed, a new enqueue will create a new row.
      const finalStatus = await completeCleanup(
        client,
        row,
        true, // success=true so the row terminates, not retry
        refErrorCode ?? "REFERENCED_BLOCKED",
      );
      blocked += 1;
      if (finalStatus === "dead_letter") deadLettered += 1;
      continue;
    }

    // Step 2: delete the object from Storage.
    const deleteResult = await deleteStorageObject(client, row);
    if (deleteResult.ok) {
      // Step 3a: deletion succeeded — finalize the row as completed.
      const finalStatus = await completeCleanup(client, row, true, null);
      if (finalStatus === "dead_letter") {
        // Edge case: RPC marked dead_letter despite success (e.g.
        // attempts exceeded before the success was recorded). Count
        // it as deleted AND deadLettered for visibility.
        deadLettered += 1;
      }
      deleted += 1;
    } else {
      // Step 3b: deletion failed — finalize the row as failed so the
      // queue can retry (or dead-letter after max_attempts).
      const finalStatus = await completeCleanup(
        client,
        row,
        false,
        deleteResult.code,
      );
      failed += 1;
      if (finalStatus === "dead_letter") deadLettered += 1;
    }
  }

  return {
    claimed: claimed.length,
    deleted,
    blocked,
    failed,
    deadLettered,
  };
}

export async function POST(request: NextRequest) {
  // Step 1: Secret presence (fail-closed 503 when unconfigured).
  // The cleanup secret MUST be distinct from OUTBOX_DISPATCH_SECRET.
  const secret = process.env.STORAGE_CLEANUP_DISPATCH_SECRET;
  if (!secret || secret.length < 16) {
    return NextResponse.json(
      { ok: false, error: "cleanup_dispatcher_disabled" },
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
  const parsed = await readJsonBody<DispatchRequestBody>(request, 4 * 1024);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: parsed.status },
    );
  }
  const batchSize = coerceBatchSize(parsed.value.batchSize);

  // Step 5: Dispatch with a hard route-level timeout. We do NOT
  // thread an AbortSignal into the Storage .remove() call because
  // Storage delete is idempotent — if the route times out mid-delete,
  // the row stays 'claimed' and stale recovery re-claims it later,
  // and a re-run of the delete on the same path is safe.
  const timer = setTimeout(() => {
    // The route will return 504 on the next await; we cannot actively
    // abort the in-flight Storage call, but the timeout ensures the
    // route does not hang indefinitely.
  }, DISPATCH_TIMEOUT_MS);

  try {
    const result = await Promise.race([
      runCleanupDispatch(batchSize),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("dispatch_timeout")),
          DISPATCH_TIMEOUT_MS,
        ),
      ),
    ]);
    return NextResponse.json({
      ok: true,
      processed: true,
      result,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "dispatch_timeout") {
      console.error("STORAGE_CLEANUP_DISPATCH_TIMEOUT");
      return NextResponse.json(
        { ok: false, error: "dispatch_timeout" },
        { status: 504 },
      );
    }
    console.error("STORAGE_CLEANUP_DISPATCH_FAILED");
    return NextResponse.json(
      { ok: false, error: "dispatch_failed" },
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
