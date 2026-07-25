/**
 * Phase 15 (Section 7): Admin project write endpoints.
 *
 *   GET    /api/admin/projects          -> list all projects + products for picker
 *   POST   /api/admin/projects          -> create or update a project (+ images + product relations)
 *
 * Both write operations go through requireAdminWrite():
 *   1. service_role admin verification (getVerifiedAdmin)
 *   2. fail-closed same-origin check
 *   3. application/json Content-Type
 *   4. 256KB max body
 *   5. JSON parse
 *
 * The project payload is then validated by validateProjectPayload() and
 * persisted via the transactional save_project_with_relations_and_audit
 * RPC, which inserts/updates the project, replaces its images + product
 * associations, enqueues removed storage objects for cleanup, and writes
 * audit — all in a single transaction. Any partial failure rolls back
 * the entire operation.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import { requireAdminWrite, adminWriteError } from "@/lib/services/admin-write-boundary";
import {
  listAllProductsForProjectPicker,
  listAllProjects,
  saveProjectViaRpc,
  validateProjectPayload,
} from "@/lib/services/admin-project-write";

const MAX_BODY = 256 * 1024;

function failStatus(code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_CONFLICT" | "ADMIN_WRITE_FAILED"): number {
  if (code === "ADMIN_WRITE_BAD_REQUEST") return 400;
  if (code === "ADMIN_WRITE_CONFLICT") return 409;
  return 500;
}

export async function GET() {
  // GET also requires admin verification — but uses getVerifiedAdmin
  // directly since requireAdminWrite is for write operations.
  // We reuse the same boundary by sending a no-op POST-like check.
  // Simpler: use the same admin auth path inline.
  const { getVerifiedAdmin } = await import("@/lib/services/admin-auth");
  const admin = await getVerifiedAdmin();
  if (!admin.ok) {
    return adminWriteError("ADMIN_WRITE_UNAUTHORIZED", 401);
  }

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      projects: [],
      products: [],
    });
  }

  const [projectsResult, productsResult] = await Promise.all([
    listAllProjects(admin.client),
    listAllProductsForProjectPicker(admin.client),
  ]);
  if (!projectsResult.ok) {
    return adminWriteError(projectsResult.code, failStatus(projectsResult.code));
  }
  if (!productsResult.ok) {
    return adminWriteError(productsResult.code, failStatus(productsResult.code));
  }

  return NextResponse.json({
    success: true,
    projects: projectsResult.projects,
    products: productsResult.products,
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<unknown>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const validated = validateProjectPayload(guard.body);
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

  const result = await saveProjectViaRpc(guard.client, validated.value, {
    id: guard.user.id,
    email: guard.user.email,
    role: guard.profile.role,
  });
  if (!result.ok) {
    return adminWriteError(result.code, failStatus(result.code), { logCode: result.code });
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/projects", "page");
  revalidatePath("/", "page");
  return NextResponse.json({ success: true, id: result.id });
}
