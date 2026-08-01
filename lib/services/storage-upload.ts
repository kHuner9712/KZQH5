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
  sanitizeStoragePath,
  validateFileSize,
  validateMimeExtensionConsistency,
  validateMimeType,
  validateUploadFile,
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
 *
 * Review #2 Work Package 7: 上限受 EdgeOne Cloud Functions 平台 6MB 请求体
 * 限制约束。路由层 MAX_REQUEST_BYTES=5MB / MAX_FILE_BYTES=4.5MB；per-MIME
 * 限制统一为 4MB 以留出 multipart 框架开销。
 *   - 图片（jpeg/png/webp）：4MB（4194304 字节，此前为 5MB）
 *   - PDF：4MB（4194304 字节，此前为 20MB）
 *
 * 此前 4-20MB 范围内的 PDF 在单阶段上传路径下不再可用。两阶段上传
 * (authorize -> 直传 Supabase -> finalize) 已在 Phase 4 + Phase 5 实现，
 * 所有 admin UI 组件已接入两阶段上传路径。PDF 上限 20MB，图片上限 5MB。
 * 详见 docs/TWO_PHASE_UPLOAD_DESIGN.md 与 docs/LAUNCH_CHECKLIST.md。
 *
 * SVG、HTML、text/html、application/javascript 及任何可执行内容均不在白名单内，
 * 在 MIME 校验阶段即被拒绝；即便伪造 MIME，Magic Bytes 校验也会拦截。
 */
const MIME_MAX_SIZE: Readonly<Record<string, number>> = {
  "image/jpeg": 4 * 1024 * 1024, // 4194304
  "image/png": 4 * 1024 * 1024, // 4194304
  "image/webp": 4 * 1024 * 1024, // 4194304
  "application/pdf": 4 * 1024 * 1024, // 4194304
};

const PRIVATE_ASSETS_ALLOWED_MIME: readonly string[] = Object.keys(MIME_MAX_SIZE);

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
 *
 * KZQ-P0-005-a: Delegates to the shared `validateUploadFile` from
 * `lib/validation/storage.ts` so that single-stage and two-stage
 * upload paths use the SAME validation pipeline and cannot drift.
 * This wrapper maps the shared fixed error codes to the
 * `AdminWriteErrorCode` union expected by the single-stage route.
 */
function validateSingleStageUploadFile(input: {
  mimeType: string;
  size: number;
  filename: string;
  bytes: Uint8Array;
}): { ok: true; mimeType: string; ext: string } | { ok: false; code: AdminWriteErrorCode } {
  const result = validateUploadFile({
    mimeType: input.mimeType,
    size: input.size,
    filename: input.filename,
    bytes: input.bytes,
    allowedMime: PRIVATE_ASSETS_ALLOWED_MIME,
    maxSizeByMime: MIME_MAX_SIZE,
  });

  if (!result.ok) {
    // Map shared validation error codes to AdminWriteErrorCode.
    const code: AdminWriteErrorCode =
      result.error === "MIME_NOT_ALLOWED"
        ? "ADMIN_WRITE_UNSUPPORTED_MEDIA"
        : result.error === "SIZE_EXCEEDS_LIMIT"
          ? "ADMIN_WRITE_PAYLOAD_TOO_LARGE"
          : result.error === "MAGIC_BYTES_MISMATCH"
            ? "ADMIN_WRITE_UNSUPPORTED_MEDIA"
            : "ADMIN_WRITE_BAD_REQUEST"; // EXTENSION_MIME_INCONSISTENT
    return { ok: false, code };
  }

  return { ok: true, mimeType: result.mimeType, ext: result.ext };
}

/**
 * 服务端生成存储路径：{category}/{uuid}.{ext}。
 * 客户端无法提供完整 Storage Path —— 仅提供 category（白名单校验）。
 * category 不参与 sanitize（已是枚举白名单）；ext 仅允许字母数字与点号。
 */
export function generatePrivateStoragePath(
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
 *
 * KZQ-P0-005-c: Exported so the two-stage upload path can share the
 * SAME fail-closed audit saga as the single-stage path. Both paths
 * record a pending `admin_storage_operations` row BEFORE the object
 * operation and complete it AFTER, preventing drift.
 */
export type AuditStartedResult =
  | { ok: true; operationId: string }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * 在 admin_storage_operations 中插入一条 pending 记录。
 * 调用方在操作开始前调用，操作结束后调用 completeStorageAudit。
 *
 * fail-closed：若审计开始失败，返回 { ok: false }，调用方必须 NOT 执行
 * 实际业务操作。这避免「业务操作成功但审计缺失」的不一致状态。
 */
export async function recordStorageAuditStarted(input: {
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
export type AuditCompleteResult =
  | { ok: true }
  | { ok: false; code: AdminWriteErrorCode };

/**
 * 将 pending 审计记录更新为 completed 或 failed。
 *
 * fail-closed：返回结果给调用方，调用方在失败时执行补偿。
 * 不再静默吞错。
 */
export async function completeStorageAudit(
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
 * 补偿删除结果。
 *
 * KZQ-P0-005-e: Exported so the two-stage upload path can share the
 * SAME compensation semantics as the single-stage path. Both paths
 * now call this function (instead of the two-stage path using inline
 * `client.storage.from(...).remove(...)`) so that:
 *   - exceptions are caught (no uncaught throw during compensation)
 *   - fixed log codes are emitted (no silent swallow)
 *   - a discriminated union is returned (no inline `.error` check drift)
 */
export type CompensateDeleteResult =
  | { ok: true }
  | { ok: false };

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
 *
 * KZQ-P0-005-e: Exported so the two-stage upload path shares the SAME
 * compensation function as the single-stage path, preventing drift in
 * try/catch coverage, fixed log codes, and return-shape contract.
 */
export async function compensateDeleteUploadedObject(
  client: SupabaseClient<Database>,
  bucket: string,
  path: string,
): Promise<CompensateDeleteResult> {
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

// KZQ-P0-005-f: The private `enqueueResidualObjectForCleanup` wrapper has
// been REMOVED. The single-stage path now calls the SAME public
// `enqueueStorageCleanup` function that the two-stage path already uses.
// This unifies: (1) input validation (bucket whitelist + non-empty path),
// (2) discriminated union return (`{ ok: true; cleanupId } | { ok: false; code }`),
// (3) fixed log codes (`STORAGE_CLEANUP_ENQUEUE_FAILED` /
// `STORAGE_CLEANUP_ENQUEUE_EXCEPTION`). Both paths now share the same
// domain service for cleanup enqueue, preventing validation and error-
// handling drift. Note: `enqueueStorageCleanup` creates its own admin
// client internally; the previously-passed-in `client` argument is no
// longer needed because cleanup enqueue is an edge case (only when
// compensation fails), not a hot path.

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

  const validated = validateSingleStageUploadFile(input);
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
      // KZQ-P0-005-f: Use shared `enqueueStorageCleanup` (same as two-stage path)
      await enqueueStorageCleanup({
        bucket: PRIVATE_ASSETS_BUCKET,
        objectPath: path,
        reason: "orphan_detected",
        sourceType: "storage.upload",
        sourceId: operationId,
      });
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
export function generatePublicStoragePath(
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

  const validated = validateSingleStageUploadFile(input);
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
      // KZQ-P0-005-f: Use shared `enqueueStorageCleanup` (same as two-stage path)
      await enqueueStorageCleanup({
        bucket: PUBLIC_ASSETS_BUCKET,
        objectPath: path,
        reason: "orphan_detected",
        sourceType: "storage.upload",
        sourceId: operationId,
      });
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
 * Section 5 重写：使用 claim_catalog_asset_publish + finalize_catalog_asset_publish
 * 两阶段协议。旧 publish_catalog_asset RPC 不再被生产代码调用。
 *
 * 流程：
 *   1. claim_catalog_asset_publish(assetId, expected_updated_at) — 强制乐观锁
 *      返回可信 source_bucket / source_object_path / publish_token。
 *   2. 从 private-assets 下载字节（使用 RPC 返回的可信 path，不读 file_url）
 *   3. 服务端重新校验 Magic Bytes / MIME / size / SHA-256
 *   4. 上传到 public-assets（fail-closed 审计 Saga）
 *   5. finalize_catalog_asset_publish(assetId, token, public_ref, ...)
 *      — 原子事务：更新 published ref + publish_status=published + cleanup enqueue + audit
 *   6. finalize 失败 → 补偿删除新 public 对象
 *   7. 补偿删除失败 → 入队 cleanup queue 让 dispatcher 后续处理
 *
 * 旧 publish_catalog_asset RPC 暂时保留兼容但生产代码不再调用。
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
 * 应用层 Catalog 发布流程（两阶段 claim/finalize 协议）。
 *
 * 客户端必须提交 assetId + expectedUpdatedAt（强制乐观锁）。
 *
 * 客户端不再提交 file_url / source path / public URL，全部由服务端从
 * RPC 返回的可信字段读取。这样彻底切断了"客户端推断 private path"的路径。
 *
 * 幂等性：claim 返回 status='already_published' 时，直接返回当前 ref，
 * 不复制第二份。
 *
 * 并发安全：claim 的 SELECT ... FOR UPDATE + publish_token 保证只有一个
 * 调用方能进入 publishing 状态；其他调用方收到 40P01 并被映射为
 * ADMIN_WRITE_CONFLICT。
 */
export async function publishCatalogAssetFlow(input: {
  assetId: string;
  /**
   * 调用方读取的 product_assets.updated_at。Section 5 强制乐观锁：
   * claim RPC 会用此值校验行版本，stale 时返回 40P01。
   */
  expectedUpdatedAt: string;
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
  if (typeof input.expectedUpdatedAt !== "string" || input.expectedUpdatedAt.length === 0) {
    // Section 5: 缺失 expected_updated_at → 22004 / ADMIN_WRITE_BAD_REQUEST
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // ----------------------------------------------------------------
  // Phase 1: claim_catalog_asset_publish
  //   - 强制乐观锁（expected_updated_at 必填，NULL/stale 拒绝）
  //   - 校验 is_published / access_level / authorization_status
  //   - 返回可信 source_bucket / source_object_path / publish_token
  // ----------------------------------------------------------------
  type ClaimResult = {
    status: string;
    asset_id: string;
    source_bucket: string | null;
    source_object_path: string | null;
    mime_type: string | null;
    publish_token: string | null;
    updated_at: string;
    // already_published 字段（status=already_published 时存在）
    published_bucket?: string | null;
    published_object_path?: string | null;
    file_url?: string | null;
  };
  let claimResult: ClaimResult | null = null;

  try {
    const { data, error } = await client.rpc("claim_catalog_asset_publish", {
      p_asset_id: input.assetId,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: input.options?.actorId ?? null,
      p_actor_email: input.options?.actorEmail ?? null,
      p_actor_role: input.options?.actorRole ?? null,
    });

    if (error) {
      const errCode = (error as { code?: string }).code ?? "";
      // 22004 = bad request (precondition failed / expected_updated_at missing)
      // P0002 = asset not found
      if (errCode === "22004" || errCode === "P0002") {
        return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
      }
      // 40P01 = stale updated_at / concurrent publish conflict
      if (errCode === "40P01" || errCode === "40001" || errCode === "23505") {
        return { ok: false, code: "ADMIN_WRITE_CONFLICT" };
      }
      console.error("PUBLISH_CLAIM_FAILED", {
        assetId: input.assetId,
        errCode,
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    claimResult = data as ClaimResult | null;
  } catch (err) {
    const errCode = (err as { code?: string }).code ?? "";
    console.error("PUBLISH_CLAIM_EXCEPTION", {
      assetId: input.assetId,
      errCode,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  if (!claimResult) {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 幂等：已发布 → 直接返回当前 public ref，不复制第二份
  if (claimResult.status === "already_published") {
    const publishedPath = claimResult.published_object_path ?? "";
    const publishedUrl = claimResult.file_url ?? "";
    if (!publishedPath || !publishedUrl) {
      // 状态不一致：声称已发布但 ref 缺失 → 拒绝（不让调用方误以为发布成功）
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return {
      ok: true,
      ref: {
        bucket: "public-assets",
        path: publishedPath,
        publicUrl: publishedUrl,
        mimeType: claimResult.mime_type ?? "application/octet-stream",
        size: 0,
      },
      oldPath: publishedPath,
      cleanupId: null,
    };
  }

  if (claimResult.status !== "claimed") {
    // 未知状态 → 拒绝
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 从 RPC 返回的可信字段读取源 ref，不再解析客户端 file_url
  const trustedSourcePath = claimResult.source_object_path ?? "";
  const trustedMimeType = (claimResult.mime_type ?? "").toLowerCase().trim() ||
    "application/octet-stream";
  const publishToken = claimResult.publish_token ?? "";

  if (!trustedSourcePath || !publishToken) {
    // RPC 应当保证这些字段，缺失即协议错误
    console.error("PUBLISH_CLAIM_INCOMPLETE_FIELDS", {
      assetId: input.assetId,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 校验 source path 格式（防 path traversal；RPC 已校验过，应用层再校验一次）
  const pathValidation = validatePrivateAssetPath(trustedSourcePath);
  if (!pathValidation.ok) {
    return { ok: false, code: pathValidation.code };
  }
  const validatedSourcePath = pathValidation.path;

  // ----------------------------------------------------------------
  // Phase 2a: 下载 private-assets 字节
  // ----------------------------------------------------------------
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

  // ----------------------------------------------------------------
  // Phase 2b: 重新校验 Magic Bytes / MIME / size
  //   不信任 private-assets 已存内容（可能被其他流程污染）
  // ----------------------------------------------------------------
  const mimeResult = validateMimeType(trustedMimeType, PRIVATE_ASSETS_ALLOWED_MIME);
  if (!mimeResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_UNSUPPORTED_MEDIA" };
  }

  const maxSize = MIME_MAX_SIZE[trustedMimeType] ?? 0;
  const sizeResult = validateFileSize(bytes.length, maxSize);
  if (!sizeResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_PAYLOAD_TOO_LARGE" };
  }

  const magicResult = verifyMagicBytes(bytes, trustedMimeType);
  if (!magicResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_UNSUPPORTED_MEDIA" };
  }

  const sha256 = computeSha256Hex(bytes);
  const sourceFilename = validatedSourcePath.split("/").pop() || "";

  // ----------------------------------------------------------------
  // Phase 2c: 上传到 public-assets（fail-closed 审计 Saga）
  //   category 用 "documents"（public-assets 顶层白名单包含）
  // ----------------------------------------------------------------
  const targetCategory = "documents";
  const uploadResult = await uploadToPublicAssets(
    {
      bytes,
      mimeType: trustedMimeType,
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
   * 不抛错；调用方根据 finalize 错误码返回相应的失败结果。
   */
  const compensatePublicCopy = async (): Promise<void> => {
    const compensate = await compensateDeleteUploadedObject(
      client,
      PUBLIC_ASSETS_BUCKET,
      uploadResult.path,
    );
    if (!compensate.ok) {
      // 补偿删除失败 → 入队 cleanup queue 让 dispatcher 后续处理
      // KZQ-P0-005-f: Use shared `enqueueStorageCleanup` (same as two-stage path)
      await enqueueStorageCleanup({
        bucket: PUBLIC_ASSETS_BUCKET,
        objectPath: uploadResult.path,
        reason: "orphan_detected",
        sourceType: "catalog_publish",
        sourceId: input.assetId,
      });
    }
  };

  // ----------------------------------------------------------------
  // Phase 2d: finalize_catalog_asset_publish — 原子事务
  //   - 验证 publish_token + publish_status='publishing'
  //   - 更新 published_bucket / published_object_path / file_url
  //   - publish_status='published', publish_token=null
  //   - enqueue_storage_cleanup (旧 private source)
  //   - 写 admin_audit_log（原子，审计失败整体回滚）
  //
  // 失败处理：
  //   - 40P01 (token mismatch / status mismatch) → ADMIN_WRITE_CONFLICT
  //   - 22004 / P0002 → ADMIN_WRITE_BAD_REQUEST
  //   - 其他 → ADMIN_WRITE_FAILED
  //   - 任何失败都执行 compensatePublicCopy
  // ----------------------------------------------------------------
  type FinalizeResult = {
    status: string;
    asset_id: string;
    published_bucket: string;
    published_object_path: string;
    file_url: string;
    cleanup_id: string | null;
  };
  let finalizeResult: FinalizeResult | null = null;

  try {
    const { data, error } = await client.rpc("finalize_catalog_asset_publish", {
      p_asset_id: input.assetId,
      p_publish_token: publishToken,
      p_public_bucket: PUBLIC_ASSETS_BUCKET,
      p_public_object_path: uploadResult.path,
      p_public_url: uploadResult.publicUrl,
      p_mime_type: uploadResult.mimeType,
      p_size_bytes: uploadResult.size,
      p_sha256: sha256,
      p_actor_id: input.options?.actorId ?? null,
      p_actor_email: input.options?.actorEmail ?? null,
      p_actor_role: input.options?.actorRole ?? null,
    });

    if (error) {
      const errCode = (error as { code?: string }).code ?? "";
      // 40P01 = token mismatch / status mismatch / serialization failure
      if (errCode === "40P01" || errCode === "40001" || errCode === "23505") {
        await compensatePublicCopy();
        return { ok: false, code: "ADMIN_WRITE_CONFLICT" };
      }
      // 22004 = bad request (precondition failed)
      // P0002 = asset not found
      if (errCode === "22004" || errCode === "P0002") {
        await compensatePublicCopy();
        return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
      }
      console.error("PUBLISH_FINALIZE_FAILED", {
        assetId: input.assetId,
        errCode,
        code: "ADMIN_WRITE_FAILED",
      });
      await compensatePublicCopy();
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    finalizeResult = data as FinalizeResult | null;
  } catch (err) {
    const errCode = (err as { code?: string }).code ?? "";
    console.error("PUBLISH_FINALIZE_EXCEPTION", {
      assetId: input.assetId,
      errCode,
      code: "ADMIN_WRITE_FAILED",
    });
    await compensatePublicCopy();
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  if (!finalizeResult) {
    await compensatePublicCopy();
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // ----------------------------------------------------------------
  // Phase 2e: 返回结果
  //   finalize 已经在同一事务中 enqueue 了旧 private source 的 cleanup，
  //   所以应用层不需要再调用 enqueueStorageCleanup。
  //   finalize 返回 cleanup_id（可能为 null，表示旧 source 已无或非 private）。
  // ----------------------------------------------------------------
  return {
    ok: true,
    ref: {
      bucket: "public-assets",
      path: uploadResult.path,
      publicUrl: uploadResult.publicUrl,
      mimeType: uploadResult.mimeType,
      size: uploadResult.size,
      sha256,
    },
    oldPath: validatedSourcePath,
    cleanupId: finalizeResult.cleanup_id ?? null,
  };
}

// ============================================================
// Certificate publication flow (private→public)
// ============================================================

/**
 * Certificate 发布应用层流程结果。
 *
 * Section 6: 与 Catalog 完全等价的两阶段 claim/finalize 协议，仅调用
 * claim_certificate_publish + finalize_certificate_publish RPC。
 *
 * 流程：
 *   1. claim_certificate_publish(certificateId, expected_updated_at) — 强制乐观锁
 *      返回可信 source_bucket / source_object_path / publish_token。
 *   2. 从 private-assets 下载字节（使用 RPC 返回的可信 path，不读 image_url）
 *   3. 服务端重新校验 Magic Bytes / MIME / size / SHA-256
 *   4. 上传到 public-assets（fail-closed 审计 Saga）
 *   5. finalize_certificate_publish(certificateId, token, public_ref, ...)
 *      — 原子事务：更新 published ref + publish_status=published + cleanup enqueue + audit
 *   6. finalize 失败 → 补偿删除新 public 对象
 *   7. 补偿删除失败 → 入队 cleanup queue 让 dispatcher 后续处理
 */
export type PublishCertificateResult =
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
 * 应用层 Certificate 发布流程（两阶段 claim/finalize 协议）。
 *
 * 客户端必须提交 certificateId + expectedUpdatedAt（强制乐观锁）。
 * 客户端不再提交 image_url / source path / public URL，全部由服务端从
 * RPC 返回的可信字段读取。这样彻底切断了"客户端推断 private path"的路径。
 *
 * 幂等性：claim 返回 status='already_published' 时，直接返回当前 ref，
 * 不复制第二份。
 *
 * 并发安全：claim 的 SELECT ... FOR UPDATE + publish_token 保证只有一个
 * 调用方能进入 publishing 状态；其他调用方收到 40P01 并被映射为
 * ADMIN_WRITE_CONFLICT。
 */
export async function publishCertificateFlow(input: {
  certificateId: string;
  /**
   * 调用方读取的 certificates.updated_at。Section 6 强制乐观锁：
   * claim RPC 会用此值校验行版本，stale 时返回 40P01。
   */
  expectedUpdatedAt: string;
  options?: {
    actorId?: string | null;
    actorEmail?: string | null;
    actorRole?: string | null;
  };
}): Promise<PublishCertificateResult> {
  if (
    typeof input.certificateId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.certificateId,
    )
  ) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (typeof input.expectedUpdatedAt !== "string" || input.expectedUpdatedAt.length === 0) {
    // Section 5/6: 缺失 expected_updated_at → 22004 / ADMIN_WRITE_BAD_REQUEST
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // ----------------------------------------------------------------
  // Phase 1: claim_certificate_publish
  // ----------------------------------------------------------------
  type ClaimResult = {
    status: string;
    id: string;
    source_bucket: string | null;
    source_object_path: string | null;
    mime_type: string | null;
    publish_token: string | null;
    updated_at: string;
    // already_published 字段
    published_bucket?: string | null;
    published_object_path?: string | null;
    image_url?: string | null;
  };
  let claimResult: ClaimResult | null = null;

  try {
    const { data, error } = await client.rpc("claim_certificate_publish", {
      p_id: input.certificateId,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: input.options?.actorId ?? null,
      p_actor_email: input.options?.actorEmail ?? null,
      p_actor_role: input.options?.actorRole ?? null,
    });

    if (error) {
      const errCode = (error as { code?: string }).code ?? "";
      // 22004 = bad request (precondition failed / expected_updated_at missing)
      // P0002 = certificate not found
      if (errCode === "22004" || errCode === "P0002") {
        return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
      }
      // 40P01 = stale updated_at / concurrent publish conflict
      if (errCode === "40P01" || errCode === "40001" || errCode === "23505") {
        return { ok: false, code: "ADMIN_WRITE_CONFLICT" };
      }
      console.error("CERT_PUBLISH_CLAIM_FAILED", {
        certificateId: input.certificateId,
        errCode,
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    claimResult = data as ClaimResult | null;
  } catch (err) {
    const errCode = (err as { code?: string }).code ?? "";
    console.error("CERT_PUBLISH_CLAIM_EXCEPTION", {
      certificateId: input.certificateId,
      errCode,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  if (!claimResult) {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 幂等：已发布 → 直接返回当前 public ref，不复制第二份
  if (claimResult.status === "already_published") {
    const publishedPath = claimResult.published_object_path ?? "";
    const publishedUrl = claimResult.image_url ?? "";
    if (!publishedPath || !publishedUrl) {
      // 状态不一致：声称已发布但 ref 缺失 → 拒绝
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return {
      ok: true,
      ref: {
        bucket: "public-assets",
        path: publishedPath,
        publicUrl: publishedUrl,
        mimeType: claimResult.mime_type ?? "application/octet-stream",
        size: 0,
      },
      oldPath: publishedPath,
      cleanupId: null,
    };
  }

  if (claimResult.status !== "claimed") {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 从 RPC 返回的可信字段读取源 ref，不再解析客户端 image_url
  const trustedSourcePath = claimResult.source_object_path ?? "";
  const trustedMimeType = (claimResult.mime_type ?? "").toLowerCase().trim() ||
    "application/octet-stream";
  const publishToken = claimResult.publish_token ?? "";

  if (!trustedSourcePath || !publishToken) {
    console.error("CERT_PUBLISH_CLAIM_INCOMPLETE_FIELDS", {
      certificateId: input.certificateId,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 校验 source path 格式（防 path traversal；RPC 已校验过，应用层再校验一次）
  const pathValidation = validatePrivateAssetPath(trustedSourcePath);
  if (!pathValidation.ok) {
    return { ok: false, code: pathValidation.code };
  }
  const validatedSourcePath = pathValidation.path;

  // ----------------------------------------------------------------
  // Phase 2a: 下载 private-assets 字节
  // ----------------------------------------------------------------
  let bytes: Uint8Array;
  try {
    const downloadResponse = await client.storage
      .from(PRIVATE_ASSETS_BUCKET)
      .download(validatedSourcePath);

    if (downloadResponse.error) {
      console.error("CERT_PUBLISH_SOURCE_DOWNLOAD_FAILED", {
        certificateId: input.certificateId,
        path: validatedSourcePath,
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }

    const blob = downloadResponse.data;
    const ab = await blob.arrayBuffer();
    bytes = new Uint8Array(ab);
  } catch {
    console.error("CERT_PUBLISH_SOURCE_DOWNLOAD_EXCEPTION", {
      certificateId: input.certificateId,
      path: validatedSourcePath,
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // ----------------------------------------------------------------
  // Phase 2b: 重新校验 Magic Bytes / MIME / size
  // ----------------------------------------------------------------
  const mimeResult = validateMimeType(trustedMimeType, PRIVATE_ASSETS_ALLOWED_MIME);
  if (!mimeResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_UNSUPPORTED_MEDIA" };
  }

  const maxSize = MIME_MAX_SIZE[trustedMimeType] ?? 0;
  const sizeResult = validateFileSize(bytes.length, maxSize);
  if (!sizeResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_PAYLOAD_TOO_LARGE" };
  }

  const magicResult = verifyMagicBytes(bytes, trustedMimeType);
  if (!magicResult.ok) {
    return { ok: false, code: "ADMIN_WRITE_UNSUPPORTED_MEDIA" };
  }

  const sha256 = computeSha256Hex(bytes);
  const sourceFilename = validatedSourcePath.split("/").pop() || "";

  // ----------------------------------------------------------------
  // Phase 2c: 上传到 public-assets
  //   category 用 "certificates"（public-assets 顶层白名单包含）
  // ----------------------------------------------------------------
  const targetCategory = "certificates";
  const uploadResult = await uploadToPublicAssets(
    {
      bytes,
      mimeType: trustedMimeType,
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
   */
  const compensatePublicCopy = async (): Promise<void> => {
    const compensate = await compensateDeleteUploadedObject(
      client,
      PUBLIC_ASSETS_BUCKET,
      uploadResult.path,
    );
    if (!compensate.ok) {
      // 补偿删除失败 → 入队 cleanup queue 让 dispatcher 后续处理
      // KZQ-P0-005-f: Use shared `enqueueStorageCleanup` (same as two-stage path)
      await enqueueStorageCleanup({
        bucket: PUBLIC_ASSETS_BUCKET,
        objectPath: uploadResult.path,
        reason: "orphan_detected",
        sourceType: "certificate_publish",
        sourceId: input.certificateId,
      });
    }
  };

  // ----------------------------------------------------------------
  // Phase 2d: finalize_certificate_publish — 原子事务
  // ----------------------------------------------------------------
  type FinalizeResult = {
    status: string;
    id: string;
    published_bucket: string;
    published_object_path: string;
    image_url: string;
    cleanup_id: string | null;
  };
  let finalizeResult: FinalizeResult | null = null;

  try {
    const { data, error } = await client.rpc("finalize_certificate_publish", {
      p_id: input.certificateId,
      p_publish_token: publishToken,
      p_public_bucket: PUBLIC_ASSETS_BUCKET,
      p_public_object_path: uploadResult.path,
      p_public_url: uploadResult.publicUrl,
      p_mime_type: uploadResult.mimeType,
      p_size_bytes: uploadResult.size,
      p_sha256: sha256,
      p_actor_id: input.options?.actorId ?? null,
      p_actor_email: input.options?.actorEmail ?? null,
      p_actor_role: input.options?.actorRole ?? null,
    });

    if (error) {
      const errCode = (error as { code?: string }).code ?? "";
      // 40P01 = token mismatch / status mismatch / serialization failure
      if (errCode === "40P01" || errCode === "40001" || errCode === "23505") {
        await compensatePublicCopy();
        return { ok: false, code: "ADMIN_WRITE_CONFLICT" };
      }
      // 22004 = bad request (precondition failed)
      // P0002 = certificate not found
      if (errCode === "22004" || errCode === "P0002") {
        await compensatePublicCopy();
        return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
      }
      console.error("CERT_PUBLISH_FINALIZE_FAILED", {
        certificateId: input.certificateId,
        errCode,
        code: "ADMIN_WRITE_FAILED",
      });
      await compensatePublicCopy();
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    finalizeResult = data as FinalizeResult | null;
  } catch (err) {
    const errCode = (err as { code?: string }).code ?? "";
    console.error("CERT_PUBLISH_FINALIZE_EXCEPTION", {
      certificateId: input.certificateId,
      errCode,
      code: "ADMIN_WRITE_FAILED",
    });
    await compensatePublicCopy();
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  if (!finalizeResult) {
    await compensatePublicCopy();
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // ----------------------------------------------------------------
  // Phase 2e: 返回结果
  // ----------------------------------------------------------------
  return {
    ok: true,
    ref: {
      bucket: "public-assets",
      path: uploadResult.path,
      publicUrl: uploadResult.publicUrl,
      mimeType: uploadResult.mimeType,
      size: uploadResult.size,
      sha256,
    },
    oldPath: validatedSourcePath,
    cleanupId: finalizeResult.cleanup_id ?? null,
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
 * 安全（Section 10 修复）：
 *   - 使用 `claim_storage_audit_reconcile` RPC 原子领取（FOR UPDATE SKIP
 *     LOCKED + per-row lock_token），多 Worker 不会重复处理同一行。
 *   - 使用 `complete_storage_audit_reconcile` RPC 完成审计，强制 token 校验。
 *   - 路径存在性检查使用完整父目录（split 全部段，最后一段为 filename），
 *     不再只取第一段目录。
 *   - 使用精确对象路径匹配（item.name === filename && !item.isDir），
 *     不依赖模糊 search 结果。
 *   - `processed` 仅累计真正被 claim 的行数；claim 之前因 RPC 失败而未处理
 *     的行不计入 processed。
 *   - stale-lock recovery 由 `claim_storage_audit_reconcile` 内置：
 *     reconcile_locked_at 超过 stale_timeout 的行会被重新领取。
 *   - 仅处理超过 minAgeSeconds 的 pending 操作，避免与正在进行的操作冲突。
 *   - 使用 service_role 直接调用 RPC；不删除对象、不入队 cleanup queue。
 *   - 返回粗粒度计数，不泄露内部错误。
 */
export async function reconcilePendingStorageAudit(options?: {
  /** 仅处理 pending 时间超过此阈值（秒）的操作，默认 300s（5 分钟）。 */
  minAgeSeconds?: number;
  /** 单次处理上限，默认 50。 */
  limit?: number;
  /** Stale-lock 恢复阈值（秒），默认 300s。 */
  staleTimeoutSeconds?: number;
}): Promise<ReconcileResult> {
  const minAge = Math.max(options?.minAgeSeconds ?? 300, 60);
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const staleTimeout = Math.max(options?.staleTimeoutSeconds ?? 300, 60);

  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  // 1. 调用 claim_storage_audit_reconcile 原子领取待处理行
  //    - FOR UPDATE SKIP LOCKED 防并发冲突
  //    - 每行生成独立 lock_token，complete 时必须 token 匹配
  //    - reconcile_locked_at 早于 stale_cutoff 的行会被重新领取（stale recovery）
  let claimedOps: Array<{
    id: string;
    action: string;
    bucket: string;
    object_path: string;
    lock_token: string;
  }> = [];

  try {
    const { data, error } = await client.rpc("claim_storage_audit_reconcile", {
      p_min_age_seconds: minAge,
      p_limit: limit,
      p_stale_timeout_seconds: staleTimeout,
    });

    if (error) {
      console.error("RECONCILE_CLAIM_FAILED", {
        code: "ADMIN_WRITE_FAILED",
      });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    if (Array.isArray(data)) {
      claimedOps = data.map((op: unknown) => {
        const row = op as Record<string, unknown>;
        return {
          id: String(row.id),
          action: String(row.action),
          bucket: String(row.bucket),
          object_path: String(row.object_path),
          lock_token: String(row.reconcile_lock_token),
        };
      });
    }
  } catch {
    console.error("RECONCILE_CLAIM_EXCEPTION", {
      code: "ADMIN_WRITE_FAILED",
    });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }

  if (claimedOps.length === 0) {
    return { ok: true, processed: 0, completed: 0, failed: 0 };
  }

  let completed = 0;
  let failed = 0;

  // 2. 逐个检查对象是否存在并补全审计
  for (const op of claimedOps) {
    // 完整父目录：split 全部段，最后一段为 filename，其余为目录。
    // Section 10 明确要求"多级路径存在性检查必须使用完整父目录"。
    const pathSegments = op.object_path.split("/");
    const fileName = pathSegments.pop() || "";
    // 当 path 为 "products/abc.jpg" 时 parentDir = "products"
    // 当 path 为 "products/covers/abc.jpg" 时 parentDir = "products/covers"
    // 当 path 只有一段时 parentDir = ""（root listing）
    const parentDir = pathSegments.join("/");

    let objectExists: boolean;
    try {
      // 使用 list 检查对象是否存在（避免 download 大文件）
      // parentDir 为空字符串时 list bucket root
      const listResult = await client.storage
        .from(op.bucket)
        .list(parentDir || undefined, {
          search: fileName,
          limit: 1,
        });

      if (listResult.error) {
        // list 失败 → 跳过此操作（行仍为 'claimed'，stale recovery 后续重试）
        console.error("RECONCILE_LIST_FAILED", {
          operationId: op.id,
          code: "RECONCILE_LIST_FAILED",
        });
        continue;
      }

      // 精确匹配：name 完全相等且不是目录。
      // Supabase Storage .list() 在运行时返回的 FileObject 含有 `isDir`
      // 字段（目录条目），但 @supabase/storage-js 类型定义未暴露。
      // 通过类型断言读取该字段；缺失时视为非目录（兼容旧 SDK）。
      objectExists = (listResult.data || []).some((item) => {
        if (item.name !== fileName) return false;
        const isDir = (item as { isDir?: boolean }).isDir === true;
        return !isDir;
      });
    } catch {
      // 异常 → 跳过，下次重试（stale recovery）
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
      // 未知 action → 跳过（行仍为 'claimed'，stale recovery 后续重试）
      continue;
    }

    try {
      // 使用 complete_storage_audit_reconcile RPC 完成审计
      //   - RPC 内部校验 lock_token 匹配
      //   - RPC 内部校验 status='pending'
      //   - token 不匹配或已被并发完成 → 返回 'NOT_FOUND_OR_TOKEN_MISMATCH'
      //   - 该 worker 不声称完成了它未真正完成的工作
      const { data: resultData, error: rpcError } = await client.rpc(
        "complete_storage_audit_reconcile",
        {
          p_operation_id: op.id,
          p_lock_token: op.lock_token,
          p_success: auditSuccess,
          p_error_code: auditSuccess ? null : "RECONCILE_STATE_MISMATCH",
        },
      );

      if (rpcError) {
        console.error("RECONCILE_COMPLETE_FAILED", {
          operationId: op.id,
          code: "RECONCILE_COMPLETE_FAILED",
        });
        continue;
      }

      const finalStatus = typeof resultData === "string" ? resultData : "";
      if (finalStatus === "completed") {
        completed++;
      } else if (finalStatus === "failed") {
        failed++;
      }
      // 'NOT_FOUND_OR_TOKEN_MISMATCH' / 'INVALID_PARAMS' → 不计入 completed/failed
      // 行可能已被另一 worker 处理或 token 失效，跳过
    } catch {
      // 异常 → 跳过，下次重试（stale recovery）
      console.error("RECONCILE_COMPLETE_EXCEPTION", {
        operationId: op.id,
        code: "RECONCILE_COMPLETE_EXCEPTION",
      });
    }
  }

  return {
    ok: true,
    // processed = 真正被 claim 的行数；不包括 claim 之前因 RPC 失败而未处理的行
    processed: claimedOps.length,
    completed,
    failed,
  };
}
