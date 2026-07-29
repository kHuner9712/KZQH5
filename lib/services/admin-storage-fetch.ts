// ============================================================
// 客户端 Storage 上传/删除/预览 fetch 包装
// ------------------------------------------------------------
// 后台 Client Component 不再直接调用 createBrowserSupabaseClient().storage
// 上传/删除，而是通过可信服务端 API（/api/admin/storage/*）。
// 服务端路由负责 service_role 鉴权、RBAC、同源校验、Magic Bytes / MIME /
// 大小校验、路径生成与 path traversal 防御。客户端只接收粗粒度结果。
//
// 上传：POST /api/admin/storage/upload  (multipart/form-data, purpose-driven)
// 删除：DELETE /api/admin/storage/object (JSON { bucket, path })
// 预览：POST /api/admin/storage/preview  (JSON { bucket, path }) → 短期签名 URL
// 清理：POST /api/admin/storage/cleanup  (JSON { bucket, objectPath, reason })
//
// Purpose-driven 上传（唯一支持路径）：
//   - 客户端只提交 `purpose`（如 "product-image" | "catalog-draft"）
//   - 服务端依据 purpose 决定 bucket / category / MIME 白名单
//   - 客户端无法提交 public / bucket / category / path（一律 400）
//   - private-assets 上传成功时不返回 publicUrl（组件不得视为失败）
//
// 错误一律返回粗粒度文案（"上传失败" / "删除失败"），
// 永不透传服务端内部错误、SQLSTATE 或 Supabase 错误载荷。
// ============================================================

import type { StoragePurpose } from "@/lib/services/storage-purpose";

/**
 * 客户端统一的 Storage 对象引用类型。
 *
 * 与服务端 StorageObjectRef 对齐。public-assets 携带 publicUrl；
 * private-assets 的 publicUrl 为 null，需要通过 previewUrl 预览。
 *
 * 裸 URL（string）只能作为业务表历史字段的兼容表示；新对象必须以
 * StorageObjectRef 完整携带 bucket + path，便于后续清理与替换。
 */
export interface StorageObjectRef {
  /** 实际写入的 bucket（public-assets 或 private-assets）。 */
  bucket: "public-assets" | "private-assets";
  /** 服务端生成的存储路径 {category}[/{sub}]/{uuid}.{ext}。 */
  path: string;
  /**
   * public-assets 的公开 URL；private-assets 返回 null。
   * private-assets 必须通过 previewUrl（短期签名 URL）预览，
   * 不得强行构造公开 URL。
   */
  publicUrl: string | null;
  /**
   * 短期签名预览 URL（仅 private-assets 适用）。
   * 由 /api/admin/storage/preview 在管理员身份验证后签发。
   * 有效期短（默认 60s），过期后需重新签发。
   * public-assets 一律为 null（已有 publicUrl）。
   */
  previewUrl: string | null;
  /** 校验后的 MIME 类型。 */
  mimeType: string;
  /** 文件大小（字节）。 */
  size: number;
}

/** 服务端上传响应体（公开字段，不含内部细节）。 */
interface ServerUploadResponse {
  success?: boolean;
  path?: unknown;
  bucket?: unknown;
  mimeType?: unknown;
  size?: unknown;
  publicUrl?: unknown;
  demo?: boolean;
}

/** 服务端预览响应体。 */
interface ServerPreviewResponse {
  success?: boolean;
  previewUrl?: unknown;
  expiresIn?: unknown;
  demo?: boolean;
}

/** 服务端清理入队响应体。 */
interface ServerCleanupResponse {
  success?: boolean;
  cleanupId?: string | null;
}

const PUBLIC_ASSETS_BUCKET = "public-assets";
const PRIVATE_ASSETS_BUCKET = "private-assets";

/** 按 bucket + path 兜底构造 public-assets 公开 URL。 */
function buildPublicAssetsUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${PUBLIC_ASSETS_BUCKET}/${path}`;
}

function isBucket(value: unknown): value is "public-assets" | "private-assets" {
  return value === PUBLIC_ASSETS_BUCKET || value === PRIVATE_ASSETS_BUCKET;
}

/**
 * 通过可信服务端 API 上传文件（Purpose-driven，唯一支持路径）。
 *
 * 客户端只提交 purpose，服务端依据 storage-purpose.ts 决定 bucket / category /
 * MIME 白名单。客户端无法提交 bucket / public / category / path，任何此类字段
 * 一律被服务端 400 拒绝（防止绕过安全边界）。
 *
 * private-assets 上传成功时 publicUrl 为 null —— 调用方不得将其视为失败。
 * 需要预览 private-assets 时应调用 fetchPrivatePreviewUrl() 获取短期签名 URL。
 *
 * @param file     浏览器 File 对象
 * @param purpose  Storage 用途（如 "product-image" | "catalog-draft"）
 */
export async function uploadViaServerApi(
  file: File,
  purpose: StoragePurpose,
): Promise<{ ok: true; data: StorageObjectRef } | { ok: false; error: string }> {
  try {
    const formData = new FormData();
    formData.append("purpose", purpose);
    formData.append("file", file);

    const res = await fetch("/api/admin/storage/upload", {
      method: "POST",
      body: formData,
      credentials: "same-origin",
    });

    if (!res.ok) {
      return { ok: false, error: "上传失败" };
    }

    const json = (await res.json()) as ServerUploadResponse;

    if (
      !json.success ||
      typeof json.path !== "string" ||
      !isBucket(json.bucket)
    ) {
      return { ok: false, error: "上传失败" };
    }

    const path = json.path;
    const bucket = json.bucket;

    // publicUrl：优先服务端返回值；缺失且为 public-assets 时按公式兜底构造；
    // private-assets 一律 null（不得自行构造公开 URL）。
    const publicUrl =
      typeof json.publicUrl === "string"
        ? json.publicUrl
        : bucket === PUBLIC_ASSETS_BUCKET
          ? buildPublicAssetsUrl(path)
          : null;

    return {
      ok: true,
      data: {
        bucket,
        path,
        mimeType:
          typeof json.mimeType === "string" ? json.mimeType : file.type,
        size: typeof json.size === "number" ? json.size : file.size,
        publicUrl,
        // private-assets 需要后续显式调用 fetchPrivatePreviewUrl 获取签名 URL
        previewUrl: null,
      },
    };
  } catch {
    return { ok: false, error: "上传失败" };
  }
}

/**
 * 通过可信服务端 API 为 private-assets 对象获取短期签名预览 URL。
 *
 * 仅 private-assets 需要（public-assets 已有 publicUrl）。返回的 URL 有效期短
 * （默认 60s），调用方应缓存结果并在过期前重新签发。
 *
 * @param path private-assets 中服务端生成的路径 {category}/{uuid}.{ext}
 */
export async function fetchPrivatePreviewUrl(
  path: string,
): Promise<
  | { ok: true; previewUrl: string; expiresIn: number }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch("/api/admin/storage/preview", {
      method: "POST",
      body: JSON.stringify({ bucket: PRIVATE_ASSETS_BUCKET, path }),
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    });

    if (!res.ok) {
      return { ok: false, error: "预览签发失败" };
    }

    const json = (await res.json()) as ServerPreviewResponse;
    if (
      !json.success ||
      typeof json.previewUrl !== "string" ||
      typeof json.expiresIn !== "number"
    ) {
      return { ok: false, error: "预览签发失败" };
    }

    return {
      ok: true,
      previewUrl: json.previewUrl,
      expiresIn: json.expiresIn,
    };
  } catch {
    return { ok: false, error: "预览签发失败" };
  }
}

/**
 * 通过可信服务端 API 删除 Storage 对象（引用检查 + fail-closed 审计）。
 *
 * 服务端在删除前调用 check_storage_object_referenced RPC，
 * 被任何业务表引用的对象会以 409 拒绝；调用方必须先更新业务表
 * （替换 URL 或删除行 + 入队清理）。
 *
 * @param bucket  Storage bucket（"public-assets" | "private-assets"）
 * @param path    服务端生成的存储路径 {category}/{uuid}.{ext}
 */
export async function deleteViaServerApi(
  bucket: "public-assets" | "private-assets",
  path: string,
): Promise<{ ok: true } | { ok: false; error: string; referenced?: boolean }> {
  try {
    const res = await fetch("/api/admin/storage/object", {
      method: "DELETE",
      body: JSON.stringify({ bucket, path }),
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    });

    if (!res.ok) {
      // 409 = 被引用拒绝；调用方可据此提示用户先替换或删除业务行
      if (res.status === 409) {
        return { ok: false, error: "对象被业务数据引用，无法删除", referenced: true };
      }
      return { ok: false, error: "删除失败" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "删除失败" };
  }
}

/**
 * 通过可信服务端 API 将 Storage 对象入队到清理队列。
 *
 * 使用场景：
 *   - 表单取消上传（本次新上传但未保存到 DB）→ reason: "form_cancelled"
 *   - 表单替换图片（旧对象已被新对象替换）→ reason: "replaced"
 *   - 业务表行删除后清理关联对象 → reason: "row_deleted"
 *
 * 入队是幂等的：若 (bucket, object_path) 已有 pending/retry/claimed 行，
 * 服务端返回成功但不创建新行。
 *
 * 注意：调用方在入队前必须先更新业务表（清除引用），否则 dispatcher
 * 重新检查引用时会因引用仍存在而拒绝删除。
 */
export async function enqueueCleanupViaServerApi(input: {
  bucket: "public-assets" | "private-assets";
  objectPath: string;
  reason: "form_cancelled" | "replaced" | "row_deleted" | "orphan_detected";
  sourceType?: string | null;
  sourceId?: string | null;
}): Promise<{ ok: true; cleanupId: string | null } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/admin/storage/cleanup", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    });

    if (!res.ok) {
      return { ok: false, error: "入队失败" };
    }

    const json = (await res.json()) as ServerCleanupResponse;
    if (!json.success) {
      return { ok: false, error: "入队失败" };
    }
    return { ok: true, cleanupId: json.cleanupId ?? null };
  } catch {
    return { ok: false, error: "入队失败" };
  }
}

// ============================================================
// 两阶段大文件上传（Phase 4）
// ------------------------------------------------------------
// 客户端直传 Supabase Storage，绕过 EdgeOne 6MB 平台请求体限制。
//
// 流程：
//   1. requestUploadAuthorization(file, purpose)
//      → POST /api/admin/storage/upload/authorize
//      → 返回 { uploadToken, signedUrl, headers, expiresAt }
//   2. uploadDirectToStorage(signedUrl, file, headers)
//      → PUT 直传到 Supabase Storage（跨域请求）
//   3. finalizeUpload(uploadToken)
//      → POST /api/admin/storage/upload/finalize
//      → 返回 StorageObjectRef
//
// 优势：
//   - 绕过 EdgeOne 6MB 平台限制，支持最大 20MB PDF
//   - 服务端不缓冲文件字节，降低内存压力
//   - 服务端仍执行 Magic Bytes / MIME / 大小验证（finalize 阶段）
//
// 前提条件（部署侧）：
//   - Supabase Storage bucket 必须配置 CORS 允许浏览器 PUT
//   - 详见 docs/TWO_PHASE_UPLOAD_DESIGN.md 第 4.1 节
// ============================================================

/** /authorize 响应体。 */
interface AuthorizeResponse {
  uploadToken?: unknown;
  signedUrl?: unknown;
  expiresAt?: unknown;
  method?: unknown;
  headers?: unknown;
}

/** /finalize 响应体。 */
interface FinalizeResponse {
  bucket?: unknown;
  path?: unknown;
  publicUrl?: unknown;
  mimeType?: unknown;
  size?: unknown;
}

/**
 * Phase 1: 请求上传授权。
 *
 * 客户端提交 purpose + filename + mimeType + size，服务端验证后
 * 返回短期签名上传 URL（指向 private-assets/temp/{token}/{filename}）。
 *
 * @param file     浏览器 File 对象
 * @param purpose  Storage 用途
 */
export async function requestUploadAuthorization(
  file: File,
  purpose: StoragePurpose,
): Promise<
  | { ok: true; uploadToken: string; signedUrl: string; headers: Record<string, string> }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch("/api/admin/storage/upload/authorize", {
      method: "POST",
      body: JSON.stringify({
        purpose,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
      }),
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    });

    if (!res.ok) {
      return { ok: false, error: "上传授权失败" };
    }

    const json = (await res.json()) as AuthorizeResponse;

    if (
      typeof json.uploadToken !== "string" ||
      typeof json.signedUrl !== "string"
    ) {
      return { ok: false, error: "上传授权失败" };
    }

    const headers =
      typeof json.headers === "object" && json.headers !== null
        ? (json.headers as Record<string, string>)
        : {};

    return {
      ok: true,
      uploadToken: json.uploadToken,
      signedUrl: json.signedUrl,
      headers,
    };
  } catch {
    return { ok: false, error: "上传授权失败" };
  }
}

/**
 * Phase 2: 直传文件到 Supabase Storage。
 *
 * 使用签名上传 URL 直接 PUT 文件到 Supabase Storage，不经过
 * 应用服务器，绕过 EdgeOne 6MB 平台限制。
 *
 * 需要 Supabase Storage bucket 配置 CORS 允许浏览器 PUT。
 *
 * @param signedUrl  /authorize 返回的签名上传 URL
 * @param file       浏览器 File 对象
 * @param headers    /authorize 返回的请求头
 */
export async function uploadDirectToStorage(
  signedUrl: string,
  file: File,
  headers: Record<string, string>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // 直接 PUT 到 Supabase Storage（跨域请求）
    const res = await fetch(signedUrl, {
      method: "PUT",
      body: file,
      headers: {
        ...headers,
        "Content-Type": file.type,
      },
      // 不携带 credentials —— 签名 URL 自带认证
      credentials: "omit",
      mode: "cors",
    });

    if (!res.ok) {
      return { ok: false, error: "直传失败" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "直传失败" };
  }
}

/**
 * Phase 3: 确认上传完成。
 *
 * 通知服务端验证已上传的对象（HEAD + Magic Bytes），并将其从
 * temp/ 移动到最终路径。返回完整的 StorageObjectRef。
 *
 * @param uploadToken  /authorize 返回的 uploadToken
 */
export async function finalizeUpload(
  uploadToken: string,
): Promise<{ ok: true; data: StorageObjectRef } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/admin/storage/upload/finalize", {
      method: "POST",
      body: JSON.stringify({ uploadToken }),
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    });

    if (!res.ok) {
      return { ok: false, error: "上传确认失败" };
    }

    const json = (await res.json()) as FinalizeResponse;

    if (
      typeof json.path !== "string" ||
      !isBucket(json.bucket)
    ) {
      return { ok: false, error: "上传确认失败" };
    }

    const path = json.path;
    const bucket = json.bucket;

    const publicUrl =
      typeof json.publicUrl === "string"
        ? json.publicUrl
        : bucket === PUBLIC_ASSETS_BUCKET
          ? buildPublicAssetsUrl(path)
          : null;

    return {
      ok: true,
      data: {
        bucket,
        path,
        mimeType:
          typeof json.mimeType === "string" ? json.mimeType : "",
        size: typeof json.size === "number" ? json.size : 0,
        publicUrl,
        previewUrl: null,
      },
    };
  } catch {
    return { ok: false, error: "上传确认失败" };
  }
}

/**
 * 两阶段上传完整流程（authorize → direct PUT → finalize）。
 *
 * 这是客户端调用的推荐入口。内部依次调用：
 *   1. requestUploadAuthorization
 *   2. uploadDirectToStorage
 *   3. finalizeUpload
 *
 * 任何一步失败都会立即返回错误。若 Phase 2（直传）成功但
 * Phase 3（finalize）失败，temp 对象会留在 private-assets/temp/
 * 下，由 cleanup dispatcher 自动清理。
 *
 * @param file     浏览器 File 对象
 * @param purpose  Storage 用途
 */
export async function uploadViaTwoPhase(
  file: File,
  purpose: StoragePurpose,
): Promise<{ ok: true; data: StorageObjectRef } | { ok: false; error: string }> {
  // Phase 1: authorize
  const auth = await requestUploadAuthorization(file, purpose);
  if (!auth.ok) return auth;

  // Phase 2: direct upload to Storage
  const upload = await uploadDirectToStorage(auth.signedUrl, file, auth.headers);
  if (!upload.ok) return upload;

  // Phase 3: finalize
  return finalizeUpload(auth.uploadToken);
}
