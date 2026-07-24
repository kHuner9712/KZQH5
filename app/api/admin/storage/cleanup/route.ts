/**
 * 可信 Storage 清理队列入队路由
 *   POST /api/admin/storage/cleanup
 *
 * 安全边界：
 *   - 使用 requireAdminWrite 统一边界（service_role 鉴权 + RBAC + 同源 Origin）
 *   - 强制 minimumRole: "admin"
 *   - 接受 JSON body { bucket, objectPath, reason, sourceType?, sourceId? }
 *   - 调用 enqueue_storage_cleanup RPC（service_role only，幂等）
 *
 * 设计：
 *   - 客户端不直接调用 service_role，必须经此路由
 *   - 入队是幂等的：相同 (bucket, object_path) 已有 pending/retry/claimed 行时返回成功
 *   - 调用方必须先更新业务表（清除引用），否则 dispatcher 重新检查引用时会拒绝删除
 *   - dispatcher 尚未部署（BLOCK），入队后对象由后续 dispatcher 异步清理
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { enqueueStorageCleanup } from "@/lib/services/storage-upload";

const MAX_BODY = 2 * 1024;

const ALLOWED_BUCKETS = new Set(["public-assets", "private-assets"]);
const ALLOWED_REASONS = new Set([
  "form_cancelled",
  "replaced",
  "row_deleted",
  "orphan_detected",
]);

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

interface CleanupRequestBody {
  bucket?: unknown;
  objectPath?: unknown;
  reason?: unknown;
  sourceType?: unknown;
  sourceId?: unknown;
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<CleanupRequestBody>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const { bucket, objectPath, reason, sourceType, sourceId } = guard.body;

  // 参数校验：bucket + objectPath + reason 必填且白名单
  if (
    typeof bucket !== "string" ||
    !ALLOWED_BUCKETS.has(bucket) ||
    typeof objectPath !== "string" ||
    objectPath.length === 0 ||
    typeof reason !== "string" ||
    !ALLOWED_REASONS.has(reason)
  ) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // sourceType / sourceId 可选；类型与长度校验
  const safeSourceType =
    typeof sourceType === "string" && sourceType.length <= 64
      ? sourceType
      : null;
  const safeSourceId =
    typeof sourceId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sourceId,
    )
      ? sourceId
      : null;

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true, cleanupId: null });
  }

  const result = await enqueueStorageCleanup({
    bucket,
    objectPath,
    reason: reason as
      | "form_cancelled"
      | "replaced"
      | "row_deleted"
      | "orphan_detected",
    sourceType: safeSourceType,
    sourceId: safeSourceId,
  });

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code), {
      logCode: result.code,
    });
  }

  return NextResponse.json({
    success: true,
    cleanupId: result.cleanupId,
  });
}
