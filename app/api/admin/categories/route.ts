/**
 * Phase 15 (Section 7): Categories admin API.
 *   GET    /api/admin/categories           -> list categories + subcategories
 *   POST   /api/admin/categories           -> create or update a category
 *   PATCH  /api/admin/categories           -> toggle category active state
 *   DELETE /api/admin/categories/[id]      -> delete a category
 *
 * Writes go through requireAdminWrite. The actual business write is
 * performed by save_category_with_audit / delete_category_with_audit
 * RPCs, which atomically write audit and enforce optimistic lock.
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
  deleteCategory,
  listCategories,
  listSubcategories,
  saveCategory,
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
    return NextResponse.json({
      success: true,
      demo: true,
      categories: [],
      subcategories: [],
    });
  }

  const [catsResult, subsResult] = await Promise.all([
    listCategories(guard.client),
    listSubcategories(guard.client),
  ]);
  if (!catsResult.ok) {
    return adminWriteError(catsResult.code, statusForCode(catsResult.code));
  }
  if (!subsResult.ok) {
    return adminWriteError(subsResult.code, statusForCode(subsResult.code));
  }

  return NextResponse.json({
    success: true,
    categories: catsResult.data,
    subcategories: subsResult.data,
  });
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

  const result = await saveCategory(
    guard.client,
    {
      id,
      payload: {
        name_cn: typeof p.name_cn === "string" ? p.name_cn : "",
        name_en: typeof p.name_en === "string" ? p.name_en : null,
        slug: typeof p.slug === "string" ? p.slug : "",
        description_cn: typeof p.description_cn === "string" ? p.description_cn : null,
        description_en: typeof p.description_en === "string" ? p.description_en : null,
        sort_order: typeof p.sort_order === "number" ? p.sort_order : 0,
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
  revalidatePath("/products", "page");
  return NextResponse.json({
    success: true,
    id: result.data.id,
    updatedAt: result.data.updatedAt,
  });
}
