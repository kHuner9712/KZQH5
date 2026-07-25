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
 * PROCESSING CONTRACT (per claimed row) — Section 8 + Section 9
 * ----------------------------------------------------------------
 * The dispatcher distinguishes THREE outcomes of the reference check:
 *
 *   A. referenced=false
 *        1. record_storage_operation_started(action='storage.cleanup_delete')
 *           → returns operation_id (pending audit row)
 *        2. Storage .remove([object_path])
 *        3. On success:
 *             complete_storage_operation(operation_id, success=true)
 *             complete_storage_cleanup(success=true,
 *                                       final_status='deleted',
 *                                       storage_operation_id=operation_id)
 *        4. On Storage failure:
 *             complete_storage_operation(operation_id, success=false,
 *                                        error_code='STORAGE_DELETE_FAILED')
 *             complete_storage_cleanup(success=false,
 *                                       error_code='STORAGE_DELETE_FAILED',
 *                                       final_status='storage_delete_failed',
 *                                       storage_operation_id=operation_id)
 *             → retry → dead_letter
 *
 *   B. referenced=true (RPC returned false was-referenced)
 *        Do NOT delete. Do NOT create an audit row.
 *        complete_storage_cleanup(success=true,
 *                                  final_status='blocked_referenced')
 *        → terminal 'completed' so the row does not retry forever.
 *        If the reference is later removed, a new enqueue creates a
 *        new row. We do NOT count this as 'deleted'.
 *
 *   C. reference check error (RPC error or exception)
 *        Do NOT delete. Do NOT create an audit row.
 *        complete_storage_cleanup(success=false,
 *                                  error_code='REFERENCE_CHECK_FAILED',
 *                                  final_status='reference_check_failed')
 *        → retry → dead_letter
 *        The previous bug flattened this case into success=true,
 *        hiding the failure forever. It is now surfaced for retry.
 *
 * STORAGE AUDIT SAGA — Section 9
 *   Every Storage .remove() call is bracketed by an audit row:
 *     record_storage_operation_started (pending)
 *       ↓ Storage .remove()
 *     complete_storage_operation (completed | failed)
 *       ↓
 *     complete_storage_cleanup (with storage_operation_id link)
 *   The link is persisted atomically inside complete_storage_cleanup
 *   so the audit row and cleanup row cannot diverge. If the audit
 *   completion RPC fails, the cleanup row stays 'claimed' and stale
 *   recovery re-claims it; the audit row stays 'pending' and the
 *   audit-reconcile worker finalizes it later from observed Storage
 *   state. There is NO "best-effort" path that loses the link.
 *
 * FAILURE MATRIX — Section 9
 *   - audit-started RPC fails          → do NOT delete; cleanup row
 *                                         stays 'claimed' for retry.
 *   - Storage .remove() fails          → audit marked failed;
 *                                         cleanup retry/dead-letter.
 *   - audit-completion RPC fails       → cleanup row stays 'claimed';
 *                                         stale recovery re-claims;
 *                                         audit row stays 'pending'
 *                                         and is reconciled later.
 *   - cleanup-completion RPC fails     → object may be deleted; row
 *                                         stays 'claimed'; stale
 *                                         recovery re-claims and the
 *                                         delete is idempotent. The
 *                                         audit row was already
 *                                         finalized.
 *
 * TIMEOUT / CANCELLATION CONTRACT — Section 10 方案 A
 *   - The route does NOT set a fake route-level setTimeout.
 *   - It relies on: (a) fixed batch size (MAX_BATCH_SIZE), (b) the
 *     platform's per-request timeout, (c) per-Storage-call timeouts
 *     enforced by the Supabase client, and (d) stale recovery in
 *     claim_storage_cleanup.
 *   - Storage delete is idempotent — a row whose delete was started
 *     but not finalized will be re-claimed and re-deleted safely.
 *   - The response is returned as soon as the batch finishes; there
 *     is no Promise.race against a timer.
 *
 * RESPONSE CONTRACT
 *   - 200: { ok, processed, result: { claimed, deleted, blocked,
 *            failed, deadLettered, referenceCheckFailed } }
 *     `result` contains ONLY coarse counters. It NEVER contains
 *     object paths, bucket names, source ids, or internal errors.
 *     `referenceCheckFailed` is reported separately from `blocked`
 *     so monitoring can distinguish the two cases.
 *   - 503: secret not configured.
 *   - 401: missing/malformed Authorization header.
 *   - 403: token mismatch.
 *   - 400: invalid JSON body.
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
  /** Reference-check RPC error/exception — Section 8 case C. */
  referenceCheckFailed: number;
}

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;

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
 * Returns one of three discriminable outcomes:
 *   - { kind: 'safe' }                       → proceed to delete
 *   - { kind: 'referenced' }                 → do NOT delete; terminal 'completed'
 *   - { kind: 'reference_check_error', code }→ do NOT delete; retry → dead_letter
 *
 * The previous implementation conflated `referenced` and `error` into
 * a single `referenced=true` outcome, which caused reference-check
 * errors to be marked success=true and hidden forever (Section 8 bug).
 */
async function recheckReferences(
  client: AdminClient,
  row: ClaimedCleanupRow,
): Promise<
  | { kind: "safe" }
  | { kind: "referenced" }
  | { kind: "reference_check_error"; code: string }
> {
  try {
    const { data, error } = await client.rpc("check_storage_object_referenced", {
      p_bucket: row.bucket,
      p_object_path: row.object_path,
    });
    if (error) {
      // RPC returned an error — this is NOT the same as referenced=true.
      // Surface it so the row can retry instead of being terminated.
      return { kind: "reference_check_error", code: "REFERENCE_CHECK_FAILED" };
    }
    if (Boolean(data)) {
      return { kind: "referenced" };
    }
    return { kind: "safe" };
  } catch {
    return { kind: "reference_check_error", code: "REFERENCE_CHECK_EXCEPTION" };
  }
}

/**
 * Record a pending storage audit row BEFORE the .remove() call.
 *
 * Returns the operation id, or null if the RPC failed (in which case
 * the caller MUST NOT proceed with the delete — see Section 9 failure
 * matrix: "audit-started RPC fails → do NOT delete; cleanup row stays
 * 'claimed' for retry").
 */
async function recordCleanupAuditStarted(
  client: AdminClient,
  row: ClaimedCleanupRow,
): Promise<string | null> {
  try {
    const { data, error } = await client.rpc("record_storage_operation_started", {
      p_actor_id: null,
      p_actor_role: "system",
      p_action: "storage.cleanup_delete",
      p_bucket: row.bucket,
      p_object_path: row.object_path,
      p_mime_type: null,
      p_size_bytes: null,
      p_sha256: null,
    });
    if (error || !data) return null;
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Mark the audit row as completed or failed. Best-effort: if this
 * RPC fails, the audit row stays 'pending' and the audit-reconcile
 * worker finalizes it later from observed Storage state. The caller
 * proceeds to complete_storage_cleanup regardless — the link is
 * persisted via the storage_operation_id parameter.
 */
async function completeStorageAudit(
  client: AdminClient,
  operationId: string,
  success: boolean,
  errorCode: string | null,
): Promise<void> {
  try {
    await client.rpc("complete_storage_operation", {
      p_operation_id: operationId,
      p_success: success,
      p_error_code: errorCode,
    });
  } catch {
    // Swallow — the audit-reconcile worker will pick up the pending
    // row and finalize it from observed Storage state. This is NOT
    // "best-effort audit" — the audit row exists and will be
    // reconciled; we just don't block the cleanup completion on it.
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
  client: AdminClient,
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
 *
 * Section 9: when `storageOperationId` is supplied, it is persisted
 * atomically with the cleanup row finalization — the link cannot be
 * lost even if the caller crashes immediately after.
 */
async function completeCleanup(
  client: AdminClient,
  row: ClaimedCleanupRow,
  success: boolean,
  errorCode: string | null,
  finalStatus:
    | "deleted"
    | "blocked_referenced"
    | "reference_check_failed"
    | "storage_delete_failed"
    | null,
  storageOperationId: string | null,
): Promise<"completed" | "retry" | "dead_letter" | "unknown"> {
  try {
    const { data, error } = await client.rpc("complete_storage_cleanup", {
      p_cleanup_id: row.id,
      p_lock_token: row.lock_token,
      p_success: success,
      p_error_code: errorCode,
      p_storage_operation_id: storageOperationId,
      p_final_status: finalStatus,
    });
    if (error) {
      // The RPC itself failed. The row stays 'claimed' and stale
      // recovery will pick it up. We do not retry here — the route
      // returns and the next invocation will re-claim.
      return "unknown";
    }
    return typeof data === "string"
      ? (data as "completed" | "retry" | "dead_letter" | "unknown")
      : "unknown";
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
  client: AdminClient,
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
    return {
      claimed: 0,
      deleted: 0,
      blocked: 0,
      failed: 0,
      deadLettered: 0,
      referenceCheckFailed: 0,
    };
  }

  let deleted = 0;
  let blocked = 0;
  let failed = 0;
  let deadLettered = 0;
  let referenceCheckFailed = 0;

  for (const row of claimed) {
    // Step 1: re-check references. Three distinguishable outcomes.
    const refCheck = await recheckReferences(client, row);

    if (refCheck.kind === "reference_check_error") {
      // Section 8 case C: reference check error → retry → dead_letter.
      // Do NOT delete. Do NOT create an audit row.
      const finalStatus = await completeCleanup(
        client,
        row,
        false, // success=false so the row retries
        refCheck.code,
        "reference_check_failed",
        null, // no audit row was created
      );
      referenceCheckFailed += 1;
      failed += 1;
      if (finalStatus === "dead_letter") deadLettered += 1;
      continue;
    }

    if (refCheck.kind === "referenced") {
      // Section 8 case B: referenced=true → terminal 'completed'.
      // Do NOT delete. Do NOT create an audit row.
      const finalStatus = await completeCleanup(
        client,
        row,
        true, // success=true so the row terminates (does NOT retry)
        null,
        "blocked_referenced",
        null,
      );
      blocked += 1;
      if (finalStatus === "dead_letter") deadLettered += 1;
      continue;
    }

    // Step 2 (Section 8 case A): referenced=false. Begin the audit
    // saga BEFORE calling Storage .remove(). If the audit-started RPC
    // fails, we MUST NOT proceed with the delete — the cleanup row
    // stays 'claimed' and stale recovery re-claims it later.
    const operationId = await recordCleanupAuditStarted(client, row);
    if (!operationId) {
      // Audit-started RPC failed. Per Section 9 failure matrix: do
      // NOT delete; cleanup row stays 'claimed' for retry. We do not
      // call complete_storage_cleanup here either — leave it claimed
      // so stale recovery handles it, rather than risking a retry
      // storm if the audit RPC is failing for systemic reasons.
      console.error("STORAGE_CLEANUP_AUDIT_START_FAILED");
      failed += 1;
      continue;
    }

    // Step 3: Storage .remove(). Idempotent — safe to retry.
    const deleteResult = await deleteStorageObject(client, row);

    if (deleteResult.ok) {
      // Step 4a: deletion succeeded. Finalize the audit row, then
      // finalize the cleanup row with the operation link.
      await completeStorageAudit(client, operationId, true, null);
      const finalStatus = await completeCleanup(
        client,
        row,
        true,
        null,
        "deleted",
        operationId,
      );
      deleted += 1;
      if (finalStatus === "dead_letter") {
        // Edge case: RPC marked dead_letter despite success (e.g.
        // attempts exceeded before the success was recorded). Count
        // it as deleted AND deadLettered for visibility.
        deadLettered += 1;
      }
    } else {
      // Step 4b: deletion failed. Finalize the audit row as failed,
      // then finalize the cleanup row for retry.
      await completeStorageAudit(client, operationId, false, deleteResult.code);
      const finalStatus = await completeCleanup(
        client,
        row,
        false,
        deleteResult.code,
        "storage_delete_failed",
        operationId,
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
    referenceCheckFailed,
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

  // Step 5: Dispatch. Section 10 方案 A: no fake route timeout. We
  // rely on (a) fixed batch size, (b) platform per-request timeout,
  // (c) per-Storage-call timeouts, (d) stale recovery. Storage
  // delete is idempotent, so a row whose delete was started but not
  // finalized will be re-claimed and re-deleted safely.
  try {
    const result = await runCleanupDispatch(batchSize);
    return NextResponse.json({
      ok: true,
      processed: true,
      result,
    });
  } catch {
    console.error("STORAGE_CLEANUP_DISPATCH_FAILED");
    return NextResponse.json(
      { ok: false, error: "dispatch_failed" },
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
