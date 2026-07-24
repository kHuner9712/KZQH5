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
// 错误一律返回粗粒度文案（"上传失败" / "删除失败"），
// 永不透传服务端内部错误、SQLSTATE 或 Supabase 错误载荷。
// ============================================================

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
 * 通过可信服务端 API 上传文件。
 *
 * @param file     浏览器 File 对象
 * @param category 资源分类（即 ImageUpload/FileUpload 的 folder），服务端白名单校验
 */
export async function uploadViaServerApi(
  file: File,
  category: string,
): Promise<{ ok: true; data: StorageUploadResult } | { ok: false; error: string }> {
  try {
    const formData = new FormData();
    formData.append("category", category);
    formData.append("file", file);
    // 后台 ImageUpload/FileUpload 历来上传到 public-assets；保持该行为。
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
 * 通过可信服务端 API 删除 Storage 对象。
 *
 * @param path 服务端生成的存储路径 {category}/{uuid}.{ext}
 */
export async function deleteViaServerApi(
  path: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/admin/storage/object", {
      method: "DELETE",
      body: JSON.stringify({ path }),
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    });

    if (!res.ok) {
      return { ok: false, error: "删除失败" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "删除失败" };
  }
}
