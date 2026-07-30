/**
 * Phase 15 (Section 7): Admin project delete + editor get endpoints.
 *
 *   GET    /api/admin/projects/[id]  -> fetch project + images + product relations for the editor
 *   DELETE /api/admin/projects/[id]  -> delete a project atomically (cleanup enqueue + audit)
 *
 * DELETE uses requireAdminWrite via a small body { expectedUpdatedAt } so
 * the same fail-closed same-origin / Content-Type / size guards apply.
 * The id in the path is validated as a UUID; the body must include
 * expectedUpdatedAt for optimistic lock.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import { requireAdminWrite, requireAdminRead, adminWriteError } from "@/lib/services/admin-write-boundary";
import { deleteProjectViaRpc, getProjectForEditor } from "@/lib/services/admin-project-write";
import { isUuid } from "@/lib/validation/admin-write";

const MAX_BODY = 4 * 1024;

function failStatus(code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_CONFLICT" | "ADMIN_WRITE_FAILED"): number {
  if (code === "ADMIN_WRITE_BAD_REQUEST") return 400;
  if (code === "ADMIN_WRITE_CONFLICT") return 409;
  return 500;
}

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
      project: null,
      images: [],
      products: [],
    });
  }

  const result = await getProjectForEditor(guard.client, id);
  if (!result.ok) {
    return adminWriteError(result.code, failStatus(result.code));
  }

  return NextResponse.json({
    success: true,
    project: result.project,
    images: result.images,
    products: result.products,
  });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id: pathId } = await context.params;
  if (!isUuid(pathId)) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }

  const guard = await requireAdminWrite<{ expectedUpdatedAt?: string }>(
    request,
    {
      maxBytes: MAX_BODY,
      minimumRole: "admin",
    },
  );
  if (!guard.ok) return guard.response;

  const expectedUpdatedAt = guard.body.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length === 0) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true, id: pathId });
  }

  const result = await deleteProjectViaRpc(
    guard.client,
    { id: pathId, expectedUpdatedAt },
    {
      id: guard.user.id,
      email: guard.user.email,
      role: guard.profile.role,
    },
  );
  if (!result.ok) {
    return adminWriteError(result.code, failStatus(result.code), { logCode: result.code });
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/projects", "page");
  return NextResponse.json({ success: true, id: result.id });
}
