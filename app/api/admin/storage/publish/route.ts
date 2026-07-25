/**
 * Catalog Asset Publish API (Section 5 rewrite: two-phase claim/finalize)
 *   POST /api/admin/storage/publish
 *
 * Copies a Catalog asset from private-assets to public-assets via the
 * claim_catalog_asset_publish + finalize_catalog_asset_publish two-phase
 * protocol. The old publish_catalog_asset RPC is no longer called by
 * production code.
 *
 * Request body (JSON, ≤ 4KB):
 *   {
 *     "assetId": "<uuid>",
 *     "expectedUpdatedAt": "<ISO timestamp from product_assets.updated_at>"
 *   }
 *
 * Section 5 (Claim 强制乐观锁): expectedUpdatedAt is REQUIRED. The claim
 * RPC rejects NULL with 22004 / ADMIN_WRITE_BAD_REQUEST and stale values
 * with 40P01 / ADMIN_WRITE_CONFLICT.
 *
 * Authorization:
 *   - requireAdminWrite (admin session + RBAC minimumRole "admin" + same-origin)
 *   - Service role used for the actual copy / RPC
 *
 * Safety invariants:
 *   - Client cannot specify public bucket / target path / public URL / source path.
 *   - claim RPC returns the trusted source_bucket / source_object_path /
 *     publish_token; the application never reads client-supplied file_url
 *     to infer the private path.
 *   - Source bytes are re-validated (MIME / Magic Bytes / size / SHA-256)
 *     after download from private-assets.
 *   - finalize RPC atomically updates the row + enqueues old source cleanup
 *     + writes audit in a single transaction (no `exception when others
 *     then null` swallow).
 *   - On finalize failure the new public-assets copy is compensated-delete.
 *   - On compensate-delete failure the residual object is enqueued for
 *     cleanup dispatch.
 *   - Idempotent: if the asset is already in publish_status='published',
 *     claim returns status='already_published' and the flow returns the
 *     existing ref without copying a second time.
 *
 * Response (coarse-grained; never exposes SQL / internal errors / secrets):
 *   200: { success: true, ref: StorageObjectRef, partialCleanup?: true }
 *   400: { error: "..." }  bad request (missing assetId/expectedUpdatedAt,
 *                            bad UUID, preconditions not met)
 *   401: { error: "..." }  unauthenticated
 *   403: { error: "..." }  forbidden (role / origin)
 *   409: { error: "..." }  concurrent publish conflict / stale updated_at
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
  expectedUpdatedAt?: unknown;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  const { assetId, expectedUpdatedAt } = guard.body;

  // Validate assetId is a non-empty string matching UUID format.
  if (typeof assetId !== "string" || !UUID_RE.test(assetId)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Section 5: expectedUpdatedAt is REQUIRED (non-empty ISO timestamp string).
  // The claim RPC rejects NULL with 22004; we mirror that contract here so
  // the client gets a 400 instead of a 500 from a NULL claim attempt.
  if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (isDemoMode()) {
    // Demo mode: return a fake published ref without touching Storage.
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
    expectedUpdatedAt,
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
  // outright error, since the publish itself succeeded). Note: under the
  // new two-phase protocol, finalize enqueues cleanup atomically — so
  // cleanupId is null only when there was no old private source to clean
  // up, OR when the finalize transaction rolled back (in which case we
  // wouldn't reach this branch).
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
