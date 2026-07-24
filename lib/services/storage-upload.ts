// ============================================================
// 可信服务端 Storage 上传边界
// ------------------------------------------------------------
// 仅在服务端运行（service_role）。负责 pending/private 资源的服务端可信写入：
//   1. 读取实际文件字节并校验 Magic Bytes（防 MIME 伪造）
//   2. MIME 类型白名单（SVG / HTML / JavaScript / 可执行内容一律拒绝）
//   3. 扩展名 ↔ MIME 一致性
//   4. 按类型限制大小（图片 5MB / PDF 20MB）
//   5. 服务端生成路径 {category}/{uuid}.{ext}（禁止客户端提供完整 Storage Path）
//   6. 防 folder traversal（category 白名单 + 路径格式严格校验）
//   7. 使用 service_role 上传 / 删除 private-assets bucket
//   8. 记录 admin_storage_operations 审计（pending → completed | failed）
//
// 调用方：app/api/admin/storage/upload/route.ts（经 requireAdminWrite 鉴权）
//         app/api/admin/storage/object/route.ts（经 requireAdminWrite 鉴权）
// ============================================================

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  extractFileExtension,
  sanitizeStoragePath,
  validateFileSize,
  validateMimeExtensionConsistency,
  validateMimeType,
  verifyMagicBytes,
} from "@/lib/validation/storage";

/** private-assets bucket 名（硬编码，不接受客户端指定）。 */
export const PRIVATE_ASSETS_BUCKET = "private-assets";

/** public-assets bucket 名（硬编码，不接受客户端指定）。 */
export const PUBLIC_ASSETS_BUCKET = "public-assets";

/** 允许的资源分类（来自客户端，但服务端白名单校验）。 */
export const PRIVATE_ASSETS_ALLOWED_CATEGORIES = [
  "products",
  "projects",
  "catalogs",
] as const;
export type PrivateAssetCategory = (typeof PRIVATE_ASSETS_ALLOWED_CATEGORIES)[number];

/**
 * public-assets bucket 允许的顶层分类白名单。
 *
 * 与 private-assets 不同，public-assets 历史上允许子目录（如 products/covers、
 * projects/gallery、company/logo）。这里对「顶层分类」做白名单校验，子目录由
 * sanitizeStoragePath 防止 path traversal。该白名单覆盖现有所有 ImageUpload /
 * FileUpload 调用点使用的 folder 顶层值。
 */
export const PUBLIC_ASSETS_ALLOWED_TOP_CATEGORIES = [
  "products",
  "projects",
  "certificates",
  "company",
  "site",
  "documents",
  "document-covers",
] as const;
export type PublicAssetTopCategory = (typeof PUBLIC_ASSETS_ALLOWED_TOP_CATEGORIES)[number];

/**
 * private-assets bucket 的 MIME 白名单与大小上限。
 *   - 图片（jpeg/png/webp）：5MB（5242880 字节）
 *   - PDF：20MB（20971520 字节）
 *
 * SVG、HTML、text/html、application/javascript 及任何可执行内容均不在白名单内，
 * 在 MIME 校验阶段即被拒绝；即便伪造 MIME，Magic Bytes 校验也会拦截。
 */
const MIME_MAX_SIZE: Readonly<Record<string, number>> = {
  "image/jpeg": 5 * 1024 * 1024, // 5242880
  "image/png": 5 * 1024 * 1024, // 5242880
  "image/webp": 5 * 1024 * 1024, // 5242880
  "application/pdf": 20 * 1024 * 1024, // 20971520
};

const PRIVATE_ASSETS_ALLOWED_MIME: readonly string[] = Object.keys(MIME_MAX_SIZE);

/** MIME → 默认扩展名（文件名无可用扩展名时由服务端决定）。 */
const MIME_DEFAULT_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

export interface UploadFileBytes {
  /** 实际文件字节（完整内容；Magic Bytes 校验读取前若干字节）。 */
  bytes: Uint8Array;
  /** 声明的 MIME 类型（来自 multipart，可被伪造，故必须校验 Magic Bytes）。 */
  mimeType: string;
  /** 文件大小（字节，应等于 bytes.length）。 */
  size: number;
  /** 原始文件名（仅用于提取扩展名，不参与最终路径）。 */
  filename: string;
  /** 客户端提供的分类，必须命中白名单。 */
  category: string;
}

export type StorageUploadResult =
  | {
      ok: true;
      path: string;
      bucket: string;
      mimeType: string;
      size: number;
    }
  | { ok: false; code: AdminWriteErrorCode };

export type StorageDeleteResult =
  | { ok: true; path: string; bucket: string }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * public-assets 上传结果。比 private-assets 多一个 publicUrl：
 * public-assets bucket 对外可读，构造公开 URL 供前台展示。
 */
export type PublicStorageUploadResult =
  | {
      ok: true;
      path: string;
      bucket: string;
      mimeType: string;
      size: number;
      publicUrl: string;
    }
  | { ok: false; code: AdminWriteErrorCode };

function isAllowedCategory(value: string): value is PrivateAssetCategory {
  return (PRIVATE_ASSETS_ALLOWED_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 校验上传文件的 MIME / 大小 / Magic Bytes / 扩展名一致性。
 * 最终扩展名由 MIME 决定，不信任客户端文件名。
 */
function validateUploadFile(input: {
  mimeType: string;
  size: number;
  filename: string;
  bytes: Uint8Array;
}): { ok: true; mimeType: string; ext: string } | { ok: false; code: AdminWriteErrorCode } {
  // 1. MIME 白名单 —— SVG / HTML / JS / 可执行内容在此被拒绝
  const mimeResult = validateMimeType(input.mimeType, PRIVATE_ASSETS_ALLOWED_MIME);
  if (!mimeResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_UNSUPPORTED_MEDIA" };
  }

  const mimeType = input.mimeType.toLowerCase().trim();
  const maxSize = MIME_MAX_SIZE[mimeType];

  // 2. 大小校验（按类型上限）
  const sizeResult = validateFileSize(input.size, maxSize);
  if (!sizeResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_PAYLOAD_TOO_LARGE" };
  }

  // 3. Magic Bytes —— 必须在读取实际字节后执行，防止 MIME 伪造
  const magicResult = verifyMagicBytes(input.bytes, mimeType);
  if (!magicResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_UNSUPPORTED_MEDIA" };
  }

  // 4. 扩展名 ↔ MIME 一致性；无扩展名时使用 MIME 默认扩展名
  const fileExt = extractFileExtension(input.filename);
  if (fileExt) {
    const consistency = validateMimeExtensionConsistency(mimeType, fileExt);
    if (!consistency.ok) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }
  const ext = fileExt || MIME_DEFAULT_EXT[mimeType] || "";

  return { ok: true, mimeType, ext };
}

/**
 * 服务端生成存储路径：{category}/{uuid}.{ext}。
 * 客户端无法提供完整 Storage Path —— 仅提供 category（白名单校验）。
 * category 不参与 sanitize（已是枚举白名单）；ext 仅允许字母数字与点号。
 */
function generatePrivateStoragePath(
  category: PrivateAssetCategory,
  ext: string,
): string {
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  const normalizedExt = safeExt.startsWith(".")
    ? safeExt
    : safeExt
      ? `.${safeExt}`
      : "";
  return `${category}/${randomUUID()}${normalizedExt}`;
}

/**
 * 计算 SHA-256 十六进制摘要。用于 admin_storage_operations 审计记录，
 * 让运维可以比对上传到 bucket 的对象完整性，而无需把文件内容写入审计表。
 */
function computeSha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/**
 * 在 admin_storage_operations 中插入一条 pending 记录。
 * 调用方在操作开始前调用，操作结束后调用 completeStorageAudit。
 *
 * 失败时静默 —— 审计写失败不得阻断业务操作（业务操作仍由 service_role 完成）。
 */
async function recordStorageAuditStarted(input: {
  client: SupabaseClient<Database>;
  actorId?: string | null;
  actorRole?: string | null;
  action: "storage.upload" | "storage.delete";
  bucket: string;
  objectPath: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
}): Promise<string | null> {
  try {
    const { data, error } = await input.client.rpc(
      "record_storage_operation_started",
      {
        p_actor_id: input.actorId ?? null,
        p_actor_role: input.actorRole ?? null,
        p_action: input.action,
        p_bucket: input.bucket,
        p_object_path: input.objectPath,
        p_mime_type: input.mimeType ?? null,
        p_size_bytes: input.sizeBytes ?? null,
        p_sha256: input.sha256 ?? null,
      },
    );
    if (error) return null;
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

/**
 * 将 pending 审计记录更新为 completed 或 failed。
 * 失败时静默 —— 审计写失败不得阻断业务操作。
 */
async function completeStorageAudit(
  client: SupabaseClient<Database>,
  operationId: string | null,
  success: boolean,
  errorCode?: string,
): Promise<void> {
  if (!operationId) return;
  try {
    await client.rpc("complete_storage_operation", {
      p_operation_id: operationId,
      p_success: success,
      p_error_code: errorCode ?? null,
    });
  } catch {
    // swallow — never crash the business op because of audit
  }
}

/**
 * 使用 service_role 将文件字节上传到 private-assets bucket。
 * 返回服务端生成的路径。客户端无法指定完整路径。
 */
export async function uploadToPrivateAssets(
  input: UploadFileBytes,
  options?: {
    actorId?: string | null;
    actorRole?: string | null;
  },
): Promise<StorageUploadResult> {
  // 分类白名单 —— 防止 folder traversal / 任意目录写入
  if (!isAllowedCategory(input.category)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  const validated = validateUploadFile(input);
  if (!validated.ok) return validated;

  const path = generatePrivateStoragePath(input.category, validated.ext);

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  const sha256 = computeSha256Hex(input.bytes);
  const auditId = await recordStorageAuditStarted({
    client,
    actorId: options?.actorId ?? null,
    actorRole: options?.actorRole ?? null,
    action: "storage.upload",
    bucket: PRIVATE_ASSETS_BUCKET,
    objectPath: path,
    mimeType: validated.mimeType,
    sizeBytes: input.size,
    sha256,
  });

  // 上传实际字节；upsert:false 防止覆盖既有资源
  const uploadBody = Buffer.from(input.bytes);
  const { error } = await client.storage
    .from(PRIVATE_ASSETS_BUCKET)
    .upload(path, uploadBody, {
      cacheControl: "3600",
      upsert: false,
      contentType: validated.mimeType,
    });

  if (error) {
    await completeStorageAudit(client, auditId, false, "ADMIN_WRITE_FAILED");
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  await completeStorageAudit(client, auditId, true);
  return {
    ok: true,
    path,
    bucket: PRIVATE_ASSETS_BUCKET,
    mimeType: validated.mimeType,
    size: input.size,
  };
}

/**
 * 校验 public-assets 的顶层分类是否在白名单内。
 * 子目录（如 products/covers）由 sanitizeStoragePath 在路径生成阶段防御。
 */
function isAllowedPublicTopCategory(folder: string): boolean {
  const top = folder.split("/")[0]?.trim();
  if (!top) return false;
  return (
    PUBLIC_ASSETS_ALLOWED_TOP_CATEGORIES as readonly string[]
  ).includes(top);
}

/**
 * 服务端生成 public-assets 存储路径：{sanitized-folder}/{uuid}.{ext}。
 * 与 private-assets 不同，folder 允许多段子目录（历史行为），但必须通过
 * sanitizeStoragePath 防 path traversal，且顶层分类必须命中白名单。
 */
function generatePublicStoragePath(
  folder: string,
  ext: string,
): string | null {
  const safeFolder = sanitizeStoragePath(folder);
  if (!safeFolder) return null;

  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  const normalizedExt = safeExt.startsWith(".")
    ? safeExt
    : safeExt
      ? `.${safeExt}`
      : "";

  return `${safeFolder}/${randomUUID()}${normalizedExt}`;
}

/**
 * 直接构造 public-assets 的公开 URL。
 * 不使用 Supabase 客户端的 getPublicUrl()，避免在服务端路由引入浏览器客户端。
 */
function buildPublicAssetsUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${PUBLIC_ASSETS_BUCKET}/${path}`;
}

/**
 * 使用 service_role 将文件字节上传到 public-assets bucket。
 * 与 private-assets 共享 MIME / 大小 / Magic Bytes 校验（同样的 MIME 类型）。
 * 返回服务端生成的路径及公开 URL。客户端无法指定完整路径。
 */
export async function uploadToPublicAssets(
  input: UploadFileBytes,
  options?: {
    actorId?: string | null;
    actorRole?: string | null;
  },
): Promise<PublicStorageUploadResult> {
  // 顶层分类白名单 —— 防止 folder traversal / 任意目录写入
  if (!isAllowedPublicTopCategory(input.category)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  const validated = validateUploadFile(input);
  if (!validated.ok) return validated;

  const path = generatePublicStoragePath(input.category, validated.ext);
  if (!path) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  const sha256 = computeSha256Hex(input.bytes);
  const auditId = await recordStorageAuditStarted({
    client,
    actorId: options?.actorId ?? null,
    actorRole: options?.actorRole ?? null,
    action: "storage.upload",
    bucket: PUBLIC_ASSETS_BUCKET,
    objectPath: path,
    mimeType: validated.mimeType,
    sizeBytes: input.size,
    sha256,
  });

  // 上传实际字节；upsert:false 防止覆盖既有资源
  const uploadBody = Buffer.from(input.bytes);
  const { error } = await client.storage
    .from(PUBLIC_ASSETS_BUCKET)
    .upload(path, uploadBody, {
      cacheControl: "3600",
      upsert: false,
      contentType: validated.mimeType,
    });

  if (error) {
    await completeStorageAudit(client, auditId, false, "ADMIN_WRITE_FAILED");
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  await completeStorageAudit(client, auditId, true);
  return {
    ok: true,
    path,
    bucket: PUBLIC_ASSETS_BUCKET,
    mimeType: validated.mimeType,
    size: input.size,
    publicUrl: buildPublicAssetsUrl(path),
  };
}

/**
 * 严格校验路径格式为 {category}/{uuid}.{ext}，防止 path traversal。
 * 只允许删除服务端生成的路径（拒绝 `..`、绝对路径、空字节、反斜杠、多级目录）。
 */
export function validatePrivateAssetPath(
  rawPath: string,
): { ok: true; path: string } | { ok: false; code: AdminWriteErrorCode } {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // 显式拒绝危险字符：空字节、反斜杠、绝对路径
  if (rawPath.includes("\0") || rawPath.includes("\\") || rawPath.startsWith("/")) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // 防 folder traversal：sanitize 后必须仍为单层 {category}/{filename}
  const safe = sanitizeStoragePath(rawPath);
  if (!safe) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  const segments = safe.split("/");
  if (segments.length !== 2) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  const [category, filename] = segments;
  if (!isAllowedCategory(category)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // filename 必须为 {uuid}.{ext}（与 generatePrivateStoragePath 一致）
  const uuidExt = filename.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([a-z0-9]{2,5})$/i,
  );
  if (!uuidExt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  return { ok: true, path: safe };
}

/**
 * 使用 service_role 删除 private-assets 中的资源。
 * 路径必须通过 validatePrivateAssetPath 校验（防 path traversal）。
 */
export async function deletePrivateAsset(
  rawPath: string,
  options?: {
    actorId?: string | null;
    actorRole?: string | null;
  },
): Promise<StorageDeleteResult> {
  const validated = validatePrivateAssetPath(rawPath);
  if (!validated.ok) return validated;

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  const auditId = await recordStorageAuditStarted({
    client,
    actorId: options?.actorId ?? null,
    actorRole: options?.actorRole ?? null,
    action: "storage.delete",
    bucket: PRIVATE_ASSETS_BUCKET,
    objectPath: validated.path,
  });

  const { error } = await client.storage
    .from(PRIVATE_ASSETS_BUCKET)
    .remove([validated.path]);

  if (error) {
    await completeStorageAudit(client, auditId, false, "ADMIN_WRITE_FAILED");
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  await completeStorageAudit(client, auditId, true);
  return { ok: true, path: validated.path, bucket: PRIVATE_ASSETS_BUCKET };
}
