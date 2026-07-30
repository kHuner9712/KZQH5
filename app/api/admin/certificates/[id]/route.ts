/**
 * Certificates [id] admin API (Section 6).
 *   PATCH   /api/admin/certificates/[id]   -> update metadata
 *   DELETE  /api/admin/certificates/[id]   -> delete with cleanup
 *
 * Both require expectedUpdatedAt (optimistic lock).
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { UUID_PATTERN } from "@/lib/services/http-security";
import {
  deleteCertificate,
  updateCertificateMetadata,
} from "@/lib/services/admin-certificate-write";
import type {
  ProductAssetAccessLevel,
  ProductAssetSourceType,
} from "@/types/database";

const MAX_BODY = 256 * 1024;

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

const VALID_ACCESS_LEVELS: readonly ProductAssetAccessLevel[] = ["public", "private"];
const VALID_SOURCE_TYPES: readonly ProductAssetSourceType[] = [
  "official",
  "self-produced",
  "licensed",
  "public-domain",
];

/**
 * PATCH /api/admin/certificates/[id]
 * Update metadata (non-storage fields). Does NOT change source ref or
 * publish state.
 *
 * Body:
 *   {
 *     "expectedUpdatedAt": string,  // required (optimistic lock)
 *     "payload": { ...Partial<CertificatePayload> },
 *     "accessLevel"?: "public"|"private",
 *     "sourceType"?: ...
 *   }
 */
export async function PATCH(
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

  const rawPayload = body.payload;
  if (!rawPayload || typeof rawPayload !== "object") {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const p = rawPayload as Record<string, unknown>;

  const accessLevel =
    typeof p.access_level === "string"
      ? (p.access_level as ProductAssetAccessLevel)
      : undefined;
  if (accessLevel && !VALID_ACCESS_LEVELS.includes(accessLevel)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const sourceType =
    typeof p.source_type === "string"
      ? (p.source_type as ProductAssetSourceType)
      : null;
  if (sourceType && !VALID_SOURCE_TYPES.includes(sourceType)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Phase 8: is_published is intentionally NOT accepted here. Publish state
  // transitions MUST go through the dedicated /publish and /unpublish
  // endpoints, which perform the two-phase Storage copy (private → public)
  // and enqueue cleanup of the old public object. Letting PATCH flip
  // is_published directly would leave the DB marked published while the
  // public-assets bucket has no corresponding object (front-end 404), or
  // leave public objects orphaned when un-publishing (storage leak).
  // This enforces the hard constraint: "Storage object refs must transition
  // through 'active' → 'pending_delete' → 'deleted' states".
  if (typeof p.is_published !== "undefined") {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const payload = {
    name_cn: typeof p.name_cn === "string" ? p.name_cn : undefined,
    name_en: typeof p.name_en === "string" ? p.name_en : undefined,
    description_cn: typeof p.description_cn === "string" ? p.description_cn : undefined,
    description_en: typeof p.description_en === "string" ? p.description_en : undefined,
    applicable_scope_cn:
      typeof p.applicable_scope_cn === "string" ? p.applicable_scope_cn : undefined,
    applicable_scope_en:
      typeof p.applicable_scope_en === "string" ? p.applicable_scope_en : undefined,
    sort_order: typeof p.sort_order === "number" ? p.sort_order : undefined,
  };

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      id,
      updatedAt: new Date().toISOString(),
    });
  }

  const result = await updateCertificateMetadata(
    guard.client,
    {
      id,
      payload,
      expectedUpdatedAt,
      accessLevel,
      sourceType,
    },
    {
      id: guard.user.id,
      email: guard.user.email,
      role: guard.profile.role,
    },
  );

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/certificates", "page");
  return NextResponse.json({
    success: true,
    id: result.data.id,
    updatedAt: result.data.updatedAt,
  });
}

/**
 * DELETE /api/admin/certificates/[id]
 * Atomically delete the row + enqueue published/source objects for cleanup.
 *
 * Body:
 *   { "expectedUpdatedAt": string }  // required (optimistic lock)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
    return NextResponse.json({ success: true, demo: true, id });
  }

  const result = await deleteCertificate(
    guard.client,
    { id, expectedUpdatedAt },
    {
      id: guard.user.id,
      email: guard.user.email,
      role: guard.profile.role,
    },
  );

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/certificates", "page");
  return NextResponse.json({ success: true, id: result.data.id });
}
