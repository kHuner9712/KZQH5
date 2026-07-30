/**
 * Phase 2 admin product delete + copy-get endpoints.
 *
 *   GET    /api/admin/products/[id]   -> fetch a single product + its images
 *                                        (for the "copy product" flow)
 *   DELETE /api/admin/products/[id]   -> delete a single product
 *
 * GET uses getVerifiedAdmin() directly (no CSRF/body checks) but still
 * enforces RBAC (minimumRole "editor"). It queries via the service_role
 * client so drafts are readable — the anon client is RLS-filtered to
 * published rows and cannot be used to copy a draft.
 *
 * DELETE uses requireAdminWrite via a small body { id } so the same fail-closed
 * same-origin / Content-Type / size guards apply. The id in the path is
 * validated as a UUID; the body id must match.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  requireAdminWrite,
  requireAdminRead,
  adminWriteError,
} from "@/lib/services/admin-write-boundary";
import { bulkDeleteProducts } from "@/lib/services/admin-product-write";
import { isUuid } from "@/lib/validation/admin-write";
import type { Product, ProductImage } from "@/types/database";

export const dynamic = "force-dynamic";

const MAX_BODY = 4 * 1024;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }

  // Phase 9: requireAdminRead enforces auth + global/per-admin rate limit +
  // RBAC(minimum editor) + CSRF (isSameSiteRequest for GET).
  const guard = await requireAdminRead(request, { minimumRole: "editor" });
  if (!guard.ok) return guard.response;

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      product: null,
      images: [],
    }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const [prodRes, imgsRes] = await Promise.all([
    guard.client.from("products").select("*").eq("id", id).single(),
    guard.client
      .from("product_images")
      .select("*")
      .eq("product_id", id)
      .order("sort_order", { ascending: true }),
  ]);

  return NextResponse.json(
    {
      success: true,
      product: (prodRes.data as Product | null) || null,
      images: (imgsRes.data as ProductImage[] | null) || [],
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id: pathId } = await context.params;
  if (!isUuid(pathId)) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }

  const guard = await requireAdminWrite<{ id?: string; ids?: string[] }>(
    request,
    {
      maxBytes: MAX_BODY,
      minimumRole: "admin",
    },
  );
  if (!guard.ok) return guard.response;

  // Allow either { id } (single) or { ids: [id, ...] } (bulk). All ids must
  // be valid UUIDs; the path id must be included in the batch when present.
  const ids: string[] = [];
  if (Array.isArray(guard.body.ids)) {
    const valid = guard.body.ids.filter(isUuid);
    if (valid.length !== guard.body.ids.length) {
      return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
    }
    ids.push(...valid);
  } else if (typeof guard.body.id === "string" && isUuid(guard.body.id)) {
    ids.push(guard.body.id);
  }
  if (ids.length === 0) ids.push(pathId);
  if (!ids.includes(pathId)) ids.push(pathId);

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true, count: ids.length });
  }

  const result = await bulkDeleteProducts(guard.client, ids, {
    id: guard.user.id,
    email: guard.user.email,
    role: guard.profile.role,
  });
  if (!result.ok) {
    const status = result.code === "ADMIN_WRITE_BAD_REQUEST" ? 400 : 500;
    return adminWriteError(result.code, status, { logCode: result.code });
  }

  // Phase 13: audit is now atomic with the business write via RPC.

  revalidatePath("/admin", "layout");
  revalidatePath("/products", "page");
  return NextResponse.json({ success: true, count: result.count });
}
