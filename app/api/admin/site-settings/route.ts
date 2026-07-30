/**
 * Phase 15 (Section 7): Site settings admin API.
 *   GET    /api/admin/site-settings    -> fetch the single site_settings row
 *   POST   /api/admin/site-settings    -> create or update site_settings
 *
 * Writes go through requireAdminWrite. The actual business write is
 * performed by save_site_settings_with_audit RPC, which atomically
 * writes audit and enqueues replaced default_og_image_url for cleanup.
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
import { getSiteSettings, saveSiteSettings } from "@/lib/services/admin-content-write";
import type { NavItem } from "@/types/database";

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
    return NextResponse.json({ success: true, demo: true, settings: null });
  }

  const result = await getSiteSettings(guard.client);
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  return NextResponse.json({ success: true, settings: result.data });
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

  const siteName = typeof p.site_name === "string" ? p.site_name.trim() : "";
  if (siteName.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const defaultLanguage =
    typeof p.default_language === "string" && (p.default_language === "zh" || p.default_language === "en")
      ? p.default_language
      : "zh";

  // Validate navigation_json is an array of NavItem-shaped objects
  if (p.navigation_json != null && !Array.isArray(p.navigation_json)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const navItems: NavItem[] = Array.isArray(p.navigation_json)
    ? (p.navigation_json as NavItem[])
    : [];

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

  const result = await saveSiteSettings(
    guard.client,
    {
      id,
      payload: {
        site_name: siteName,
        site_name_cn: stringOrNull(p.site_name_cn),
        site_name_en: stringOrNull(p.site_name_en),
        brand_name: stringOrNull(p.brand_name),
        default_language: defaultLanguage,
        global_meta_title_cn: stringOrNull(p.global_meta_title_cn),
        global_meta_title_en: stringOrNull(p.global_meta_title_en),
        global_meta_description_cn: stringOrNull(p.global_meta_description_cn),
        global_meta_description_en: stringOrNull(p.global_meta_description_en),
        default_og_image_url: stringOrNull(p.default_og_image_url),
        footer_text_cn: stringOrNull(p.footer_text_cn),
        footer_text_en: stringOrNull(p.footer_text_en),
        navigation_json: navItems,
      },
      expectedUpdatedAt,
    },
    { id: guard.user.id, email: guard.user.email, role: guard.profile.role },
  );

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/", "layout");
  return NextResponse.json({
    success: true,
    id: result.data.id,
    updatedAt: result.data.updatedAt,
  });
}
