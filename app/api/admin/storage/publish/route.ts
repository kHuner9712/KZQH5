/**
 * Catalog Asset Publish API
 *   POST /api/admin/storage/publish
 *
 * Copies a Catalog asset from private-assets to public-assets and updates
 * the product_assets row in a single transaction (via publish_catalog_asset
 * RPC). The old private-assets source is enqueued for async cleanup.
 *
 * Request body (JSON, ≤ 4KB):
 *   { "assetId": "<uuid>" }
 *
 * Authorization:
 *   - requireAdminWrite (admin session + RBAC minimumRole "admin" + same-origin)
 *   - Service role used for the actual copy / RPC
 *
 * Safety invariants:
 *   - Client cannot specify public bucket / target path / public URL.
 *   - Source must be in private-assets with server-generated path format.
 *   - Source bytes are re-validated (MIME / Magic Bytes / size) after download.
 *   - publish_catalog_asset RPC validates is_published=true,
 *     access_level=public, authorization_status=confirmed inside its own
 *     transaction (FOR UPDATE row lock).
 *   - On RPC failure the new public-assets copy is deleted (compensate).
 *   - On RPC success the old private source is enqueued for cleanup.
 *   - Cleanup enqueue failure is surfaced as `partialCleanup: true` in the
 *     response — the publish itself succeeded; the old private copy is left
 *     for reconciliation / read-only inventory to catch up.
 *   - Idempotent: if the asset's file_url already points to public-assets,
 *     returns the existing ref without copying a second time.
 *
 * Response (coarse-grained; never exposes SQL / internal errors / secrets):
 *   200: { success: true, ref: StorageObjectRef, partialCleanup?: true }
 *   400: { error: "..." }  bad request (missing assetId, bad UUID,
 *                            preconditions not met, source not in private-assets)
 *   401: { error: "..." }  unauthenticated
 *   403: { error: "..." }  forbidden (role / origin)
 *   409: { error: "..." }  concurrent publish conflict
 *   413: { error: "..." }  payload too large
 *   415: { error: "..." }  unsupported media type
 *   500: { error: "..." }  internal failure (coarse code only)
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { publishCatalogAssetFlow } from "@/lib/services/storage-upload";

const MAX_BODY = 4 * 1024;

interface PublishRequestBody {
  assetId?: unknown;
}

function statusForCode(code: AdminWriteErrorCode): number {
  switch (code) {
    case "ADMIN_WRITE_BAD_REQUEST":
      return 400;
    case "ADMIN_WRITE_FORBIDDEN_ORIGIN":
    case "ADMIN_WRITE_FORBIDDEN_ROLE":
    case "ADMIN_WRITE_DEMO":
      return 403;
    case "ADMIN_WRITE_UNAUTHORIZED":
      return 401;
    case "ADMIN_WRITE_PAYLOAD_TOO_LARGE":
      return 413;
    case "ADMIN_WRITE_UNSUPPORTED_MEDIA":
      return 415;
    case "ADMIN_WRITE_CONFLICT":
      return 409;
    default:
      return 500;
  }
}

export async function POST(request: NextRequest) {
  // requireAdminWrite handles:
  //   1. Valid admin session (401 if missing)
  //   2. RBAC: minimum role "admin" (403 if editor/viewer/unknown)
  //   3. Origin present AND same-origin (403 if missing/cross-origin)
  //   4. Sec-Fetch-Site same-origin/none/absent (403 if cross-site/same-site)
  //   5. application/json Content-Type (415 if not)
  //   6. Body size <= 4KB (413 if exceeded)
  //   7. JSON parse success (400 if malformed)
  const guard = await requireAdminWrite<PublishRequestBody>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const { assetId } = guard.body;

  // Validate assetId is a non-empty string matching UUID format.
  if (
    typeof assetId !== "string" ||
    assetId.length === 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      assetId,
    )
  ) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (isDemoMode()) {
    // Demo mode: return a fake published ref without touching Storage.
    // Demo assets are never actually published — the response mirrors the
    // production contract so the admin UI can be exercised end-to-end.
    return NextResponse.json({
      success: true,
      demo: true,
      ref: {
        bucket: "public-assets",
        path: `demo/published/${assetId}`,
        publicUrl: `${(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/public/public-assets/demo/published/${assetId}`,
        mimeType: "application/pdf",
        size: 0,
      },
    });
  }

  const result = await publishCatalogAssetFlow({
    assetId,
    options: {
      actorId: guard.user.id,
      actorEmail: guard.user.email ?? null,
      actorRole: guard.profile.role ?? null,
    },
  });

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code), {
      logCode: result.code,
    });
  }

  // Cleanup enqueue failure is surfaced via partialCleanup flag (not an
  // outright error, since the publish itself succeeded).
  const partialCleanup = result.cleanupId === null;

  return NextResponse.json({
    success: true,
    ref: {
      bucket: result.ref.bucket,
      path: result.ref.path,
      publicUrl: result.ref.publicUrl,
      mimeType: result.ref.mimeType,
      size: result.ref.size,
    },
    ...(partialCleanup ? { partialCleanup: true } : {}),
  });
}
