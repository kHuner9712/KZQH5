// ============================================================
// Work Package F: Shared explicit field lists for public reads.
//
// Replaces select("*") across lib/repositories/* and the inline
// component-level Supabase calls in components/public/pages/*.
//
// Why: select("*") automatically exposes every new DB column to
// the RSC payload, including internal Phase 15+ storage ref /
// publish state machine fields (source_bucket, publish_token,
// candidate_public_path, etc.) that should never leave the
// server boundary. Explicit field lists:
//   - prevent accidental over-exposure when new DB fields are added
//   - reduce RSC payload size
//   - keep TypeScript types in sync with the actual query shape
//
// These constants list the PUBLIC-facing fields only. Internal
// state-machine columns are intentionally omitted — admin pages
// and service-role code can select additional fields explicitly.
//
// Type safety: each `<TABLE>_FIELDS_LIST` is typed as `(keyof T)[]`
// so TypeScript rejects typos and unknown field names at compile
// time. The exported `<TABLE>_FIELDS` is the joined string passed
// to Supabase `.select()`.
// ============================================================

import type {
  Category,
  Certificate,
  CompanyProfile,
  HomepageContent,
  PageContent,
  Product,
  ProductAsset,
  ProductImage,
  Project,
  ProjectImage,
  ProjectProduct,
  SiteSettings,
  Subcategory,
} from "@/types/database";

const CATEGORY_FIELDS_LIST: (keyof Category)[] = [
  "id",
  "name_cn",
  "name_en",
  "slug",
  "description_cn",
  "description_en",
  "sort_order",
  "is_active",
  "created_at",
  "updated_at",
];
const CATEGORY_FIELDS = CATEGORY_FIELDS_LIST.join(", ");

const SUBCATEGORY_FIELDS_LIST: (keyof Subcategory)[] = [
  "id",
  "category_id",
  "name_cn",
  "name_en",
  "slug",
  "description_cn",
  "description_en",
  "sort_order",
  "is_active",
  "created_at",
  "updated_at",
];
const SUBCATEGORY_FIELDS = SUBCATEGORY_FIELDS_LIST.join(", ");

// Certificate has many internal Phase 15 storage / publish fields
// (source_bucket, publish_token, candidate_public_path, etc.).
// Public reads must NOT select those — only display fields.
const CERTIFICATE_FIELDS_LIST: (keyof Certificate)[] = [
  "id",
  "name_cn",
  "name_en",
  "description_cn",
  "description_en",
  "image_url",
  "applicable_scope_cn",
  "applicable_scope_en",
  "is_published",
  "sort_order",
  "created_at",
  "updated_at",
];
const CERTIFICATE_FIELDS = CERTIFICATE_FIELDS_LIST.join(", ");

const COMPANY_PROFILE_FIELDS_LIST: (keyof CompanyProfile)[] = [
  "id",
  "title_cn",
  "title_en",
  "description_cn",
  "description_en",
  "advantages_cn",
  "advantages_en",
  "phone",
  "wechat",
  "email",
  "whatsapp",
  "address_cn",
  "address_en",
  "wechat_qr_url",
  "logo_url",
  "updated_at",
];
const COMPANY_PROFILE_FIELDS = COMPANY_PROFILE_FIELDS_LIST.join(", ");

const SITE_SETTINGS_FIELDS_LIST: (keyof SiteSettings)[] = [
  "id",
  "site_name",
  "site_name_cn",
  "site_name_en",
  "brand_name",
  "default_language",
  "global_meta_title_cn",
  "global_meta_title_en",
  "global_meta_description_cn",
  "global_meta_description_en",
  "default_og_image_url",
  "footer_text_cn",
  "footer_text_en",
  "navigation_json",
  "meta_title_cn",
  "meta_title_en",
  "meta_description_cn",
  "meta_description_en",
  "updated_at",
];
const SITE_SETTINGS_FIELDS = SITE_SETTINGS_FIELDS_LIST.join(", ");

const HOMEPAGE_CONTENT_FIELDS_LIST: (keyof HomepageContent)[] = [
  "id",
  "hero_eyebrow_cn",
  "hero_eyebrow_en",
  "hero_title_cn",
  "hero_title_en",
  "hero_highlight_cn",
  "hero_highlight_en",
  "hero_description_cn",
  "hero_description_en",
  "primary_cta_text_cn",
  "primary_cta_text_en",
  "secondary_cta_text_cn",
  "secondary_cta_text_en",
  "feature_section_title_cn",
  "feature_section_title_en",
  "feature_section_subtitle_cn",
  "feature_section_subtitle_en",
  "features_cn",
  "features_en",
  "category_section_title_cn",
  "category_section_subtitle_cn",
  "featured_products_title_cn",
  "featured_products_subtitle_cn",
  "bottom_cta_title_cn",
  "bottom_cta_title_en",
  "is_active",
  "updated_at",
];
const HOMEPAGE_CONTENT_FIELDS = HOMEPAGE_CONTENT_FIELDS_LIST.join(", ");

const PAGE_CONTENT_FIELDS_LIST: (keyof PageContent)[] = [
  "id",
  "page_key",
  "title_cn",
  "title_en",
  "subtitle_cn",
  "subtitle_en",
  "description_cn",
  "description_en",
  "sections_cn",
  "sections_en",
  "seo_title_cn",
  "seo_title_en",
  "seo_description_cn",
  "seo_description_en",
  "updated_at",
];
const PAGE_CONTENT_FIELDS = PAGE_CONTENT_FIELDS_LIST.join(", ");

const PRODUCT_FIELDS_LIST: (keyof Product)[] = [
  "id",
  "category_id",
  "subcategory_id",
  "name_cn",
  "name_en",
  "slug",
  "summary_cn",
  "summary_en",
  "description_cn",
  "description_en",
  "material_cn",
  "material_en",
  "size",
  "fire_rating",
  "eco_grade",
  "price_display_cn",
  "price_display_en",
  "moq",
  "packaging_cn",
  "packaging_en",
  "logistics_cn",
  "logistics_en",
  "application_cn",
  "application_en",
  "video_url",
  "cover_image_url",
  "is_published",
  "is_featured",
  "sort_order",
  "created_at",
  "updated_at",
];
const PRODUCT_FIELDS = PRODUCT_FIELDS_LIST.join(", ");

const PRODUCT_IMAGE_FIELDS_LIST: (keyof ProductImage)[] = [
  "id",
  "product_id",
  "image_url",
  "alt_cn",
  "alt_en",
  "sort_order",
  "created_at",
];
const PRODUCT_IMAGE_FIELDS = PRODUCT_IMAGE_FIELDS_LIST.join(", ");

// ProductAsset has many internal Phase 15 storage ref / publish fields.
// Public reads select only display fields.
const PRODUCT_ASSET_FIELDS_LIST: (keyof ProductAsset)[] = [
  "id",
  "product_id",
  "asset_type",
  "title_cn",
  "title_en",
  "description_cn",
  "description_en",
  "file_url",
  "file_size",
  "mime_type",
  "is_published",
  "sort_order",
  "created_at",
  "updated_at",
  "catalog_topic_id",
  "cover_image_url",
  "published_at",
];
const PRODUCT_ASSET_FIELDS = PRODUCT_ASSET_FIELDS_LIST.join(", ");

const PROJECT_FIELDS_LIST: (keyof Project)[] = [
  "id",
  "slug",
  "title_cn",
  "title_en",
  "summary_cn",
  "summary_en",
  "description_cn",
  "description_en",
  "country_cn",
  "country_en",
  "project_type_cn",
  "project_type_en",
  "cover_image_url",
  "is_published",
  "is_featured",
  "sort_order",
  "seo_title_cn",
  "seo_title_en",
  "seo_description_cn",
  "seo_description_en",
  "created_at",
  "updated_at",
];
const PROJECT_FIELDS = PROJECT_FIELDS_LIST.join(", ");

const PROJECT_IMAGE_FIELDS_LIST: (keyof ProjectImage)[] = [
  "id",
  "project_id",
  "image_url",
  "alt_cn",
  "alt_en",
  "sort_order",
  "created_at",
];
const PROJECT_IMAGE_FIELDS = PROJECT_IMAGE_FIELDS_LIST.join(", ");

const PROJECT_PRODUCT_FIELDS_LIST: (keyof ProjectProduct)[] = [
  "project_id",
  "product_id",
  "sort_order",
  "created_at",
];
const PROJECT_PRODUCT_FIELDS = PROJECT_PRODUCT_FIELDS_LIST.join(", ");

// Lightweight product selection used by inquiry widgets and home featured.
// Intentionally narrower than PRODUCT_FIELDS — only the fields shown in
// cards/summaries.
const PRODUCT_SELECTION_FIELDS = "id, slug, name_cn, name_en, cover_image_url";

export {
  CATEGORY_FIELDS,
  SUBCATEGORY_FIELDS,
  CERTIFICATE_FIELDS,
  COMPANY_PROFILE_FIELDS,
  SITE_SETTINGS_FIELDS,
  HOMEPAGE_CONTENT_FIELDS,
  PAGE_CONTENT_FIELDS,
  PRODUCT_FIELDS,
  PRODUCT_IMAGE_FIELDS,
  PRODUCT_ASSET_FIELDS,
  PROJECT_FIELDS,
  PROJECT_IMAGE_FIELDS,
  PROJECT_PRODUCT_FIELDS,
  PRODUCT_SELECTION_FIELDS,
};
