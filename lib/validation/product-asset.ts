import { catalogTopics } from "@/lib/catalog-topics";
import { validateAssetUrl } from "@/lib/client/viewer-utils";
import type {
  ProductAsset,
  ProductAssetType,
} from "@/types/database";

/**
 * Shared validation for Product Asset payloads.
 *
 * Used by:
 *   - the admin form (client) for immediate UI feedback
 *   - the repository `saveProductAsset` (last gate before Supabase insert/update)
 *
 * Because this runs in the same browser context as the admin form, it cannot
 * fully prevent a determined attacker with browser devtools from bypassing it.
 * The TRUE server-side enforcement is RLS + check constraints in Supabase.
 * This module enforces invariants consistently across the UI and repository
 * layers so a hand-edited URL or hidden field cannot silently produce an
 * invalid row.
 */

export const PRODUCT_ASSET_TYPES: readonly ProductAssetType[] = [
  "catalog",
  "datasheet",
  "installation",
  "certificate",
  "packaging",
  "other",
] as const;

/**
 * MIME types accepted per asset type.
 * `null` means "no MIME type recorded" (still allowed — we will rely on
 * extension instead). SVG is only accepted for `catalog` and `other` because
 * it can carry scripts and should not be uploaded for sensitive categories
 * like certificates.
 */
const ALLOWED_MIME_BY_TYPE: Record<ProductAssetType, ReadonlySet<string | null>> = {
  catalog: new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/svg+xml",
    null,
  ]),
  datasheet: new Set(["application/pdf", null]),
  installation: new Set(["application/pdf", null]),
  certificate: new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    null,
  ]),
  packaging: new Set(["application/pdf", null]),
  other: new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/svg+xml",
    "image/gif",
    null,
  ]),
};

/** Allowed MIME -> extension mapping for cross-consistency check. */
const MIME_EXTENSION_MAP: Readonly<Record<string, ReadonlySet<string>>> = {
  "application/pdf": new Set([".pdf"]),
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "image/png": new Set([".png"]),
  "image/webp": new Set([".webp"]),
  "image/svg+xml": new Set([".svg"]),
  "image/gif": new Set([".gif"]),
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type FieldErrors = Partial<Record<
  | "product_id"
  | "asset_type"
  | "catalog_topic_id"
  | "title_cn"
  | "title_en"
  | "description_cn"
  | "description_en"
  | "file_url"
  | "cover_image_url"
  | "file_size"
  | "mime_type"
  | "published_at"
  | "is_published"
  | "sort_order"
  | "content_hash",
  string[]
>>;

export interface ProductAssetValidationResult {
  ok: boolean;
  errors: FieldErrors;
}

export interface ProductAssetPayload {
  product_id: string | null;
  asset_type: ProductAssetType;
  catalog_topic_id: string | null;
  title_cn: string;
  title_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  file_url: string;
  cover_image_url: string | null;
  file_size: number | null;
  mime_type: string | null;
  is_published: boolean;
  sort_order: number;
  published_at: string | null;
  content_hash: string | null;
}

function pushError(target: FieldErrors, field: keyof FieldErrors, message: string): void {
  (target[field] ||= []).push(message);
}

function extractUrlExtension(url: string): string {
  const cleaned = (url || "").split("?")[0].split("#")[0];
  const match = cleaned.match(/\.([a-z0-9]{2,5})$/i);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/**
 * Validates a Product Asset payload against the KZQ catalog center rules.
 *
 * Rules:
 *   1. `title_cn` must be non-empty after trim.
 *   2. `asset_type` must be one of PRODUCT_ASSET_TYPES.
 *   3. `catalog_topic_id` (if non-null) must be a known topic id.
 *   4. `file_url` must pass `validateAssetUrl` (no protocol-relative, no
 *      javascript:/data:/file:, no public http).
 *   5. `cover_image_url` (if non-null) must pass `validateAssetUrl` and end
 *      with an image extension.
 *   6. `mime_type` (if non-null) must be allowed for the chosen asset_type.
 *   7. MIME and file extension must be consistent when both are present.
 *   8. `file_size` (if non-null) must be a non-negative finite number.
 *   9. `published_at` (if non-null) must match YYYY-MM-DD and be a real date.
 *  10. `is_published=true` requires a usable `file_url` (validated).
 *  11. `sort_order` must be a finite number.
 *  12. `content_hash` (if non-null) must be a short-ish ascii string.
 *
 * @param payload raw payload from the admin form
 * @param options.allowHttpForTesting pass true only in test environments
 *   that need to accept http://localhost.
 */
export function validateProductAssetPayload(
  payload: Partial<ProductAssetPayload>,
  options: { allowHttpForTesting?: boolean } = {},
): ProductAssetValidationResult {
  const errors: FieldErrors = {};
  const allowHttp = Boolean(options.allowHttpForTesting);

  // ----- title_cn -----
  const titleCn = (payload.title_cn || "").trim();
  if (!titleCn) {
    pushError(errors, "title_cn", "中文标题不能为空");
  } else if (titleCn.length > 200) {
    pushError(errors, "title_cn", "中文标题过长");
  }

  // ----- asset_type -----
  const assetType = payload.asset_type;
  if (!assetType || !PRODUCT_ASSET_TYPES.includes(assetType)) {
    pushError(errors, "asset_type", "资料类型不合法");
  }

  // ----- catalog_topic_id -----
  const topicId = payload.catalog_topic_id?.trim() || null;
  if (topicId) {
    const known = catalogTopics.some((topic) => topic.id === topicId);
    if (!known) {
      pushError(errors, "catalog_topic_id", "未知的目录主题");
    }
  }

  // ----- file_url -----
  const fileUrl = (payload.file_url || "").trim();
  if (!fileUrl) {
    pushError(errors, "file_url", "文件 URL 不能为空");
  } else {
    const urlResult = validateAssetUrl(fileUrl, allowHttp);
    if (!urlResult.ok) {
      pushError(errors, "file_url", `文件 URL 不合法:${urlResult.reason}`);
    }
  }

  // ----- cover_image_url -----
  const coverUrl = (payload.cover_image_url || "").trim() || null;
  if (coverUrl) {
    const coverResult = validateAssetUrl(coverUrl, allowHttp);
    if (!coverResult.ok) {
      pushError(errors, "cover_image_url", `封面 URL 不合法:${coverResult.reason}`);
    } else {
      const ext = extractUrlExtension(coverUrl);
      const validImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".svg", ".gif"]);
      if (ext && !validImageExtensions.has(ext)) {
        pushError(errors, "cover_image_url", "封面必须是图片格式(jpg/png/webp/svg/gif)");
      }
    }
  }

  // ----- mime_type -----
  const mimeType = (payload.mime_type || "").trim() || null;
  if (mimeType) {
    const lower = mimeType.toLowerCase();
    const allowed = assetType ? ALLOWED_MIME_BY_TYPE[assetType] : undefined;
    if (allowed && !allowed.has(lower) && !allowed.has(null)) {
      pushError(errors, "mime_type", `当前资料类型不支持 MIME:${mimeType}`);
    } else if (allowed && !allowed.has(lower) && allowed.has(null)) {
      // MIME not in allowed set and null is allowed → reject unknown MIME
      pushError(errors, "mime_type", `当前资料类型不支持 MIME:${mimeType}`);
    }

    // MIME <-> extension consistency
    if (fileUrl) {
      const ext = extractUrlExtension(fileUrl);
      const expected = MIME_EXTENSION_MAP[lower];
      if (ext && expected && !expected.has(ext)) {
        pushError(
          errors,
          "mime_type",
          `MIME 与扩展名不匹配:MIME=${mimeType},URL 扩展名=${ext}`,
        );
      }
    }
  }

  // ----- file_size -----
  const fileSize = payload.file_size;
  if (fileSize !== null && fileSize !== undefined) {
    if (typeof fileSize !== "number" || !Number.isFinite(fileSize) || fileSize < 0) {
      pushError(errors, "file_size", "文件大小必须为非负数");
    } else if (fileSize > 1024 * 1024 * 1024 * 2) {
      // Reasonable upper bound — 2 GiB. Anything larger is almost certainly a unit bug.
      pushError(errors, "file_size", "文件大小超出合理上限");
    }
  }

  // ----- published_at -----
  const publishedAt = (payload.published_at || "").trim() || null;
  if (publishedAt) {
    if (!DATE_PATTERN.test(publishedAt)) {
      pushError(errors, "published_at", "发布日期格式必须为 YYYY-MM-DD");
    } else {
      const parsed = new Date(`${publishedAt}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime())) {
        pushError(errors, "published_at", "发布日期不是有效日期");
      } else {
        const yyyy = String(parsed.getUTCFullYear());
        const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(parsed.getUTCDate()).padStart(2, "0");
        if (`${yyyy}-${mm}-${dd}` !== publishedAt) {
          pushError(errors, "published_at", "发布日期不是有效日期");
        }
      }
    }
  }

  // ----- is_published requires usable file -----
  if (payload.is_published) {
    if (!fileUrl) {
      pushError(errors, "is_published", "发布状态下必须填写可用文件 URL");
    } else {
      const urlResult = validateAssetUrl(fileUrl, allowHttp);
      if (!urlResult.ok) {
        pushError(errors, "is_published", "发布状态下文件 URL 不合法");
      }
    }
  }

  // ----- sort_order -----
  const sortOrder = payload.sort_order;
  if (typeof sortOrder !== "number" || !Number.isFinite(sortOrder)) {
    pushError(errors, "sort_order", "排序值必须是数字");
  }

  // ----- content_hash -----
  const contentHash = (payload.content_hash || "").trim() || null;
  if (contentHash) {
    if (contentHash.length > 128 || !/^[\w.-]+$/i.test(contentHash)) {
      pushError(errors, "content_hash", "内容哈希格式不合法");
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Format field errors for display. Joins all messages per field into one
 * string suitable for toast or inline message.
 */
export function formatFieldErrors(errors: FieldErrors): string {
  return Object.entries(errors)
    .map(([field, messages]) => `${field}: ${(messages || []).join("; ")}`)
    .join(" | ");
}

/**
 * Build a payload from an existing asset row for the admin form (used on edit).
 */
export function payloadFromAsset(asset: ProductAsset): ProductAssetPayload {
  return {
    product_id: asset.product_id,
    asset_type: asset.asset_type,
    catalog_topic_id: asset.catalog_topic_id || null,
    title_cn: asset.title_cn,
    title_en: asset.title_en,
    description_cn: asset.description_cn,
    description_en: asset.description_en,
    file_url: asset.file_url,
    cover_image_url: asset.cover_image_url || null,
    file_size: asset.file_size,
    mime_type: asset.mime_type,
    published_at: asset.published_at || null,
    content_hash: asset.content_hash || null,
    is_published: asset.is_published,
    sort_order: asset.sort_order,
  };
}
