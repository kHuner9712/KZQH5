// ============================================================
// 客户端 Storage 上传/删除 fetch 包装
// ------------------------------------------------------------
// 后台 Client Component 不再直接调用 createBrowserSupabaseClient().storage
// 上传/删除，而是通过可信服务端 API（/api/admin/storage/*）。
// 服务端路由负责 service_role 鉴权、RBAC、同源校验、Magic Bytes / MIME /
// 大小校验、路径生成与 path traversal 防御。客户端只接收粗粒度结果。
//
// 上传：POST /api/admin/storage/upload  (multipart/form-data)
// 删除：DELETE /api/admin/storage/object (JSON { path })
//
// Purpose-driven 上传（推荐）：
//   - 客户端提交 `purpose`（如 "product-image" | "catalog-draft"）
//   - 服务端依据 purpose 决定 bucket / category / MIME 白名单
//   - 客户端无法自动决定公开性（移除 public=true 默认）
//
// 错误一律返回粗粒度文案（"上传失败" / "删除失败"），
// 永不透传服务端内部错误、SQLSTATE 或 Supabase 错误载荷。
// ============================================================

import type { StoragePurpose } from "@/lib/services/storage-purpose";

/** 服务端上传成功后返回给客户端的归一化结果。 */
export interface StorageUploadResult {
  /** 服务端生成的存储路径 {category}[/{sub}]/{uuid}.{ext}。 */
  path: string;
  /** 实际写入的 bucket（public-assets 或 private-assets）。 */
  bucket: string;
  /** 校验后的 MIME 类型。 */
  mimeType: string;
  /** 文件大小（字节）。 */
  size: number;
  /**
   * public-assets 的公开 URL；private-assets 返回 null。
   * 优先使用服务端返回的 publicUrl，缺失时按 bucket+path 兜底构造。
   */
  publicUrl: string | null;
  /**
   * 短期签名预览 URL（仅 private-assets 适用）。
   * 当前服务端尚未返回签名 URL，预留字段，暂为 null。
   */
  previewUrl: string | null;
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

const PUBLIC_ASSETS_BUCKET = "public-assets";

/** 按 bucket + path 兜底构造 public-assets 公开 URL。 */
function buildPublicAssetsUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${PUBLIC_ASSETS_BUCKET}/${path}`;
}

/**
 * 通过可信服务端 API 上传文件（Purpose-driven，推荐）。
 *
 * 客户端只提交 purpose，服务端依据 storage-purpose.ts 决定 bucket / category /
 * MIME 白名单。客户端不再自动决定公开性。
 *
 * @param file     浏览器 File 对象
 * @param purpose  Storage 用途（如 "product-image" | "catalog-draft"）
 */
export async function uploadViaServerApi(
  file: File,
  purpose: StoragePurpose,
): Promise<{ ok: true; data: StorageUploadResult } | { ok: false; error: string }> {
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
      typeof json.bucket !== "string"
    ) {
      return { ok: false, error: "上传失败" };
    }

    const path = json.path;
    const bucket = json.bucket;

    // publicUrl：优先服务端返回值；缺失且为 public-assets 时按公式兜底构造；
    // private-assets 一律 null。
    const publicUrl =
      typeof json.publicUrl === "string"
        ? json.publicUrl
        : bucket === PUBLIC_ASSETS_BUCKET
          ? buildPublicAssetsUrl(path)
          : null;

    return {
      ok: true,
      data: {
        path,
        bucket,
        mimeType:
          typeof json.mimeType === "string" ? json.mimeType : file.type,
        size: typeof json.size === "number" ? json.size : file.size,
        publicUrl,
        previewUrl: null,
      },
    };
  } catch {
    return { ok: false, error: "上传失败" };
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

    const json = (await res.json()) as { success?: boolean; cleanupId?: string | null };
    if (!json.success) {
      return { ok: false, error: "入队失败" };
    }
    return { ok: true, cleanupId: json.cleanupId ?? null };
  } catch {
    return { ok: false, error: "入队失败" };
  }
}

/**
 * Legacy 上传：通过可信服务端 API 上传文件到 public-assets（已弃用）。
 *
 * 仅用于尚未迁移到 purpose-driven 上传的调用点（certificates、product-assets）。
 * 服务端会记录 STORAGE_LEGACY_UPLOAD 警告日志。
 *
 * 后续 PR 将完全移除该函数，所有调用点必须迁移到 uploadViaServerApi(file, purpose)。
 *
 * @param file     浏览器 File 对象
 * @param category 资源分类（即 ImageUpload/FileUpload 的 folder），服务端白名单校验
 */
export async function uploadViaServerApiLegacy(
  file: File,
  category: string,
): Promise<{ ok: true; data: StorageUploadResult } | { ok: false; error: string }> {
  try {
    const formData = new FormData();
    formData.append("category", category);
    formData.append("file", file);
    // Legacy 路径：默认上传到 public-assets（已弃用）
    formData.append("public", "true");

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
      typeof json.bucket !== "string"
    ) {
      return { ok: false, error: "上传失败" };
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
        path,
        bucket,
        mimeType:
          typeof json.mimeType === "string" ? json.mimeType : file.type,
        size: typeof json.size === "number" ? json.size : file.size,
        publicUrl,
        previewUrl: null,
      },
    };
  } catch {
    return { ok: false, error: "上传失败" };
  }
}
