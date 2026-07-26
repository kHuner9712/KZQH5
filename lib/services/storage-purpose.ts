// ============================================================
// Storage Purpose → Bucket 服务端映射
// ------------------------------------------------------------
// 客户端只能提交 `purpose`，不能提交 bucket / public / 完整 path。
// 服务端根据 purpose 决定：
//   1. 目标 bucket（public-assets | private-assets）
//   2. 资源分类（用于路径生成 {category}/{uuid}.{ext}）
//   3. 是否允许构造公开 URL（private-assets 不返回 publicUrl）
//   4. 是否允许的 MIME 类型（catalog-draft 允许 PDF；其余仅图片）
//
// 重要不变式：
//   - Catalog、证书、授权文件默认必须 private-assets
//   - 只有满足 is_published=true + access_level=public +
//     authorization_status=confirmed 后才能进入公开发布流程
//     （通过 publish_catalog_asset RPC 完成 URL 转换）
//   - 通用 ImageUpload/FileUpload 组件不得自动决定公开性
// ============================================================

/**
 * 服务端识别的 Storage 用途枚举。
 *
 * 客户端只能提交此枚举中的值，不能提交 bucket / public / 完整 path。
 */
export type StoragePurpose =
  | "product-image"
  | "project-image"
  | "company-logo"
  | "homepage-image"
  | "catalog-draft"
  | "catalog-cover"
  | "certificate-draft";

/** 客户端可提交的所有合法 purpose 值（用于白名单校验）。 */
export const STORAGE_PURPOSES: readonly StoragePurpose[] = [
  "product-image",
  "project-image",
  "company-logo",
  "homepage-image",
  "catalog-draft",
  "catalog-cover",
  "certificate-draft",
] as const;

/** Purpose 解析结果。 */
export interface PurposeConfig {
  /** 最终目标 bucket（public-assets | private-assets）。 */
  bucket: "public-assets" | "private-assets";
  /**
   * 服务端使用的资源分类（路径前缀）。
   * 对于 public-assets，允许子目录（如 "products/covers"）。
   * 对于 private-assets，仅允许顶层分类白名单。
   */
  category: string;
  /**
   * 是否允许构造公开 URL。
   * - public-assets：true（直接返回 publicUrl）
   * - private-assets：false（仅返回 path，需后续 publish 流程才能公开）
   */
  isPublicUrlAllowed: boolean;
  /**
   * 允许的 MIME 类型白名单（覆盖默认白名单）。
   * - 图片类 purpose：仅图片 MIME
   * - catalog-draft：图片 + PDF
   * - certificate-draft：仅图片（证书以图片展示，PDF 走 catalog-draft）
   */
  allowedMimeTypes: readonly string[];
}

/**
 * Purpose → 配置的不可变映射。
 *
 * 添加新 purpose 必须在此处注册，且必须经过安全审查（bucket、category、
 * MIME 白名单、是否允许公开 URL）。
 */
const PURPOSE_CONFIGS: Readonly<Record<StoragePurpose, PurposeConfig>> = {
  // 产品展示图（cover / gallery）—— 直接公开
  "product-image": {
    bucket: "public-assets",
    category: "products",
    isPublicUrlAllowed: true,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
    ],
  },
  // 项目案例展示图 —— 直接公开
  "project-image": {
    bucket: "public-assets",
    category: "projects",
    isPublicUrlAllowed: true,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
    ],
  },
  // 公司品牌资源（logo / 微信二维码等）—— 直接公开
  "company-logo": {
    bucket: "public-assets",
    category: "company",
    isPublicUrlAllowed: true,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
    ],
  },
  // 首页 / OG / Banner 等站点图片 —— 直接公开
  "homepage-image": {
    bucket: "public-assets",
    category: "site",
    isPublicUrlAllowed: true,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
    ],
  },
  // Catalog 资产（PDF / 展示图）—— 默认 private-assets
  // 仅当 is_published=true + access_level=public + authorization_status=confirmed
  // 后，通过 publish_catalog_asset RPC 完成 private→public 转换。
  "catalog-draft": {
    bucket: "private-assets",
    category: "catalogs",
    isPublicUrlAllowed: false,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ],
  },
  // Catalog 封面图（catalog 列表/详情卡片封面）—— 直接公开
  // 与 catalog-draft 区分：catalog-draft 是文件本身（需发布流程），
  // catalog-cover 是配套封面图（直接 public-assets）。
  "catalog-cover": {
    bucket: "public-assets",
    category: "catalogs/covers",
    isPublicUrlAllowed: true,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
    ],
  },
  // 证书图片 —— 默认 private-assets
  // 证书图片展示需满足展示版/水印版/已获授权条件后才进入公开发布流程。
  "certificate-draft": {
    bucket: "private-assets",
    category: "certificates",
    isPublicUrlAllowed: false,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
    ],
  },
};

/** 类型守卫：判断字符串是否为合法 StoragePurpose。 */
export function isStoragePurpose(value: unknown): value is StoragePurpose {
  return (
    typeof value === "string" &&
    (STORAGE_PURPOSES as readonly string[]).includes(value)
  );
}

/**
 * 解析 purpose 为服务端配置。
 *
 * 调用方：
 *   - app/api/admin/storage/upload/route.ts —— 接收客户端提交的 purpose，
 *     解析后传入 uploadToPrivateAssets / uploadToPublicAssets
 *   - 服务端校验逻辑 —— 拒绝客户端提交 bucket / public / 完整 path
 *
 * 若 purpose 非法，返回 null（调用方应返回 400 BAD_REQUEST）。
 */
export function resolvePurposeConfig(
  purpose: unknown,
): PurposeConfig | null {
  if (!isStoragePurpose(purpose)) return null;
  return PURPOSE_CONFIGS[purpose];
}
