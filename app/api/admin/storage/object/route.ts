/**
 * 可信 Storage 删除路由
 *   DELETE /api/admin/storage/object
 *
 * 安全边界：
 *   - 使用 requireAdminWrite 统一边界（service_role 鉴权 + RBAC + 同源 Origin）
 *   - 强制 minimumRole: "admin"
 *   - 严格同源 Origin 检查（requireAdminWrite 内 isSameOrigin + isAllowedFetchSite）
 *   - 接受 JSON body { path: string }
 *   - 防 path traversal：路径必须为 {category}/{uuid}.{ext}（服务端生成格式）
 *   - 使用 service_role 删除 private-assets 中的资源
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { deletePrivateAsset } from "@/lib/services/storage-upload";

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

export async function DELETE(request: NextRequest) {
  // 统一边界：鉴权 + RBAC(admin) + 同源 Origin + JSON Content-Type + 大小上限
  const guard = await requireAdminWrite<{ path?: unknown }>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const { path } = guard.body;
  if (typeof path !== "string" || path.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true });
  }

  const result = await deletePrivateAsset(path, {
    actorId: guard.user.id,
    actorRole: guard.profile.role ?? null,
  });
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code), {
      logCode: result.code,
    });
  }

  return NextResponse.json({
    success: true,
    path: result.path,
    bucket: result.bucket,
  });
}
