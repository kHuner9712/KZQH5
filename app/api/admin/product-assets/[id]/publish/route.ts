/**
 * Product Asset publish API (Section 4/5).
 *   POST /api/admin/product-assets/[id]/publish
 *
 * Copies a Catalog asset from private-assets to public-assets via the
 * two-phase claim_catalog_asset_publish + finalize_catalog_asset_publish
 * protocol. The old publish_catalog_asset RPC is no longer called.
 *
 * Body:
 *   { "expectedUpdatedAt": string }  // required (optimistic lock)
 *
 * The claim RPC enforces:
 *   - optimistic lock (expected_updated_at required, NULL -> 22004,
 *     stale -> 40P01)
 *   - is_published / access_level / authorization_status preconditions
 *   - returns trusted source_bucket / source_object_path / publish_token
 *
 * The finalize RPC atomically:
 *   - verifies publish_token + publish_status='publishing'
 *   - updates published_bucket / published_object_path / file_url
 *   - sets publish_status='published', publish_token=null
 *   - enqueues old private source for cleanup
 *   - writes admin_audit_log in the same transaction
 *   (no `exception when others then null` swallow)
 *
 * On finalize failure the new public-assets copy is compensated-delete.
 * On compensate-delete failure the residual object is enqueued for
 * cleanup dispatch.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { publishCatalogAssetFlow } from "@/lib/services/storage-upload";
import { UUID_PATTERN } from "@/lib/services/http-security";

const MAX_BODY = 4 * 1024;

// Phase 8: Admin API routes must be dynamic to ensure middleware runs and
// CSP nonce / Cache-Control headers are injected on every request.
export const dynamic = "force-dynamic";

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Phase 8: validate path param BEFORE requireAdminWrite so malformed
  // inputs get 400 instead of being forwarded to the RPC layer.
  if (!UUID_PATTERN.test(id)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const guard = await requireAdminWrite<Record<string, unknown>>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body;
  const expectedUpdatedAt = body.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      ref: {
        bucket: "public-assets",
        path: `demo/published/${id}`,
        publicUrl: `${(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/public/public-assets/demo/published/${id}`,
        mimeType: "application/pdf",
        size: 0,
      },
    });
  }

  const result = await publishCatalogAssetFlow({
    assetId: id,
    expectedUpdatedAt,
    options: {
      actorId: guard.user.id,
      actorEmail: guard.user.email ?? null,
      actorRole: guard.profile.role ?? null,
    },
  });

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/products", "page");
  return NextResponse.json({
    success: true,
    ref: {
      bucket: result.ref.bucket,
      path: result.ref.path,
      publicUrl: result.ref.publicUrl,
      mimeType: result.ref.mimeType,
      size: result.ref.size,
    },
  });
}
