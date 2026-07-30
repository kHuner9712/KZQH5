/**
 * Phase 15 (Section 7): Page content admin API.
 *   GET    /api/admin/pages           -> list all page_content rows
 *   POST   /api/admin/pages           -> create or update page_content
 *
 * Writes go through requireAdminWrite. The actual business write is
 * performed by save_page_content_with_audit RPC.
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
  listPageContent,
  savePageContent,
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
    return NextResponse.json({ success: true, demo: true, pages: [] });
  }

  const result = await listPageContent(guard.client);
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  return NextResponse.json({ success: true, pages: result.data });
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

  const result = await savePageContent(
    guard.client,
    {
      id,
      payload: {
        page_key: typeof p.page_key === "string" ? p.page_key : undefined,
        title_cn: stringOrNull(p.title_cn),
        title_en: stringOrNull(p.title_en),
        subtitle_cn: stringOrNull(p.subtitle_cn),
        subtitle_en: stringOrNull(p.subtitle_en),
        description_cn: stringOrNull(p.description_cn),
        description_en: stringOrNull(p.description_en),
        sections_cn: p.sections_cn,
        sections_en: p.sections_en,
        seo_title_cn: stringOrNull(p.seo_title_cn),
        seo_title_en: stringOrNull(p.seo_title_en),
        seo_description_cn: stringOrNull(p.seo_description_cn),
        seo_description_en: stringOrNull(p.seo_description_en),
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
  revalidatePath("/certificates", "page");
  revalidatePath("/contact", "page");
  revalidatePath("/products", "page");
  return NextResponse.json({
    success: true,
    id: result.data.id,
    updatedAt: result.data.updatedAt,
  });
}
