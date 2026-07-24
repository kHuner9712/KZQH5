/**
 * Phase 2 admin product delete endpoint.
 *
 *   DELETE /api/admin/products/[id]   -> delete a single product
 *
 * Uses requireAdminWrite via a small body { id } so the same fail-closed
 * same-origin / Content-Type / size guards apply. The id in the path is
 * validated as a UUID; the body id must match.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import { requireAdminWrite, adminWriteError } from "@/lib/services/admin-write-boundary";
import { logAdminAction } from "@/lib/services/admin-audit";
import { bulkDeleteProducts } from "@/lib/services/admin-product-write";
import { isUuid } from "@/lib/validation/admin-write";

const MAX_BODY = 4 * 1024;

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
    MAX_BODY,
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

  const result = await bulkDeleteProducts(guard.client, ids);
  if (!result.ok) {
    const status = result.code === "ADMIN_WRITE_BAD_REQUEST" ? 400 : 500;
    return adminWriteError(result.code, status, { logCode: result.code });
  }

  // Phase 3: audit log (best-effort, never blocks the response).
  void logAdminAction(guard.client, {
    id: guard.user.id,
    email: guard.user.email,
    role: guard.profile.role,
  }, {
    action: "product.delete",
    targetType: "product",
    targetId: ids.join(","),
    summary: `Deleted ${ids.length} product(s)`,
  });

  revalidatePath("/admin", "layout");
  revalidatePath("/products", "page");
  return NextResponse.json({ success: true, count: result.count });
}
