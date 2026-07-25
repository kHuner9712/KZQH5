/**
 * Certificate publish API (Section 6).
 *   POST /api/admin/certificates/[id]/publish
 *
 * Copies a certificate from private-assets to public-assets via the
 * two-phase claim_certificate_publish + finalize_certificate_publish
 * protocol. The certificate flow mirrors the catalog flow.
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
 *   - updates published_bucket / published_object_path / image_url
 *   - sets publish_status='published', publish_token=null
 *   - enqueues old private source for cleanup
 *   - writes admin_audit_log in the same transaction
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
import { publishCertificateFlow } from "@/lib/services/storage-upload";

const MAX_BODY = 4 * 1024;

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
        mimeType: "image/jpeg",
        size: 0,
      },
    });
  }

  const result = await publishCertificateFlow({
    certificateId: id,
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
  revalidatePath("/certificates", "page");
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
