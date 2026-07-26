/**
 * Private-assets Preview API (Admin-only, short-lived signed URL)
 *   POST /api/admin/storage/preview
 *
 * Returns a short-lived signed URL for an object in private-assets so the
 * admin UI can render a preview (e.g. an <img> or <iframe>) without making
 * the object publicly accessible.
 *
 * Request body (JSON, ≤ 4KB):
 *   { "bucket": "private-assets", "path": "<server-generated-path>" }
 *
 * Authorization:
 *   - requireAdminWrite (admin session + RBAC minimumRole "admin" + same-origin)
 *   - Only private-assets bucket is allowed. public-assets has direct URLs.
 *
 * Safety invariants:
 *   - bucket MUST be "private-assets" (public-assets is rejected — those have
 *     direct publicUrl and don't need a preview endpoint).
 *   - path MUST be in server-generated format ({category}/{uuid}.{ext}),
 *     validated via validatePrivateAssetPath.
 *   - Signed URL has a short TTL (default 60s, max 300s) so leakage is
 *     time-bounded.
 *   - The signed URL is returned to the admin browser only; it is never
 *     written to a DB row, never logged.
 *
 * Response:
 *   200: { success: true, previewUrl: "<signed-url>", expiresIn: 60 }
 *   400: { error: "..." }  bad request (bad bucket/path)
 *   401: { error: "..." }  unauthenticated
 *   403: { error: "..." }  forbidden (role / origin)
 *   500: { error: "..." }  internal failure (coarse code only)
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import { createAdminClient } from "@/lib/supabase/admin";
import { validatePrivateAssetPath } from "@/lib/services/storage-upload";

const MAX_BODY = 4 * 1024;
const PREVIEW_TTL_SECONDS = 60;

interface PreviewRequestBody {
  bucket?: unknown;
  path?: unknown;
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<PreviewRequestBody>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const { bucket, path } = guard.body;

  // Only private-assets needs a preview endpoint. public-assets has direct
  // publicUrl. Rejecting public-assets here prevents the preview endpoint
  // from being used as a "give me any URL" oracle.
  if (typeof bucket !== "string" || bucket !== "private-assets") {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  if (typeof path !== "string" || path.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Validate path is server-generated format ({category}/{uuid}.{ext}).
  // This prevents previewing arbitrary paths or paths with traversal.
  const pathValidation = validatePrivateAssetPath(path);
  if (!pathValidation.ok) {
    return adminWriteError(pathValidation.code, 400);
  }
  const safePath = pathValidation.path;

  if (isDemoMode()) {
    // Demo mode: return a fake preview URL so the admin UI can be exercised.
    return NextResponse.json({
      success: true,
      demo: true,
      previewUrl: `${(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/sign/private-assets/${safePath}?token=demo`,
      expiresIn: PREVIEW_TTL_SECONDS,
    });
  }

  let client;
  try {
    client = createAdminClient();
  } catch {
    return adminWriteError("ADMIN_WRITE_FAILED", 500);
  }

  try {
    const signed = await client.storage
      .from("private-assets")
      .createSignedUrl(safePath, PREVIEW_TTL_SECONDS);

    if (signed.error) {
      console.error("STORAGE_PREVIEW_SIGN_FAILED", {
        code: "ADMIN_WRITE_FAILED",
      });
      return adminWriteError("ADMIN_WRITE_FAILED", 500);
    }

    if (!signed.data?.signedUrl) {
      return adminWriteError("ADMIN_WRITE_FAILED", 500);
    }

    return NextResponse.json({
      success: true,
      previewUrl: signed.data.signedUrl,
      expiresIn: PREVIEW_TTL_SECONDS,
    });
  } catch {
    console.error("STORAGE_PREVIEW_SIGN_EXCEPTION", {
      code: "ADMIN_WRITE_FAILED",
    });
    return adminWriteError("ADMIN_WRITE_FAILED", 500);
  }
}
