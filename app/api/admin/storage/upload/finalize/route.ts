/**
 * Two-Phase Upload — Phase 2: Finalize
 *   POST /api/admin/storage/upload/finalize
 *
 * Verifies the uploaded object (Storage HEAD + range-download Magic
 * Bytes), moves it from temp/ to its final path, and completes the
 * temp_uploads lifecycle.
 *
 * The client calls this AFTER successfully PUTting the file directly
 * to the Supabase Storage signed URL returned by /authorize.
 *
 * Security:
 *   - requireAdminWrite (service_role + RBAC admin + same-origin)
 *   - body: "json" mode (tiny JSON request)
 *   - Rate limited per admin actor
 *   - Atomic claim via claim_temp_upload_for_finalize RPC
 *     (SELECT FOR UPDATE SKIP LOCKED)
 *   - Magic Bytes verification prevents MIME spoofing
 *   - Size verification prevents Content-Length spoofing
 *   - Final object path is server-generated
 *
 * Request body (JSON):
 *   { uploadToken }
 *
 * Response (200):
 *   { bucket, path, publicUrl, mimeType, size }
 *
 * Failure responses:
 *   404 — token not found
 *   409 — token already claimed or in terminal state
 *   410 — token expired
 *   422 — object verification failed (not found, size mismatch,
 *         magic bytes mismatch)
 *   500 — internal error (copy failed, cross-bucket move failed)
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import { getStorageUploadRateLimiter } from "@/lib/services/rate-limit";
import { finalizeTempUpload } from "@/lib/services/two-phase-upload";

export const runtime = "nodejs";

const ALLOWED_FIELDS = new Set(["uploadToken"]);

export async function POST(request: NextRequest) {
  // Unified boundary FIRST: auth + RBAC(admin) + same-origin + Content-Length.
  // Demo mode MUST come after the security boundary so that even demo
  // requests are authenticated, role-checked, CSRF-checked, and rate-limited.
  // The hard constraint: "Demo mode branch must be after requireAdminWrite".
  const guard = await requireAdminWrite<{
    uploadToken: unknown;
  }>(request, {
    maxBytes: 512, // finalize requests are tiny
    minimumRole: "admin",
    body: "json",
  });
  if (!guard.ok) return guard.response;

  // Rate limit per admin actor (checked before the demo branch so demo
  // traffic is also bounded by the per-admin upload limiter).
  const rateKey = `admin-upload-finalize:${guard.user.id}`;
  const rate = await getStorageUploadRateLimiter().check(rateKey);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "ADMIN_WRITE_RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "Cache-Control": "private, no-store",
        },
      },
    );
  }

  // Demo mode: return a fake finalize result. Now placed AFTER auth + RBAC +
  // CSRF + rate limiting, so demo requests still pass the full security boundary.
  if (isDemoMode()) {
    return NextResponse.json({
      bucket: "public-assets",
      path: "products/demo-placeholder.jpg",
      publicUrl: "https://demo.supabase.co/storage/v1/object/public/public-assets/products/demo-placeholder.jpg",
      mimeType: "image/jpeg",
      size: 0,
    });
  }

  const body = guard.body;

  // Strict field whitelist
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
    }
  }

  // Validate uploadToken
  if (typeof body.uploadToken !== "string" || body.uploadToken.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Basic UUID format validation
  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(body.uploadToken)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const result = await finalizeTempUpload({
    uploadToken: body.uploadToken,
    actorId: guard.user.id,
    actorRole: guard.profile.role,
  });

  if (!result.ok) {
    const statusCode = mapErrorCode(result.code);
    return NextResponse.json(
      { error: result.code },
      { status: statusCode, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  return NextResponse.json(
    {
      bucket: result.bucket,
      path: result.path,
      publicUrl: result.publicUrl,
      mimeType: result.mimeType,
      size: result.size,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

function mapErrorCode(code?: string): number {
  switch (code) {
    case "not_found_or_locked":
      return 404;
    case "race_claimed":
    case "race_finalized":
    case "already_terminal":
      return 409;
    case "expired":
      return 410;
    case "invalid_status":
      return 409;
    // KZQ-P0-003: actor binding errors are authorization failures.
    case "invalid_actor":
    case "actor_not_bound":
    case "actor_mismatch":
      return 403;
    case "OBJECT_NOT_FOUND":
    case "SIZE_MISMATCH":
    case "MAGIC_BYTES_MISMATCH":
    case "RANGE_DOWNLOAD_FAILED":
    case "MAGIC_BYTES_FETCH_FAILED":
      return 422;
    case "COPY_FAILED":
    case "CROSS_BUCKET_MOVE_FAILED":
    case "PATH_GENERATION_FAILED":
    case "ADMIN_CLIENT_FAILED":
    case "CLAIM_FAILED":
      return 500;
    default:
      return 500;
  }
}
