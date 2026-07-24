/**
 * 可信 Storage 删除路由
 *   DELETE /api/admin/storage/object
 *
 * 安全边界：
 *   - 使用 requireAdminWrite 统一边界（service_role 鉴权 + RBAC + 同源 Origin）
 *   - 强制 minimumRole: "admin"
 *   - 严格同源 Origin 检查（requireAdminWrite 内 isSameOrigin + isAllowedFetchSite）
 *   - 接受 JSON body { bucket: "public-assets" | "private-assets", path: string }
 *   - bucket 白名单（拒绝未知名）
 *   - 防 path traversal：路径必须为 {category}/{uuid}.{ext}（服务端生成格式）
 *   - 删除前调用 check_storage_object_referenced RPC，被引用则 409 拒绝
 *   - 使用 service_role 删除对应 bucket 的资源
 *   - fail-closed 审计 Saga（与上传对称）
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import {
  deletePrivateAsset,
  deletePublicAsset,
  isReferencedStorageObject,
} from "@/lib/services/storage-upload";

const MAX_BODY = 4 * 1024;

const ALLOWED_BUCKETS = new Set(["public-assets", "private-assets"]);

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
  const guard = await requireAdminWrite<{
    bucket?: unknown;
    path?: unknown;
  }>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const { bucket, path } = guard.body;

  // bucket 白名单：拒绝未知名，防止任意 bucket 删除
  if (typeof bucket !== "string" || !ALLOWED_BUCKETS.has(bucket)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  if (typeof path !== "string" || path.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true });
  }

  // 删除前引用检查：fail-closed。被任何业务表引用的对象拒绝删除，
  // 调用方必须先更新业务表（替换 URL 或删除行 + 入队清理）。
  // 这避免误删被引用对象导致前台图片 404。
  const refCheck = await isReferencedStorageObject(bucket, path);
  if (!refCheck.ok) {
    // 引用检查本身失败 → fail-closed，拒绝删除
    return adminWriteError(refCheck.code, statusForCode(refCheck.code), {
      logCode: "STORAGE_DELETE_REF_CHECK_FAILED",
    });
  }
  if (refCheck.referenced) {
    return adminWriteError("ADMIN_WRITE_CONFLICT", 409, {
      logCode: "STORAGE_DELETE_REFERENCED",
    });
  }

  // 按 bucket 分派：private-assets / public-assets 各自走严格路径校验 +
  // fail-closed 审计 Saga
  const result =
    bucket === "private-assets"
      ? await deletePrivateAsset(path, {
          actorId: guard.user.id,
          actorRole: guard.profile.role ?? null,
        })
      : await deletePublicAsset(path, {
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
