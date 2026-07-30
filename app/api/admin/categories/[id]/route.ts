/**
 * Categories [id] admin API (Section 7).
 *   PATCH   /api/admin/categories/[id]   -> toggle is_active (optimistic lock
 *                                            enforced by the save RPC)
 *   DELETE  /api/admin/categories/[id]   -> delete atomically (audit + cleanup
 *                                            enqueue for subcategories)
 *
 * Both require expectedUpdatedAt (optimistic lock). The PATCH handler loads
 * the current row server-side, flips is_active, and re-saves via the
 * transactional save_category_with_audit RPC so audit is atomic.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import {
  deleteCategory,
  saveCategory,
} from "@/lib/services/admin-content-write";
import type { Category } from "@/types/database";
import { UUID_PATTERN } from "@/lib/services/http-security";

const MAX_BODY = 64 * 1024;

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

/**
 * PATCH /api/admin/categories/[id]
 * Toggle is_active. Body: { "expectedUpdatedAt": string }
 *
 * The handler reads the current row (service_role) to obtain the full
 * payload + updated_at, then calls save_category_with_audit with the
 * flipped is_active. The save RPC's FOR UPDATE + updated_at comparison
 * provides optimistic-lock safety.
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

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      id,
      updatedAt: new Date().toISOString(),
    });
  }

  // Load current row server-side to build the full save payload.
  const { data: currentRow, error: readError } = await guard.client
    .from("categories")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (readError || !currentRow) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const current = currentRow as Category;

  const result = await saveCategory(
    guard.client,
    {
      id,
      payload: {
        name_cn: current.name_cn,
        name_en: current.name_en,
        slug: current.slug,
        description_cn: current.description_cn,
        description_en: current.description_en,
        sort_order: current.sort_order,
        is_active: !current.is_active,
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

/**
 * DELETE /api/admin/categories/[id]
 * Atomically delete the category + subcategories + audit + cleanup enqueue.
 * Body: { "expectedUpdatedAt": string }
 */
export async function DELETE(
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
    return NextResponse.json({ success: true, demo: true, id });
  }

  const result = await deleteCategory(
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
  revalidatePath("/products", "page");
  return NextResponse.json({ success: true, id: result.data.id });
}
