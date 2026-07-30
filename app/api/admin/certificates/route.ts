/**
 * Certificates admin API (Section 6).
 *   GET    /api/admin/certificates       -> list all certificates (admin)
 *   POST   /api/admin/certificates       -> create or update a draft
 *
 * All writes go through requireAdminWrite (admin session + RBAC "admin" +
 * same-origin + Content-Type + body size). The actual business write is
 * performed by a transactional RPC (save_certificate_draft) that
 * enforces optimistic lock and writes audit atomically.
 *
 * The admin UI MUST call this route for writes — never the Browser
 * Supabase client. Reads (list) also go through this route so the UI no
 * longer needs the Browser Supabase client at all.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
  requireAdminRead,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import {
  listAllCertificates,
  saveCertificateDraft,
} from "@/lib/services/admin-certificate-write";
import type {
  ProductAssetAccessLevel,
  ProductAssetSourceType,
} from "@/types/database";

const MAX_BODY = 256 * 1024;

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
 * GET /api/admin/certificates
 * List all certificates for the admin UI.
 *
 * The admin UI MUST call this route instead of reading certificates
 * via the Browser Supabase client. Uses service_role.
 */
export async function GET(request: NextRequest) {
  // Phase 9: requireAdminRead enforces auth + global/per-admin rate limit +
  // RBAC(minimum editor) + CSRF (isSameSiteRequest for GET).
  const guard = await requireAdminRead(request, { minimumRole: "editor" });
  if (!guard.ok) return guard.response;

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      certificates: [],
    });
  }

  const result = await listAllCertificates(guard.client);
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  return NextResponse.json({
    success: true,
    certificates: result.data,
  });
}

/**
 * POST /api/admin/certificates
 * Create or update a certificate draft.
 *
 * Body:
 *   {
 *     "id"?: "<uuid>",               // null/omitted = insert
 *     "expectedUpdatedAt"?: string,  // required on update (optimistic lock)
 *     "payload": { ...CertificatePayload },
 *     "sourceBucket": "private-assets",
 *     "sourceObjectPath": "<server-generated path>",
 *     "mimeType"?: string,
 *     "fileSize"?: number,
 *     "sha256"?: string,
 *     "accessLevel"?: "public"|"private",
 *     "sourceType"?: "official"|...
 *   }
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<Record<string, unknown>>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body;

  // Validate required fields
  const sourceBucket = body.sourceBucket;
  if (typeof sourceBucket !== "string" || sourceBucket !== "private-assets") {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const sourceObjectPath = body.sourceObjectPath;
  if (typeof sourceObjectPath !== "string" || sourceObjectPath.trim().length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Validate payload shape
  const rawPayload = body.payload;
  if (!rawPayload || typeof rawPayload !== "object") {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const p = rawPayload as Record<string, unknown>;

  const nameCn = p.name_cn;
  if (typeof nameCn !== "string" || nameCn.trim().length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const accessLevel = typeof p.access_level === "string" ? p.access_level : "private";
  if (!VALID_ACCESS_LEVELS.includes(accessLevel as ProductAssetAccessLevel)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const sourceType = typeof p.source_type === "string" ? p.source_type : null;
  if (sourceType && !VALID_SOURCE_TYPES.includes(sourceType as ProductAssetSourceType)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Build the validated payload
  const payload = {
    name_cn: nameCn,
    name_en: typeof p.name_en === "string" ? p.name_en : null,
    description_cn: typeof p.description_cn === "string" ? p.description_cn : null,
    description_en: typeof p.description_en === "string" ? p.description_en : null,
    applicable_scope_cn: typeof p.applicable_scope_cn === "string" ? p.applicable_scope_cn : null,
    applicable_scope_en: typeof p.applicable_scope_en === "string" ? p.applicable_scope_en : null,
    sort_order: typeof p.sort_order === "number" ? p.sort_order : 0,
    is_published: false, // Draft is never published
  };

  const id = typeof body.id === "string" ? body.id : null;
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      id: id ?? `demo-${Date.now()}`,
      updatedAt: new Date().toISOString(),
    });
  }

  const result = await saveCertificateDraft(
    guard.client,
    {
      id,
      payload,
      sourceBucket,
      sourceObjectPath,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : null,
      fileSize: typeof body.fileSize === "number" ? body.fileSize : null,
      sha256: typeof body.sha256 === "string" ? body.sha256 : null,
      expectedUpdatedAt,
      accessLevel: accessLevel as ProductAssetAccessLevel,
      sourceType: sourceType as ProductAssetSourceType | null,
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
