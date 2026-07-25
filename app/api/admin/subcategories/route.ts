/**
 * Subcategories admin API (Section 7).
 *   POST   /api/admin/subcategories   -> create or update a subcategory
 *
 * Writes go through requireAdminWrite. The actual business write is
 * performed by save_subcategory_with_audit RPC, which atomically writes
 * audit and enforces optimistic lock.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { saveSubcategory } from "@/lib/services/admin-content-write";

const MAX_BODY = 64 * 1024;

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

  const result = await saveSubcategory(
    guard.client,
    {
      id,
      payload: {
        category_id: typeof p.category_id === "string" ? p.category_id : "",
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
