/**
 * Phase 15 (Section 7): Homepage content admin API.
 *   GET    /api/admin/homepage    -> fetch the active homepage_content row
 *   POST   /api/admin/homepage    -> create or update homepage_content
 *
 * Writes go through requireAdminWrite. The actual business write is
 * performed by save_homepage_content_with_audit RPC, which atomically
 * writes audit and enforces optimistic lock.
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
  getHomepageContent,
  saveHomepageContent,
} from "@/lib/services/admin-content-write";

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
    return NextResponse.json({ success: true, demo: true, content: null });
  }

  const result = await getHomepageContent(guard.client);
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  return NextResponse.json({ success: true, content: result.data });
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

  const result = await saveHomepageContent(
    guard.client,
    {
      id,
      payload: {
        hero_eyebrow_cn: stringOrNull(p.hero_eyebrow_cn),
        hero_eyebrow_en: stringOrNull(p.hero_eyebrow_en),
        hero_title_cn: stringOrNull(p.hero_title_cn),
        hero_title_en: stringOrNull(p.hero_title_en),
        hero_highlight_cn: stringOrNull(p.hero_highlight_cn),
        hero_highlight_en: stringOrNull(p.hero_highlight_en),
        hero_description_cn: stringOrNull(p.hero_description_cn),
        hero_description_en: stringOrNull(p.hero_description_en),
        primary_cta_text_cn: stringOrNull(p.primary_cta_text_cn),
        primary_cta_text_en: stringOrNull(p.primary_cta_text_en),
        secondary_cta_text_cn: stringOrNull(p.secondary_cta_text_cn),
        secondary_cta_text_en: stringOrNull(p.secondary_cta_text_en),
        feature_section_title_cn: stringOrNull(p.feature_section_title_cn),
        feature_section_title_en: stringOrNull(p.feature_section_title_en),
        feature_section_subtitle_cn: stringOrNull(p.feature_section_subtitle_cn),
        feature_section_subtitle_en: stringOrNull(p.feature_section_subtitle_en),
        features_cn: p.features_cn,
        features_en: p.features_en,
        category_section_title_cn: stringOrNull(p.category_section_title_cn),
        category_section_subtitle_cn: stringOrNull(p.category_section_subtitle_cn),
        featured_products_title_cn: stringOrNull(p.featured_products_title_cn),
        featured_products_subtitle_cn: stringOrNull(p.featured_products_subtitle_cn),
        bottom_cta_title_cn: stringOrNull(p.bottom_cta_title_cn),
        bottom_cta_title_en: stringOrNull(p.bottom_cta_title_en),
        bottom_cta_description_cn: stringOrNull(p.bottom_cta_description_cn),
        bottom_cta_description_en: stringOrNull(p.bottom_cta_description_en),
        is_active: typeof p.is_active === "boolean" ? p.is_active : true,
      },
      expectedUpdatedAt,
    },
    { id: guard.user.id, email: guard.user.email, role: guard.profile.role },
  );

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/", "page");
  return NextResponse.json({
    success: true,
    id: result.data.id,
    updatedAt: result.data.updatedAt,
  });
}
