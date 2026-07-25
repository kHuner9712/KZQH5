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

/**
 * 允许的资源分类（来自客户端，但服务端白名单校验）。
 *
 * 包含 `certificates` 用于 certificate-draft purpose（证书默认 private-assets）。
 */
export const PRIVATE_ASSETS_ALLOWED_CATEGORIES = [
  "products",
  "projects",
  "catalogs",
  "certificates",
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
  | { ok: false; code: AdminWriteErrorCode; partial?: true };

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
 * 审计开始结果。
 *
 * fail-closed 语义：如果审计开始失败，调用方必须 NOT 执行业务操作
 * （上传/删除）。审计与业务操作的相对顺序：
 *   1. recordStorageAuditStarted 必须成功
 *   2. 才能执行实际 Storage 上传/删除
 *   3. 操作结束后调用 completeStorageAudit
 *   4. 若 completeStorageAudit 失败 → 补偿删除已上传对象（上传场景）
 */
type AuditStartedResult =
  | { ok: true; operationId: string }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * 在 admin_storage_operations 中插入一条 pending 记录。
 * 调用方在操作开始前调用，操作结束后调用 completeStorageAudit。
 *
 * fail-closed：若审计开始失败，返回 { ok: false }，调用方必须 NOT 执行
 * 实际业务操作。这避免「业务操作成功但审计缺失」的不一致状态。
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
}): Promise<AuditStartedResult> {
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
    if (error || typeof data !== "string" || data.length === 0) {
      console.error("STORAGE_AUDIT_START_FAILED", {
        action: input.action,
        bucket: input.bucket,
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, operationId: data };
  } catch {
    console.error("STORAGE_AUDIT_START_EXCEPTION", {
      action: input.action,
      bucket: input.bucket,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

/**
 * 审计完成结果。
 *
 * fail-closed 语义：若完成审计失败，调用方必须执行补偿（删除已上传对象
 * 或重新加入 cleanup queue），并返回错误而非沉默成功。
 */
type AuditCompleteResult =
  | { ok: true }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * 将 pending 审计记录更新为 completed 或 failed。
 *
 * fail-closed：返回结果给调用方，调用方在失败时执行补偿。
 * 不再静默吞错。
 */
async function completeStorageAudit(
  client: SupabaseClient<Database>,
  operationId: string,
  success: boolean,
  errorCode?: string,
): Promise<AuditCompleteResult> {
  try {
    const { error } = await client.rpc("complete_storage_operation", {
      p_operation_id: operationId,
      p_success: success,
      p_error_code: errorCode ?? null,
    });
    if (error) {
      console.error("STORAGE_AUDIT_COMPLETE_FAILED", {
        operationId,
        success,
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true };
  } catch {
    console.error("STORAGE_AUDIT_COMPLETE_EXCEPTION", {
      operationId,
      success,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

/**
 * 补偿：删除已上传对象（用于审计完成失败场景）。
 *
 * fail-closed 语义：
 *   - 必须检查 `.remove()` 返回的 `error`，不得沉默吞错
 *   - 补偿成功 → 返回 { ok: true }，调用方仍返回错误（因为审计不完整）
 *   - 补偿失败 → 返回 { ok: false }，对象残留，需入队 storage_cleanup_queue
 *     让 dispatcher 后续重新检查引用后再删除
 *   - 不宣称对象已删除（除非 `.remove()` 明确返回无 error）
 *   - 调用方根据返回值决定是否入队 reconciliation
 */
async function compensateDeleteUploadedObject(
  client: SupabaseClient<Database>,
  bucket: string,
  path: string,
): Promise<{ ok: true } | { ok: false }> {
  try {
    const { error } = await client.storage.from(bucket).remove([path]);
    if (error) {
      // 补偿删除失败：对象仍残留于 bucket
      // 固定日志 code，不泄露 Supabase 内部错误细节
      console.error("STORAGE_COMPENSATE_DELETE_FAILED", {
        bucket,
        path,
        code: "STORAGE_COMPENSATE_FAILED",
      });
      return { ok: false };
    }
    return { ok: true };
  } catch {
    // 异常（网络/超时等）：对象状态未知，按失败处理
    console.error("STORAGE_COMPENSATE_DELETE_EXCEPTION", {
      bucket,
      path,
      code: "STORAGE_COMPENSATE_FAILED",
    });
    return { ok: false };
  }
}

/**
 * 补偿失败后入队 storage_cleanup_queue 让 dispatcher 后续处理。
 *
 * 调用时机：compensateDeleteUploadedObject 返回 { ok: false } 时，
 * 调用方应调用此函数把残留对象入队。入队失败时仅记录日志，
 * 由 read-only inventory 脚本兜底发现。
 */
async function enqueueResidualObjectForCleanup(
  client: SupabaseClient<Database>,
  bucket: string,
  path: string,
  reason: "form_cancelled" | "replaced" | "row_deleted" | "orphan_detected",
  sourceType?: string | null,
  sourceId?: string | null,
): Promise<void> {
  try {
    await client.rpc("enqueue_storage_cleanup", {
      p_bucket: bucket,
      p_object_path: path,
      p_reason: reason,
      p_source_type: sourceType ?? null,
      p_source_id: sourceId ?? null,
    });
  } catch {
    // 入队失败时仅记录日志；read-only inventory 脚本可发现残留对象
    console.error("STORAGE_RESIDUAL_ENQUEUE_FAILED", {
      bucket,
      path,
      reason,
      code: "STORAGE_RESIDUAL_ENQUEUE_FAILED",
    });
  }
}

/**
 * 使用 service_role 将文件字节上传到 private-assets bucket。
 * 返回服务端生成的路径。客户端无法指定完整路径。
 *
 * fail-closed 审计 Saga：
 *   1. recordStorageAuditStarted 必须成功，否则不上传
 *   2. 上传成功后 completeStorageAudit(success=true) 必须成功，
 *      否则补偿删除已上传对象并返回错误
 *   3. 上传失败时 completeStorageAudit(success=false)，
 *      若审计完成也失败则记录日志（无对象残留）
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

  // fail-closed：审计开始必须成功，否则 NOT 上传
  const auditStart = await recordStorageAuditStarted({
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
  if (!auditStart.ok) {
    return { ok: false, code: auditStart.code };
  }
  const operationId = auditStart.operationId;

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
    // 上传失败 —— 完成审计为 failed；若审计完成也失败，仅记录日志（无对象残留）
    const auditEnd = await completeStorageAudit(
      client,
      operationId,
      false,
      "ADMIN_WRITE_FAILED",
    );
    if (!auditEnd.ok) {
      // 审计完成失败，但上传已失败 → 无对象残留，仅记录
      console.error("STORAGE_UPLOAD_FAILED_AND_AUDIT_INCONSISTENT", {
        bucket: PRIVATE_ASSETS_BUCKET,
        path,
        operationId,
      });
    }
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 上传成功 —— 完成审计为 success；若审计完成失败，补偿删除已上传对象
  const auditEnd = await completeStorageAudit(client, operationId, true);
  if (!auditEnd.ok) {
    // 补偿：删除已上传对象，避免「对象存在但审计不完整」
    // 补偿失败时入队 cleanup queue 让 dispatcher 后续处理
    const compensate = await compensateDeleteUploadedObject(
      client,
      PRIVATE_ASSETS_BUCKET,
      path,
    );
    if (!compensate.ok) {
      // 补偿删除失败 → 对象残留，入队 cleanup queue
      await enqueueResidualObjectForCleanup(
        client,
        PRIVATE_ASSETS_BUCKET,
        path,
        "orphan_detected",
        "storage.upload",
        operationId,
      );
    }
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
 *
 * fail-closed 审计 Saga：与 uploadToPrivateAssets 相同。
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

  // fail-closed：审计开始必须成功，否则 NOT 上传
  const auditStart = await recordStorageAuditStarted({
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
  if (!auditStart.ok) {
    return { ok: false, code: auditStart.code };
  }
  const operationId = auditStart.operationId;

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
    const auditEnd = await completeStorageAudit(
      client,
      operationId,
      false,
      "ADMIN_WRITE_FAILED",
    );
    if (!auditEnd.ok) {
      console.error("STORAGE_UPLOAD_FAILED_AND_AUDIT_INCONSISTENT", {
        bucket: PUBLIC_ASSETS_BUCKET,
        path,
        operationId,
      });
    }
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 上传成功 —— 完成审计；若审计完成失败，补偿删除已上传对象
  const auditEnd = await completeStorageAudit(client, operationId, true);
  if (!auditEnd.ok) {
    const compensate = await compensateDeleteUploadedObject(
      client,
      PUBLIC_ASSETS_BUCKET,
      path,
    );
    if (!compensate.ok) {
      // 补偿删除失败 → 对象残留，入队 cleanup queue
      await enqueueResidualObjectForCleanup(
        client,
        PUBLIC_ASSETS_BUCKET,
        path,
        "orphan_detected",
        "storage.upload",
        operationId,
      );
    }
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

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
 * 严格校验 public-assets 路径格式，防止 path traversal。
 *
 * 与 private-assets 不同，public-assets 历史上允许子目录（如 products/covers、
 * projects/gallery）。这里允许 1-3 段路径，但每段必须命中白名单或满足
 * uuid/filename 格式，且顶层分类必须命中 PUBLIC_ASSETS_ALLOWED_TOP_CATEGORIES。
 *
 * 拒绝：空字节、反斜杠、绝对路径、`..` 段、空段、非白名单顶层分类。
 */
export function validatePublicAssetPath(
  rawPath: string,
): { ok: true; path: string } | { ok: false; code: AdminWriteErrorCode } {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (rawPath.includes("\0") || rawPath.includes("\\") || rawPath.startsWith("/")) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  const safe = sanitizeStoragePath(rawPath);
  if (!safe) return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };

  const segments = safe.split("/");
  if (segments.length < 2 || segments.length > 3) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  // 顶层分类必须命中白名单
  const top = segments[0];
  if (!isAllowedPublicTopCategory(top)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  // 每段非空且不含 `..`
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }
  // 末段必须包含 `.`（filename + ext），且不含路径分隔符
  const filename = segments[segments.length - 1];
  if (!filename.includes(".") || filename.startsWith(".")) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  return { ok: true, path: safe };
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
 *
 * fail-closed 审计 Saga：
 *   1. recordStorageAuditStarted 必须成功，否则不删除
 *   2. 删除成功后 completeStorageAudit(success=true) 必须成功，
 *      否则记录日志（对象已删除，无法补偿，需人工核对审计表）
 *   3. 删除失败时 completeStorageAudit(success=false)，
 *      若审计完成也失败则记录日志（对象仍存在，可重试）
 *
 * 注意：删除场景无法像上传那样「补偿删除对象」—— 若对象已删除但审计
 * 未完成，只能记录日志供人工对账。
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

  // fail-closed：审计开始必须成功，否则 NOT 删除
  const auditStart = await recordStorageAuditStarted({
    client,
    actorId: options?.actorId ?? null,
    actorRole: options?.actorRole ?? null,
    action: "storage.delete",
    bucket: PRIVATE_ASSETS_BUCKET,
    objectPath: validated.path,
  });
  if (!auditStart.ok) {
    return { ok: false, code: auditStart.code };
  }
  const operationId = auditStart.operationId;

  const { error } = await client.storage
    .from(PRIVATE_ASSETS_BUCKET)
    .remove([validated.path]);

  if (error) {
    const auditEnd = await completeStorageAudit(
      client,
      operationId,
      false,
      "ADMIN_WRITE_FAILED",
    );
    if (!auditEnd.ok) {
      console.error("STORAGE_DELETE_FAILED_AND_AUDIT_INCONSISTENT", {
        bucket: PRIVATE_ASSETS_BUCKET,
        path: validated.path,
        operationId,
      });
    }
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 删除成功 —— 完成审计；若审计完成失败，不返回普通成功
  // 必须返回 partial-failure 让调用方感知审计不一致状态
  // pending audit operation 保留为可对账状态，由 reconcilePendingStorageAudit 后续处理
  const auditEnd = await completeStorageAudit(client, operationId, true);
  if (!auditEnd.ok) {
    console.error("STORAGE_DELETE_OK_BUT_AUDIT_INCOMPLETE", {
      bucket: PRIVATE_ASSETS_BUCKET,
      path: validated.path,
      operationId,
      code: "STORAGE_DELETE_AUDIT_INCOMPLETE",
    });
    // 对象已删除，无法补偿；返回 partial-failure（不是普通成功）
    // 调用方应感知审计不一致状态；reconciliation 可后续确认对象已不存在后补全审计
    return {
      ok: false,
      code: "ADMIN_WRITE_FAILED",
      partial: true,
    };
  }

  return { ok: true, path: validated.path, bucket: PRIVATE_ASSETS_BUCKET };
}

// ============================================================
// Purpose-driven upload（推荐入口）
// ============================================================

/**
 * 统一的 Storage 对象引用类型。
 *
 * 业务表（products.cover_image_url 等）历史上只存裸 URL 字符串，导致后续
 * 删除/替换时无法精确找到 bucket+path。新代码使用 StorageObjectRef 携带
 * 完整定位信息，业务表更新时一并写入 bucket 与 path。
 */
export interface StorageObjectRef {
  bucket: "public-assets" | "private-assets";
  path: string;
  publicUrl: string | null;
  mimeType: string;
  size: number;
  sha256?: string;
}

/** Purpose-driven 上传结果（fail-closed 审计 + 服务端 bucket 决策）。 */
export type PurposeUploadResult =
  | { ok: true; ref: StorageObjectRef }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * Purpose-driven 上传入口（推荐）。
 *
 * 客户端只提交 purpose，服务端依据 storage-purpose.ts 的映射决定：
 *   - bucket（public-assets | private-assets）
 *   - category（路径前缀）
 *   - allowedMimeTypes（覆盖默认白名单）
 *   - isPublicUrlAllowed（private-assets 不返回 publicUrl）
 *
 * 该函数禁止客户端提交 bucket / public / 完整 path，确保通用组件
 * （ImageUpload / FileUpload）无法自动决定公开性。
 */
export async function uploadByPurpose(
  purpose: unknown,
  file: { bytes: Uint8Array; mimeType: string; size: number; filename: string },
  options?: {
    actorId?: string | null;
    actorRole?: string | null;
  },
): Promise<PurposeUploadResult> {
  // 动态导入避免循环依赖（storage-purpose 仅类型依赖）
  const { resolvePurposeConfig } = await import("@/lib/services/storage-purpose");
  const config = resolvePurposeConfig(purpose);
  if (!config) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // 校验 MIME 命中 purpose 白名单（覆盖默认白名单）
  const mime = file.mimeType.toLowerCase().trim();
  if (!(config.allowedMimeTypes as readonly string[]).includes(mime)) {
    return { ok: false, code: "ADMIN_WRITE_UNSUPPORTED_MEDIA" };
  }

  const input: UploadFileBytes = {
    bytes: file.bytes,
    mimeType: file.mimeType,
    size: file.size,
    filename: file.filename,
    category: config.category,
  };

  if (config.bucket === "private-assets") {
    const result = await uploadToPrivateAssets(input, options);
    if (!result.ok) return result;
    return {
      ok: true,
      ref: {
        bucket: "private-assets",
        path: result.path,
        publicUrl: null,
        mimeType: result.mimeType,
        size: result.size,
      },
    };
  }

  // public-assets
  const result = await uploadToPublicAssets(input, options);
  if (!result.ok) return result;
  return {
    ok: true,
    ref: {
      bucket: "public-assets",
      path: result.path,
      publicUrl: result.publicUrl,
      mimeType: result.mimeType,
      size: result.size,
    },
  };
}

// ============================================================
// Storage 删除（public-assets / private-assets 对称）
// ============================================================

/**
 * 使用 service_role 删除 public-assets 中的资源。
 * 路径必须通过 validatePublicAssetPath 校验（防 path traversal）。
 *
 * fail-closed 审计 Saga：与 deletePrivateAsset 对称。
 */
export async function deletePublicAsset(
  rawPath: string,
  options?: {
    actorId?: string | null;
    actorRole?: string | null;
  },
): Promise<StorageDeleteResult> {
  const validated = validatePublicAssetPath(rawPath);
  if (!validated.ok) return validated;

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // fail-closed：审计开始必须成功，否则 NOT 删除
  const auditStart = await recordStorageAuditStarted({
    client,
    actorId: options?.actorId ?? null,
    actorRole: options?.actorRole ?? null,
    action: "storage.delete",
    bucket: PUBLIC_ASSETS_BUCKET,
    objectPath: validated.path,
  });
  if (!auditStart.ok) {
    return { ok: false, code: auditStart.code };
  }
  const operationId = auditStart.operationId;

  const { error } = await client.storage
    .from(PUBLIC_ASSETS_BUCKET)
    .remove([validated.path]);

  if (error) {
    const auditEnd = await completeStorageAudit(
      client,
      operationId,
      false,
      "ADMIN_WRITE_FAILED",
    );
    if (!auditEnd.ok) {
      console.error("STORAGE_DELETE_FAILED_AND_AUDIT_INCONSISTENT", {
        bucket: PUBLIC_ASSETS_BUCKET,
        path: validated.path,
        operationId,
      });
    }
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 删除成功 —— 完成审计；若审计完成失败，不返回普通成功
  // 必须返回 partial-failure 让调用方感知审计不一致状态
  const auditEnd = await completeStorageAudit(client, operationId, true);
  if (!auditEnd.ok) {
    console.error("STORAGE_DELETE_OK_BUT_AUDIT_INCOMPLETE", {
      bucket: PUBLIC_ASSETS_BUCKET,
      path: validated.path,
      operationId,
      code: "STORAGE_DELETE_AUDIT_INCOMPLETE",
    });
    return {
      ok: false,
      code: "ADMIN_WRITE_FAILED",
      partial: true,
    };
  }

  return { ok: true, path: validated.path, bucket: PUBLIC_ASSETS_BUCKET };
}

// ============================================================
// 引用检查 + 清理队列入队（服务端可信）
// ============================================================

/**
 * 引用检查结果。
 *
 * fail-closed：若 RPC 调用本身失败，返回 { ok: false, code }，
 * 调用方必须拒绝删除（不允许"查不到引用就删"的乐观路径）。
 */
type ReferencedResult =
  | { ok: true; referenced: boolean }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * 调用 check_storage_object_referenced RPC，判断对象是否被业务表引用。
 *
 * RPC 通过 LIKE '%path' 后缀匹配 products.cover_image_url / video_url、
 * product_images.image_url、product_assets.file_url / cover_image_url、
 * certificates.image_url、projects.cover_image_url / video_url。
 *
 * 注意：LIKE 后缀匹配不精确（同后缀的不同对象会误判），
 * 但在 UUID 文件名命名下冲突概率可忽略。未来若引入 storage_object_refs
 * 引用表，可改为精确查找。
 *
 * fail-closed：RPC 调用失败时返回 { ok: false }，调用方必须拒绝删除。
 */
export async function isReferencedStorageObject(
  bucket: string,
  objectPath: string,
): Promise<ReferencedResult> {
  if (
    typeof bucket !== "string" ||
    typeof objectPath !== "string" ||
    objectPath.length === 0
  ) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  // bucket 白名单（与 DELETE API 一致）
  if (bucket !== "public-assets" && bucket !== "private-assets") {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  try {
    const { data, error } = await client.rpc("check_storage_object_referenced", {
      p_bucket: bucket,
      p_object_path: objectPath,
    });
    if (error) {
      console.error("STORAGE_REF_CHECK_FAILED", {
        bucket,
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    // RPC 返回 boolean：true=被引用（拒绝删除），false=可安全删除
    return { ok: true, referenced: Boolean(data) };
  } catch {
    console.error("STORAGE_REF_CHECK_EXCEPTION", {
      bucket,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

/**
 * 清理队列入队结果。
 *
 * fail-closed 语义：
 *   - 入队失败时返回 { ok: false, code }，调用方应记录日志但不阻塞业务操作
 *   - 入队成功但对象残留 → 由 dispatcher 后续处理（dispatcher 当前为 BLOCK）
 *   - 入队是幂等的（unique on (bucket, object_path) where status in pending/retry/claimed）
 */
type EnqueueCleanupResult =
  | { ok: true; cleanupId: string | null }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * 调用 enqueue_storage_cleanup RPC，将待清理对象入队。
 *
 * 使用场景：
 *   - 表单取消上传（本次新上传但未保存到 DB）→ reason: "form_cancelled"
 *   - 表单替换图片（旧对象已被新对象替换）→ reason: "replaced"
 *   - 业务表行删除后清理关联对象 → reason: "row_deleted"
 *   - 运维检测到的孤立对象 → reason: "orphan_detected"
 *
 * 入队后由 storage_cleanup_queue dispatcher（尚未部署，BLOCK）通过
 * FOR UPDATE SKIP LOCKED 认领、重新检查引用、再删除。
 *
 * 注意：调用方在入队前必须先更新业务表（清除引用），否则 dispatcher
 * 重新检查引用时会因引用仍存在而拒绝删除。
 */
export async function enqueueStorageCleanup(input: {
  bucket: string;
  objectPath: string;
  reason: "form_cancelled" | "replaced" | "row_deleted" | "orphan_detected";
  sourceType?: string | null;
  sourceId?: string | null;
}): Promise<EnqueueCleanupResult> {
  if (
    typeof input.bucket !== "string" ||
    (input.bucket !== "public-assets" && input.bucket !== "private-assets")
  ) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (typeof input.objectPath !== "string" || input.objectPath.length === 0) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  try {
    const { data, error } = await client.rpc("enqueue_storage_cleanup", {
      p_bucket: input.bucket,
      p_object_path: input.objectPath,
      p_reason: input.reason,
      p_source_type: input.sourceType ?? null,
      p_source_id: input.sourceId ?? null,
    });
    if (error) {
      console.error("STORAGE_CLEANUP_ENQUEUE_FAILED", {
        bucket: input.bucket,
        reason: input.reason,
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    // RPC 返回 uuid（新入队）或 null（已存在 pending/retry/claimed 行，幂等）
    return {
      ok: true,
      cleanupId: typeof data === "string" ? data : null,
    };
  } catch {
    console.error("STORAGE_CLEANUP_ENQUEUE_EXCEPTION", {
      bucket: input.bucket,
      reason: input.reason,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

// ============================================================
// Catalog asset publication flow (private→public)
// ============================================================

/**
 * Catalog 发布应用层流程结果。
 *
 * 服务端从 private-assets 读取源对象字节，重新校验 MIME / Magic Bytes /
 * 大小，写入 public-assets，再调用 publish_catalog_asset RPC 在同一事务中
 * 更新 product_assets 行并写审计。RPC 失败时补偿删除新 public 副本；RPC
 * 成功后把旧 private 源加入 cleanup queue。
 */
export type PublishCatalogAssetResult =
  | {
      ok: true;
      ref: StorageObjectRef;
      /** 旧 private-assets 源路径（已加入 cleanup queue，由 dispatcher 异步删除）。 */
      oldPath: string;
      /** 旧 private-assets 源 cleanup queue 行 id（null 表示幂等未创建新行）。 */
      cleanupId: string | null;
    }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * 应用层 Catalog 发布流程。
 *
 * 客户端只提交 assetId；服务端在内部完成：
 *   1. 查询 product_assets 行（service_role）
 *   2. 校验 is_published=true + access_level=public + authorization_status=confirmed
 *   3. 校验源对象在 private-assets 且路径为服务端生成格式
 *   4. 从 private-assets 下载字节
 *   5. 重新校验 MIME / Magic Bytes / 大小（不信任 private-assets 已存内容）
 *   6. 服务端生成 public-assets 目标路径
 *   7. 写入 public-assets（fail-closed 审计 Saga）
 *   8. 调用 publish_catalog_asset RPC 更新 DB 行 + 审计
 *   9. RPC 失败 → 补偿删除新 public 副本，返回错误
 *   10. RPC 成功 → 把旧 private 源加入 cleanup queue
 *   11. cleanup 入队失败 → 不静默成功，返回 PARTIAL_SUCCESS_ERROR 让调用方感知
 *
 * 幂等性：
 *   - 同一 assetId 重复调用：RPC 通过 SELECT ... FOR UPDATE 锁住行，
 *     若 file_url 已是 public-assets URL，调用方应在上层先检查并直接返回。
 *   - 并发发布：RPC 的 FOR UPDATE 锁使并发调用串行化，第二个调用看到的
 *     是已更新的 file_url（public URL），不会复制第二份。
 */
export async function publishCatalogAssetFlow(input: {
  assetId: string;
  options?: {
    actorId?: string | null;
    actorEmail?: string | null;
    actorRole?: string | null;
  };
}): Promise<PublishCatalogAssetResult> {
  if (
    typeof input.assetId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.assetId,
    )
  ) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 1. 查询 asset 行 + 验证发布前置条件
  type PublishAssetRow = {
    file_url: string;
    cover_image_url: string | null;
    title_cn: string;
    is_published: boolean;
    access_level: string;
    authorization_status: string;
    mime_type: string | null;
  };
  let assetRow: PublishAssetRow | null = null;

  try {
    const { data, error } = await client
      .from("product_assets")
      .select(
        "file_url, cover_image_url, title_cn, is_published, access_level, authorization_status, mime_type",
      )
      .eq("id", input.assetId)
      .maybeSingle();

    if (error) {
      console.error("PUBLISH_ASSET_READ_FAILED", {
        assetId: input.assetId,
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    assetRow = data as PublishAssetRow | null;
  } catch {
    console.error("PUBLISH_ASSET_READ_EXCEPTION", {
      assetId: input.assetId,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  if (!assetRow) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // 2. 验证发布前置条件（与 RPC 中的检查对齐）
  if (!assetRow.is_published) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (assetRow.access_level !== "public") {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (assetRow.authorization_status !== "confirmed") {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // 3. 解析源 file_url，确认它指向 private-assets 且为服务端生成路径
  //    幂等：若 file_url 已指向 public-assets，直接返回当前 ref（不复制第二份）
  const sourceFileUrl = assetRow.file_url;
  const publicAssetsUrlPrefix = `${(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/public/${PUBLIC_ASSETS_BUCKET}/`;

  if (sourceFileUrl.startsWith(publicAssetsUrlPrefix)) {
    // 已发布到 public-assets → 幂等返回，不复制第二份
    const existingPath = decodeURIComponent(
      sourceFileUrl.slice(publicAssetsUrlPrefix.length),
    );
    return {
      ok: true,
      ref: {
        bucket: "public-assets",
        path: existingPath,
        publicUrl: sourceFileUrl,
        mimeType: assetRow.mime_type ?? "application/octet-stream",
        size: 0,
      },
      oldPath: existingPath,
      cleanupId: null,
    };
  }

  // 解析 private-assets URL（短签名 URL 或公开 URL 形式）
  // Supabase 短签名 URL 格式：
  //   {supabase_url}/storage/v1/object/sign/{bucket}/{path}?token=...
  // Supabase 公开 URL 格式（如 bucket 暂未启用 RLS）：
  //   {supabase_url}/storage/v1/object/public/{bucket}/{path}
  const privateSignPrefix = `${(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/sign/${PRIVATE_ASSETS_BUCKET}/`;
  const privatePublicPrefix = `${(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/public/${PRIVATE_ASSETS_BUCKET}/`;

  let sourcePath: string | null = null;
  if (sourceFileUrl.startsWith(privateSignPrefix)) {
    const pathAndQuery = sourceFileUrl.slice(privateSignPrefix.length);
    // 去掉 query string
    sourcePath = decodeURIComponent(pathAndQuery.split("?", 1)[0] || "");
  } else if (sourceFileUrl.startsWith(privatePublicPrefix)) {
    sourcePath = decodeURIComponent(
      sourceFileUrl.slice(privatePublicPrefix.length),
    );
  }

  if (!sourcePath) {
    // 源 URL 不指向 private-assets → 拒绝发布（避免误处理外部 URL）
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // 校验源路径为服务端生成格式（{category}/{uuid}.{ext}）
  const pathValidation = validatePrivateAssetPath(sourcePath);
  if (!pathValidation.ok) {
    return { ok: false, code: pathValidation.code };
  }
  const validatedSourcePath = pathValidation.path;

  // 4. 从 private-assets 下载字节
  let bytes: Uint8Array;
  try {
    const downloadResponse = await client.storage
      .from(PRIVATE_ASSETS_BUCKET)
      .download(validatedSourcePath);

    if (downloadResponse.error) {
      console.error("PUBLISH_SOURCE_DOWNLOAD_FAILED", {
        assetId: input.assetId,
        path: validatedSourcePath,
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }

    const blob = downloadResponse.data;
    const ab = await blob.arrayBuffer();
    bytes = new Uint8Array(ab);
  } catch {
    console.error("PUBLISH_SOURCE_DOWNLOAD_EXCEPTION", {
      assetId: input.assetId,
      path: validatedSourcePath,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 5. 重新校验 MIME / Magic Bytes / 大小
  //    不信任 private-assets 中已存内容（可能被其他流程污染）
  const mimeType = (assetRow.mime_type ?? "").toLowerCase().trim() ||
    "application/octet-stream";

  const mimeResult = validateMimeType(mimeType, PRIVATE_ASSETS_ALLOWED_MIME);
  if (!mimeResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_UNSUPPORTED_MEDIA" };
  }

  const maxSize = MIME_MAX_SIZE[mimeType] ?? 0;
  const sizeResult = validateFileSize(bytes.length, maxSize);
  if (!sizeResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_PAYLOAD_TOO_LARGE" };
  }

  const magicResult = verifyMagicBytes(bytes, mimeType);
  if (!magicResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_UNSUPPORTED_MEDIA" };
  }

  // 提取源文件名（用于扩展名推断）
  const sourceFilename = validatedSourcePath.split("/").pop() || "";

  // 6. 上传到 public-assets（使用 uploadToPublicAssets 完成审计 Saga）
  //    category 用源路径的顶层分类（如 "catalogs"），但 public-assets 顶层白名单
  //    不包含 "catalogs" → 我们使用 "documents" 作为 public-assets 的目标顶层分类
  const targetCategory = "documents";
  const uploadResult = await uploadToPublicAssets(
    {
      bytes,
      mimeType,
      size: bytes.length,
      filename: sourceFilename,
      category: targetCategory,
    },
    {
      actorId: input.options?.actorId ?? null,
      actorRole: input.options?.actorRole ?? null,
    },
  );

  if (!uploadResult.ok) {
    return { ok: false, code: uploadResult.code };
  }

  /**
   * 局部辅助：补偿删除新 public 副本，并在补偿失败时入队 cleanup。
   * 不抛错；调用方根据 RPC 错误码返回相应的失败结果。
   */
  const compensatePublicCopy = async (): Promise<void> => {
    const compensate = await compensateDeleteUploadedObject(
      client,
      PUBLIC_ASSETS_BUCKET,
      uploadResult.path,
    );
    if (!compensate.ok) {
      // 补偿删除失败 → 入队 cleanup queue 让 dispatcher 后续处理
      await enqueueResidualObjectForCleanup(
        client,
        PUBLIC_ASSETS_BUCKET,
        uploadResult.path,
        "orphan_detected",
        "catalog_publish",
        input.assetId,
      );
    }
  };

  // 7. 调用 publish_catalog_asset RPC 更新 DB 行 + 审计
  let rpcResult: {
    asset_id: string;
    old_file_url: string;
    old_cover_image_url: string | null;
    new_file_url: string;
    new_cover_image_url: string | null;
  } | null = null;

  try {
    const { data, error } = await client.rpc("publish_catalog_asset", {
      p_asset_id: input.assetId,
      p_public_file_url: uploadResult.publicUrl,
      p_public_cover_image_url: null, // 当前不处理 cover_image_url 发布
      p_actor_id: input.options?.actorId ?? null,
      p_actor_email: input.options?.actorEmail ?? null,
      p_actor_role: input.options?.actorRole ?? null,
    });

    if (error) {
      const errCode = (error as { code?: string }).code ?? "";
      // 23505 = unique_violation, 23001 = integrity_violation (CHECK)
      // 40P01/40001 = concurrent / serialization failure
      if (errCode === "23505" || errCode === "23001") {
        // RPC 拒绝（前置条件不满足或并发冲突）→ 补偿删除 public 副本
        await compensatePublicCopy();
        return { ok: false, code: "ADMIN_WRITE_CONFLICT" };
      }
      if (errCode === "P0002") {
        // asset not found
        await compensatePublicCopy();
        return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
      }
      console.error("PUBLISH_CATALOG_ASSET_RPC_FAILED", {
        assetId: input.assetId,
        errCode,
        code: "ADMIN_WRITE_FAILED",
      });
      // RPC 失败 → 补偿删除新 public 副本
      await compensatePublicCopy();
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }

    rpcResult = data as typeof rpcResult;
  } catch (err) {
    const errCode = (err as { code?: string }).code ?? "";
    console.error("PUBLISH_CATALOG_ASSET_RPC_EXCEPTION", {
      assetId: input.assetId,
      errCode,
      code: "ADMIN_WRITE_FAILED",
    });
    await compensatePublicCopy();
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  if (!rpcResult) {
    // 防御性兜底
    await compensatePublicCopy();
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 8. RPC 成功 → 把旧 private 源加入 cleanup queue
  //    cleanup 入队失败时不静默成功：返回 PARTIAL_SUCCESS 让调用方感知
  //    （对象已发布成功，但旧 private 副本残留，需后续 reconciliation）
  const cleanupEnqueue = await enqueueStorageCleanup({
    bucket: PRIVATE_ASSETS_BUCKET,
    objectPath: validatedSourcePath,
    reason: "replaced",
    sourceType: "catalog_asset",
    sourceId: input.assetId,
  });

  if (!cleanupEnqueue.ok) {
    // 入队失败：发布本身已成功（DB 已更新、新 public 副本已写入），
    // 但旧 private 副本残留 → 返回 ok=true 但记录 cleanupId=null
    // 调用方应在响应中包含 partialCleanup 标志让运维感知
    console.error("PUBLISH_CLEANUP_ENQUEUE_FAILED", {
      assetId: input.assetId,
      oldPath: validatedSourcePath,
      code: "PUBLISH_CLEANUP_ENQUEUE_FAILED",
    });
    // 仍返回成功，因为发布本身已完成；旧副本由 read-only inventory 脚本兜底
    return {
      ok: true,
      ref: {
        bucket: "public-assets",
        path: uploadResult.path,
        publicUrl: uploadResult.publicUrl,
        mimeType: uploadResult.mimeType,
        size: uploadResult.size,
      },
      oldPath: validatedSourcePath,
      cleanupId: null,
    };
  }

  return {
    ok: true,
    ref: {
      bucket: "public-assets",
      path: uploadResult.path,
      publicUrl: uploadResult.publicUrl,
      mimeType: uploadResult.mimeType,
      size: uploadResult.size,
    },
    oldPath: validatedSourcePath,
    cleanupId: cleanupEnqueue.cleanupId,
  };
}

// ============================================================
// Storage audit reconciliation (Section 11.3)
// ============================================================

/**
 * Reconciliation 结果。
 *
 * fail-closed：RPC 调用失败时返回 { ok: false }，调用方必须不宣称对账完成。
 */
export type ReconcileResult =
  | {
      ok: true;
      /** 处理的对账项数量（0 表示没有 pending 操作需要处理）。 */
      processed: number;
      /** 成功补全审计的数量。 */
      completed: number;
      /** 标记为 failed 的数量（对象状态与审计期望不一致）。 */
      failed: number;
    }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * 读取 admin_storage_operations 中长期 pending 的操作，根据对象在 Storage 中的
 * 实际状态补全审计。处理的状态机：
 *
 *   1. 上传完成、审计 pending、对象存在 → 完成审计为 success
 *      （上传已成功，仅审计未补全）
 *   2. 上传完成、审计 pending、对象已被补偿删除 → 完成审计为 failed
 *      （补偿已执行，审计需标记为 failed 以反映实际状态）
 *   3. 删除完成、审计 pending、对象不存在 → 完成审计为 success
 *      （删除已成功，仅审计未补全）
 *   4. 删除失败、审计 pending、对象仍存在 → 完成审计为 failed
 *      （删除未生效，审计标记为 failed；对象由 cleanup queue 后续处理）
 *
 * 该函数不依赖日志，所有状态由 admin_storage_operations 表持久化。
 * 调用方应定期（如每小时）调用此函数处理长期 pending 操作。
 *
 * 安全：
 *   - 仅处理超过 minAgeSeconds 的 pending 操作，避免与正在进行的操作冲突
 *   - 使用 service_role 直接查询/更新 admin_storage_operations
 *   - 不删除对象、不入队 cleanup queue（仅补全审计状态）
 *   - 返回粗粒度计数，不泄露内部错误
 */
export async function reconcilePendingStorageAudit(options?: {
  /** 仅处理 pending 时间超过此阈值（秒）的操作，默认 300s（5 分钟）。 */
  minAgeSeconds?: number;
  /** 单次处理上限，默认 50。 */
  limit?: number;
}): Promise<ReconcileResult> {
  const minAge = Math.max(options?.minAgeSeconds ?? 300, 60);
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 1. 读取长期 pending 的操作
  let pendingOps: Array<{
    id: string;
    action: string;
    bucket: string;
    object_path: string;
  }> = [];

  try {
    const { data, error } = await client
      .from("admin_storage_operations")
      .select("id, action, bucket, object_path")
      .eq("status", "pending")
      .lt(
        "created_at",
        new Date(Date.now() - minAge * 1000).toISOString(),
      )
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) {
      console.error("RECONCILE_READ_FAILED", {
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    pendingOps = (data as typeof pendingOps) || [];
  } catch {
    console.error("RECONCILE_READ_EXCEPTION", {
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  if (pendingOps.length === 0) {
    return { ok: true, processed: 0, completed: 0, failed: 0 };
  }

  let completed = 0;
  let failed = 0;

  // 2. 逐个检查对象是否存在并补全审计
  for (const op of pendingOps) {
    let objectExists: boolean;
    try {
      // 使用 list 检查对象是否存在（避免 download 大文件）
      const listResult = await client.storage
        .from(op.bucket)
        .list(op.object_path.split("/")[0], {
          search: op.object_path.split("/").pop() || "",
          limit: 1,
        });

      if (listResult.error) {
        // list 失败 → 跳过此操作，下次重试
        console.error("RECONCILE_LIST_FAILED", {
          operationId: op.id,
          code: "RECONCILE_LIST_FAILED",
        });
        continue;
      }

      const matchName = op.object_path.split("/").pop() || "";
      objectExists = (listResult.data || []).some(
        (item) => item.name === matchName,
      );
    } catch {
      // 异常 → 跳过，下次重试
      console.error("RECONCILE_LIST_EXCEPTION", {
        operationId: op.id,
        code: "RECONCILE_LIST_EXCEPTION",
      });
      continue;
    }

    // 状态机：根据 action 和 objectExists 决定审计完成状态
    let auditSuccess: boolean;
    if (op.action === "storage.upload") {
      // 上传：对象存在 = 成功；对象不存在 = 失败（已被补偿删除）
      auditSuccess = objectExists;
    } else if (op.action === "storage.delete") {
      // 删除：对象不存在 = 成功；对象存在 = 失败（删除未生效）
      auditSuccess = !objectExists;
    } else {
      // 未知 action → 跳过
      continue;
    }

    try {
      const auditEnd = await completeStorageAudit(
        client,
        op.id,
        auditSuccess,
        auditSuccess ? undefined : "RECONCILE_STATE_MISMATCH",
      );

      if (auditEnd.ok) {
        if (auditSuccess) {
          completed++;
        } else {
          failed++;
        }
      }
      // auditEnd 失败时跳过，下次重试
    } catch {
      // 异常 → 跳过，下次重试
      console.error("RECONCILE_COMPLETE_EXCEPTION", {
        operationId: op.id,
        code: "RECONCILE_COMPLETE_EXCEPTION",
      });
    }
  }

  return {
    ok: true,
    processed: pendingOps.length,
    completed,
    failed,
  };
}
