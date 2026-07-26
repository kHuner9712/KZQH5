/**
 * Product Asset authorize API (Section 4).
 *   POST /api/admin/product-assets/[id]/authorize
 *
 * Marks authorization_status='confirmed' via a DEDICATED server-side
 * RPC (authorize_product_asset). This is NOT a generic PATCH — the
 * authorization flag can only be set by this dedicated command with
 * atomic audit. A browser checkbox mapping directly to the column is
 * not permitted.
 *
 * Body:
 *   { "expectedUpdatedAt": string }  // required (optimistic lock)
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { authorizeProductAsset } from "@/lib/services/admin-product-asset-write";

const MAX_BODY = 4 * 1024;

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
    case "ADMIN_WRITE_CONFLICT":
      return 409;
    default:
      return 500;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

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

  const result = await authorizeProductAsset(
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
  return NextResponse.json({
    success: true,
    id: result.data.id,
    updatedAt: result.data.updatedAt,
  });
}
