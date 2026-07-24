/**
 * Phase 2 admin product write endpoints.
 *
 *   POST   /api/admin/products          -> create or update a product (+ images)
 *   PATCH  /api/admin/products          -> bulk update (publish/feature/category)
 *
 * Both endpoints go through requireAdminWrite():
 *   1. service_role admin verification (getVerifiedAdmin)
 *   2. fail-closed same-origin check
 *   3. application/json Content-Type
 *   4. 256KB max body
 *   5. JSON parse
 *
 * The product payload is then validated by validateProductPayload() and
 * persisted via the transactional save_product_with_images RPC, which
 * inserts/updates the product and replaces its images in a single
 * transaction. Partial image failure rolls back the product save.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import { requireAdminWrite, adminWriteError } from "@/lib/services/admin-write-boundary";
import {
  bulkUpdateProducts,
  saveProductViaRpc,
  validateProductPayload,
} from "@/lib/services/admin-product-write";
import { isUuid, validateOptionalUuid } from "@/lib/validation/admin-write";

const MAX_BODY = 256 * 1024;

function failStatus(code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_CONFLICT" | "ADMIN_WRITE_FAILED"): number {
  if (code === "ADMIN_WRITE_BAD_REQUEST") return 400;
  if (code === "ADMIN_WRITE_CONFLICT") return 409;
  return 500;
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<unknown>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const validated = validateProductPayload(guard.body);
  if (!validated.ok) {
    return NextResponse.json(
      { error: "ADMIN_WRITE_BAD_REQUEST", fields: validated.errors },
      { status: 400 },
    );
  }

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      id: validated.value.id ?? `demo-${Date.now()}`,
    });
  }

  const result = await saveProductViaRpc(guard.client, validated.value, {
    id: guard.user.id,
    email: guard.user.email,
    role: guard.profile.role,
  });
  if (!result.ok) {
    return adminWriteError(result.code, failStatus(result.code), { logCode: result.code });
  }

  // Phase 13: audit is now atomic with the business write via RPC.
  // No fire-and-forget logAdminAction call needed.

  revalidatePath("/admin", "layout");
  revalidatePath("/products", "page");
  revalidatePath("/", "page");
  return NextResponse.json({ success: true, id: result.id });
}

export async function PATCH(request: NextRequest) {
  const guard = await requireAdminWrite<unknown>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body as Record<string, unknown>;
  const idsRaw = body.ids;
  if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }
  const ids = idsRaw.filter(isUuid);
  if (ids.length !== idsRaw.length) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }

  // Build a whitelisted patch. Only is_published / is_featured / category_id
  // / subcategory_id are accepted in bulk mode.
  const patch: Record<string, unknown> = {};
  if (typeof body.is_published === "boolean") patch.is_published = body.is_published;
  if (typeof body.is_featured === "boolean") patch.is_featured = body.is_featured;
  if (body.category_id !== undefined) {
    const cat = validateOptionalUuid("category_id", body.category_id);
    if (!cat.ok) {
      return NextResponse.json(
        { error: "ADMIN_WRITE_BAD_REQUEST", fields: cat.errors },
        { status: 400 },
      );
    }
    patch.category_id = cat.value;
  }
  if (body.subcategory_id !== undefined) {
    const sub = validateOptionalUuid("subcategory_id", body.subcategory_id);
    if (!sub.ok) {
      return NextResponse.json(
        { error: "ADMIN_WRITE_BAD_REQUEST", fields: sub.errors },
        { status: 400 },
      );
    }
    patch.subcategory_id = sub.value;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true, count: ids.length });
  }

  const result = await bulkUpdateProducts(guard.client, ids, patch, {
    id: guard.user.id,
    email: guard.user.email,
    role: guard.profile.role,
  });
  if (!result.ok) {
    return adminWriteError(result.code, failStatus(result.code), { logCode: result.code });
  }

  // Phase 13: audit is now atomic with the business write via RPC.

  revalidatePath("/admin", "layout");
  revalidatePath("/products", "page");
  return NextResponse.json({ success: true, count: result.count });
}
