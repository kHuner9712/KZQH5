/**
 * Phase 15 (Section 7): Company profile admin API.
 *   GET    /api/admin/company    -> fetch the single company_profile row
 *   POST   /api/admin/company    -> create or update company_profile
 *
 * Writes go through requireAdminWrite (admin session + RBAC "admin" +
 * same-origin + Content-Type + body size). The actual business write is
 * performed by a transactional RPC (save_company_profile_with_audit)
 * that enforces optimistic lock, atomically writes audit, and enqueues
 * replaced logo_url / wechat_qr_url for cleanup.
 *
 * The admin UI MUST call this route — never the Browser Supabase client.
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
import { getCompanyProfile, saveCompanyProfile } from "@/lib/services/admin-content-write";

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

export async function GET(request: NextRequest) {
  // Phase 9: requireAdminRead enforces auth + global/per-admin rate limit +
  // RBAC(minimum editor) + CSRF (isSameSiteRequest for GET).
  const guard = await requireAdminRead(request, { minimumRole: "editor" });
  if (!guard.ok) return guard.response;

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true, profile: null });
  }

  const result = await getCompanyProfile(guard.client);
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  return NextResponse.json({ success: true, profile: result.data });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<Record<string, unknown>>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body;
  const rawPayload = body.payload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const p = rawPayload as Record<string, unknown>;

  // Validate string-or-null fields
  const stringOrNull = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  };

  const id = typeof body.id === "string" && body.id.length > 0 ? body.id : null;
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" && body.expectedUpdatedAt.length > 0
      ? body.expectedUpdatedAt
      : null;

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      id: id ?? `demo-${Date.now()}`,
      updatedAt: new Date().toISOString(),
    });
  }

  const result = await saveCompanyProfile(
    guard.client,
    {
      id,
      payload: {
        title_cn: stringOrNull(p.title_cn),
        title_en: stringOrNull(p.title_en),
        description_cn: stringOrNull(p.description_cn),
        description_en: stringOrNull(p.description_en),
        advantages_cn: p.advantages_cn,
        advantages_en: p.advantages_en,
        phone: stringOrNull(p.phone),
        wechat: stringOrNull(p.wechat),
        email: stringOrNull(p.email),
        whatsapp: stringOrNull(p.whatsapp),
        address_cn: stringOrNull(p.address_cn),
        address_en: stringOrNull(p.address_en),
        wechat_qr_url: stringOrNull(p.wechat_qr_url),
        logo_url: stringOrNull(p.logo_url),
      },
      expectedUpdatedAt,
    },
    { id: guard.user.id, email: guard.user.email, role: guard.profile.role },
  );

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/about", "page");
  revalidatePath("/contact", "page");
  revalidatePath("/", "layout");
  return NextResponse.json({
    success: true,
    id: result.data.id,
    updatedAt: result.data.updatedAt,
  });
}
