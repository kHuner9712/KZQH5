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
//
// 调用方：app/api/admin/storage/upload/route.ts（经 requireAdminWrite 鉴权）
//         app/api/admin/storage/object/route.ts（经 requireAdminWrite 鉴权）
// ============================================================

import { randomUUID } from "node:crypto";
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

/** 允许的资源分类（来自客户端，但服务端白名单校验）。 */
export const PRIVATE_ASSETS_ALLOWED_CATEGORIES = [
  "products",
  "projects",
  "catalogs",
] as const;
export type PrivateAssetCategory = (typeof PRIVATE_ASSETS_ALLOWED_CATEGORIES)[number];

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
 * 使用 service_role 将文件字节上传到 private-assets bucket。
 * 返回服务端生成的路径。客户端无法指定完整路径。
 */
export async function uploadToPrivateAssets(
  input: UploadFileBytes,
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
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  return {
    ok: true,
    path,
    bucket: PRIVATE_ASSETS_BUCKET,
    mimeType: validated.mimeType,
    size: input.size,
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
): Promise<StorageDeleteResult> {
  const validated = validatePrivateAssetPath(rawPath);
  if (!validated.ok) return validated;

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  const { error } = await client.storage
    .from(PRIVATE_ASSETS_BUCKET)
    .remove([validated.path]);

  if (error) {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  return { ok: true, path: validated.path, bucket: PRIVATE_ASSETS_BUCKET };
}
