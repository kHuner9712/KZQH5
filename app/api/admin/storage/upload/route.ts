/**
 * 可信 Storage 上传路由
 *   POST /api/admin/storage/upload
 *
 * 安全边界：
 *   - 使用 requireAdminWrite 统一边界（service_role 鉴权 + RBAC + 同源 Origin）
 *   - 强制 minimumRole: "admin"
 *   - body: "skip" 模式跳过 JSON 解析，由本路由处理 multipart/form-data
 *   - 严格同源 Origin 检查（requireAdminWrite 内 isSameOrigin + isAllowedFetchSite）
 *   - 服务端读取实际文件字节后交由 storage-upload 校验
 *     （Magic Bytes / MIME / 扩展名 / 按类型大小限制）
 *   - 路径由服务端生成 {category}/{uuid}.{ext}，客户端无法指定完整 Storage Path
 *   - 上传到 private-assets bucket（service_role）
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { uploadToPrivateAssets } from "@/lib/services/storage-upload";

// 20MB 文件（PDF 上限）+ multipart 框架开销。按类型的实际限制在 storage-upload 内执行。
const MAX_REQUEST_BYTES = 21 * 1024 * 1024;

function statusForCode(code: AdminWriteErrorCode): number {
  switch (code) {
    case "ADMIN_WRITE_BAD_REQUEST":
      return 400;
    case "ADMIN_WRITE_PAYLOAD_TOO_LARGE":
      return 413;
    case "ADMIN_WRITE_UNSUPPORTED_MEDIA":
      return 415;
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

export async function POST(request: NextRequest) {
  // 统一边界：鉴权 + RBAC(admin) + 同源 Origin + 粗粒度请求大小上限
  // body: "skip" —— 不解析 JSON，不强制 Content-Type，由本路由处理 multipart。
  const guard = await requireAdminWrite<unknown>(request, {
    maxBytes: MAX_REQUEST_BYTES,
    minimumRole: "admin",
    body: "skip",
  });
  if (!guard.ok) return guard.response;

  // 强制 multipart/form-data
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "multipart/form-data") {
    return adminWriteError("ADMIN_WRITE_UNSUPPORTED_MEDIA", 415);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const category = form.get("category");
  const file = form.get("file");
  if (
    typeof category !== "string" ||
    category.length === 0 ||
    !(file instanceof File)
  ) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      path: `demo/${category}/${Date.now()}`,
      bucket: "private-assets",
    });
  }

  // 服务端读取实际文件字节（Magic Bytes 校验依赖真实字节，而非 client 声明）
  let bytes: Uint8Array;
  try {
    const ab = await file.arrayBuffer();
    bytes = new Uint8Array(ab);
  } catch {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const result = await uploadToPrivateAssets({
    bytes,
    mimeType: file.type,
    size: bytes.length,
    filename: file.name,
    category,
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
    mimeType: result.mimeType,
    size: result.size,
  });
}
