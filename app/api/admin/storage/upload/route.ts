/**
 * 可信 Storage 上传路由
 *   POST /api/admin/storage/upload
 *
 * 安全边界：
 *   - 使用 requireAdminWrite 统一边界（service_role 鉴权 + RBAC + 同源 Origin）
 *   - 强制 minimumRole: "admin"
 *   - body: "skip" 模式跳过 JSON 解析，由本路由处理 multipart/form-data
 *     requireAdminWrite 内部对 Content-Length 做 fail-closed 校验：
 *       missing / NaN / 非有限 / 非正 / 超过 maxBytes → 立即 411/413
 *   - 严格同源 Origin 检查（requireAdminWrite 内 isSameOrigin + isAllowedFetchSite）
 *   - 服务端读取实际文件字节后做二次字节校验（防 Content-Length 伪造）
 *   - 服务端读取实际文件字节后交由 storage-upload 校验
 *     （Magic Bytes / MIME / 扩展名 / 按类型大小限制）
 *   - 路径由服务端生成 {category}/{uuid}.{ext}，客户端无法指定完整 Storage Path
 *
 * Purpose-driven 上传（唯一支持路径）：
 *   - 客户端只提交 `purpose`（如 "product-image" | "catalog-draft"）
 *   - 服务端依据 storage-purpose.ts 决定 bucket / category / MIME 白名单
 *   - 客户端提交 public / bucket / category / path 中任意一个一律 400 拒绝
 *     （防止绕过安全边界以 Legacy 模式自动决定公开性）
 *   - 任何额外未声明字段（除 purpose / file 外）一律 400 拒绝
 *   - private-assets 上传成功时不返回 publicUrl
 *
 * 抗滥用：
 *   - 显式 Node.js runtime（不使用 Edge runtime，避免 multipart 解析限制）
 *   - 按 admin actor 限流（getStorageUploadRateLimiter + actorId key）
 *   - 严格 Content-Length 校验（在 requireAdminWrite 内）
 *   - 实际字节二次校验（防 multipart 解码后实际大小超过声明）
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { getStorageUploadRateLimiter } from "@/lib/services/rate-limit";
import { uploadByPurpose } from "@/lib/services/storage-upload";
import { resolvePurposeConfig } from "@/lib/services/storage-purpose";

// 强制 Node.js runtime：multipart 解析需要完整 Node Buffer/Stream 支持，
// Edge runtime 不支持这些 API（且 storage-upload 使用 node:crypto 计算 SHA-256）。
export const runtime = "nodejs";

// 20MB 文件（PDF 上限）+ multipart 框架开销。按类型的实际限制在 storage-upload 内执行。
const MAX_REQUEST_BYTES = 21 * 1024 * 1024;

// 实际文件字节二次校验上限：multipart 解码后 FILE 字段的最大字节数。
// 与 MAX_REQUEST_BYTES 一致以容许 multipart 框架开销；per-MIME 限制在 storage-upload 内执行。
const MAX_FILE_BYTES = 20 * 1024 * 1024;

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
  // 统一边界：鉴权 + RBAC(admin) + 同源 Origin + 严格 Content-Length 校验
  // body: "skip" —— 不解析 JSON，不强制 Content-Type，由本路由处理 multipart。
  // requireAdminWrite 内部会立即拒绝 missing / NaN / 负数 / 0 / 超过上限的 Content-Length。
  const guard = await requireAdminWrite<unknown>(request, {
    maxBytes: MAX_REQUEST_BYTES,
    minimumRole: "admin",
    body: "skip",
  });
  if (!guard.ok) return guard.response;

  // 按 admin actor 限流。使用稳定的 actorId 作为 key（不依赖 IP）。
  // 注意：管理员是已认证用户，限流主要是防止脚本循环或会话劫持后的批量上传。
  const rateKey = `admin-upload:${guard.user.id}`;
  const rate = await getStorageUploadRateLimiter().check(rateKey);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "Cache-Control": "private, no-store",
        },
      },
    );
  }

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

  const purpose = form.get("purpose");
  const file = form.get("file");

  // 严格白名单：仅允许 purpose 与 file 两个字段。
  // 任何额外字段（包括未声明的 legacy 字段或未来扩展字段）一律 400 拒绝。
  // 这防止攻击者通过附加字段触发未定义行为或绕过 purpose-driven 边界。
  const allowedFields = new Set(["purpose", "file"]);
  for (const key of form.keys()) {
    if (!allowedFields.has(key)) {
      return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
    }
  }

  if (!(file instanceof File)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Purpose-driven 是唯一支持路径：客户端必须提交合法 purpose
  if (typeof purpose !== "string" || purpose.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const config = resolvePurposeConfig(purpose);
  if (!config) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (isDemoMode()) {
    const demoPath = `demo/${config.category}/${Date.now()}`;
    return NextResponse.json({
      success: true,
      demo: true,
      path: demoPath,
      bucket: config.bucket,
      ...(config.isPublicUrlAllowed
        ? {
            publicUrl: `${(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/public/${config.bucket}/${demoPath}`,
          }
        : {}),
    });
  }

  let bytes: Uint8Array;
  try {
    const ab = await file.arrayBuffer();
    bytes = new Uint8Array(ab);
  } catch {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // 实际字节二次校验（defense-in-depth）：
  // 即使 Content-Length 通过 requireAdminWrite 校验，multipart 解码后的
  // FILE 实际字节数可能因 multipart 框架开销略小于 CL。但如果 FILE 字节
  // 超过 MAX_FILE_BYTES，说明 Content-Length 伪造或 multipart 异常。
  // 此处拒绝以防止内存耗尽或绕过 per-MIME 限制前的资源消耗。
  if (bytes.length > MAX_FILE_BYTES) {
    return adminWriteError("ADMIN_WRITE_PAYLOAD_TOO_LARGE", 413);
  }

  const result = await uploadByPurpose(
    purpose,
    {
      bytes,
      mimeType: file.type,
      size: bytes.length,
      filename: file.name,
    },
    {
      actorId: guard.user.id,
      actorRole: guard.profile.role ?? null,
    },
  );
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code), {
      logCode: result.code,
    });
  }

  return NextResponse.json(
    {
      success: true,
      path: result.ref.path,
      bucket: result.ref.bucket,
      mimeType: result.ref.mimeType,
      size: result.ref.size,
      publicUrl: result.ref.publicUrl,
    },
    {
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
