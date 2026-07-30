/**
 * Two-Phase Upload — Phase 1: Authorize
 *   POST /api/admin/storage/upload/authorize
 *
 * Validates purpose + MIME + size, inserts a temp_uploads row,
 * and returns a signed upload URL pointing to
 * private-assets/temp/{token}/{filename}.
 *
 * The client then PUTs the file directly to Supabase Storage
 * (bypassing EdgeOne's 6 MB body limit), and calls /finalize
 * to verify and move the object.
 *
 * Security:
 *   - requireAdminWrite (service_role + RBAC admin + same-origin)
 *   - body: "json" mode (small JSON request, ~256 bytes)
 *   - Rate limited per admin actor
 *   - All validation BEFORE the signed URL is issued
 *   - temp_uploads row has a 5-minute BUSINESS authorization window
 *     (TEMP_UPLOAD_AUTHORIZATION_WINDOW_SECONDS). The signed-upload-URL
 *     capability TTL is server-controlled (default 1h) and NOT
 *     configurable via the SDK — see lib/services/two-phase-upload.ts.
 *   - Temp object path is server-generated
 *
 * Request body (JSON):
 *   { purpose, filename, mimeType, size }
 *
 * Response (200):
 *   { uploadToken, signedUrl, expiresAt, method, headers }
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import { getStorageUploadRateLimiter } from "@/lib/services/rate-limit";
import { authorizeTempUpload } from "@/lib/services/two-phase-upload";
import type { StoragePurpose } from "@/lib/services/storage-purpose";

export const runtime = "nodejs";

const ALLOWED_FIELDS = new Set([
  "purpose",
  "filename",
  "mimeType",
  "size",
]);

export async function POST(request: NextRequest) {
  // Unified boundary FIRST: auth + RBAC(admin) + same-origin + Content-Length.
  // Demo mode MUST come after the security boundary so that even demo
  // requests are authenticated, role-checked, CSRF-checked, and rate-limited.
  // The hard constraint: "Demo mode branch must be after requireAdminWrite".
  const guard = await requireAdminWrite<{
    purpose: unknown;
    filename: unknown;
    mimeType: unknown;
    size: unknown;
  }>(request, {
    maxBytes: 1024, // authorize requests are tiny (~256 bytes)
    minimumRole: "admin",
    body: "json",
  });
  if (!guard.ok) return guard.response;

  // Rate limit per admin actor (checked before the demo branch so demo
  // traffic is also bounded by the per-admin upload limiter).
  const rateKey = `admin-upload-authorize:${guard.user.id}`;
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

  // Demo mode: return a fake authorization so the UI can be tested
  // without a real Supabase backend. Now placed AFTER auth + RBAC + CSRF +
  // rate limiting, so demo requests still pass the full security boundary.
  //
  // `expiresAt` is the BUSINESS authorization window deadline (matches
  // TEMP_UPLOAD_AUTHORIZATION_WINDOW_SECONDS), NOT the Supabase signed-
  // URL capability TTL. See lib/services/two-phase-upload.ts constant
  // docblock for the three-distinct-lifetimes breakdown.
  if (isDemoMode()) {
    return NextResponse.json({
      uploadToken: crypto.randomUUID(),
      signedUrl: "https://demo.supabase.co/storage/v1/object/upload/private-assets/temp/demo/placeholder",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  const body = guard.body;

  // Strict field whitelist
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
    }
  }

  // Validate field types
  if (
    typeof body.purpose !== "string" ||
    typeof body.filename !== "string" ||
    typeof body.mimeType !== "string" ||
    typeof body.size !== "number"
  ) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Size must be a positive integer
  if (!Number.isFinite(body.size) || body.size <= 0 || !Number.isInteger(body.size)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const result = await authorizeTempUpload({
    purpose: body.purpose as StoragePurpose,
    filename: body.filename,
    mimeType: body.mimeType,
    size: body.size,
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
      uploadToken: result.uploadToken,
      signedUrl: result.signedUrl,
      expiresAt: result.expiresAt,
      method: result.method,
      headers: result.headers,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

function mapErrorCode(code?: string): number {
  switch (code) {
    case "INVALID_PURPOSE":
    case "MIME_NOT_ALLOWED_FOR_PURPOSE":
    case "INVALID_MIME_TYPE":
    case "SIZE_EXCEEDS_LIMIT":
    case "INVALID_FILENAME":
      return 400;
    case "ADMIN_CLIENT_FAILED":
    case "RPC_FAILED":
    case "SIGNED_URL_FAILED":
      return 500;
    default:
      return 500;
  }
}
