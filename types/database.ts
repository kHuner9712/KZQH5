// ============================================================
// KZQ 数据库类型定义
// ============================================================

export interface AdminProfile {
  id: string;
  email: string | null;
  role: string | null;
  created_at: string;
}

export interface Category {
  id: string;
  name_cn: string;
  name_en: string | null;
  slug: string;
  description_cn: string | null;
  description_en: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Subcategory {
  id: string;
  category_id: string;
  name_cn: string;
  name_en: string | null;
  slug: string;
  description_cn: string | null;
  description_en: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// 产品 FAQ 项结构（faq_cn / faq_en jsonb 数组元素）
export interface ProductFaqItem {
  question: string;
  answer: string;
}

export interface Product {
  id: string;
  category_id: string | null;
  subcategory_id: string | null;
  name_cn: string;
  name_en: string | null;
  slug: string;
  summary_cn: string | null;
  summary_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  material_cn: string | null;
  material_en: string | null;
  size: string | null;
  fire_rating: string | null;
  eco_grade: string | null;
  price_display_cn: string | null;
  price_display_en: string | null;
  moq: string | null;
  packaging_cn: string | null;
  packaging_en: string | null;
  logistics_cn: string | null;
  logistics_en: string | null;
  application_cn: string | null;
  application_en: string | null;
  video_url: string | null;
  cover_image_url: string | null;
  is_featured: boolean;
  is_published: boolean;
  sort_order: number;
  // ----- GEO / SEO 扩展字段 -----
  seo_title_cn: string | null;
  seo_title_en: string | null;
  seo_description_cn: string | null;
  seo_description_en: string | null;
  geo_summary_cn: string | null;
  geo_summary_en: string | null;
  keywords_cn: string[] | null;
  keywords_en: string[] | null;
  faq_cn: ProductFaqItem[] | null;
  faq_en: ProductFaqItem[] | null;
  search_aliases: string[] | null;
  schema_extra: Record<string, unknown> | null;
  search_document: string;
  // ------------------------------
  created_at: string;
  updated_at: string;
  // 关联查询字段（非数据库列）
  category?: Category | null;
  subcategory?: Subcategory | null;
  product_images?: ProductImage[];
}

export interface ProductImage {
  id: string;
  product_id: string;
  image_url: string | null;
  alt_cn: string | null;
  alt_en: string | null;
  sort_order: number;
  created_at: string;
}

export interface Certificate {
  id: string;
  name_cn: string;
  name_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  image_url: string | null;
  applicable_scope_cn: string | null;
  applicable_scope_en: string | null;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type InquiryStatus = "new" | "contacted" | "closed";

export interface InquiryItem {
  id: string;
  inquiry_id: string;
  product_id: string | null;
  product_slug: string | null;
  product_name_cn: string | null;
  product_name_en: string | null;
  quantity: string | null;
  sort_order: number;
  created_at: string;
}

export type ProductAssetType =
  | "catalog"
  | "datasheet"
  | "installation"
  | "certificate"
  | "packaging"
  | "other";

export interface ProductAsset {
  id: string;
  product_id: string | null;
  asset_type: ProductAssetType;
  title_cn: string;
  title_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  product?: Pick<Product, "id" | "slug" | "name_cn" | "name_en"> | null;
}

export interface Project {
  id: string;
  slug: string;
  title_cn: string;
  title_en: string | null;
  summary_cn: string | null;
  summary_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  country_cn: string | null;
  country_en: string | null;
  project_type_cn: string | null;
  project_type_en: string | null;
  cover_image_url: string | null;
  is_published: boolean;
  is_featured: boolean;
  sort_order: number;
  seo_title_cn: string | null;
  seo_title_en: string | null;
  seo_description_cn: string | null;
  seo_description_en: string | null;
  created_at: string;
  updated_at: string;
  project_images?: ProjectImage[];
  products?: Product[];
}

export interface ProjectImage {
  id: string;
  project_id: string;
  image_url: string;
  alt_cn: string | null;
  alt_en: string | null;
  sort_order: number;
  created_at: string;
}

export interface ProjectProduct {
  project_id: string;
  product_id: string;
  sort_order: number;
  created_at: string;
}

export interface InquiryListItemInput {
  product_id: string;
  slug: string;
  name_cn: string;
  name_en: string | null;
  cover_image_url: string | null;
  quantity: string;
}

export interface Inquiry {
  id: string;
  name: string;
  company: string | null;
  country: string | null;
  phone: string | null;
  wechat: string | null;
  email: string | null;
  whatsapp: string | null;
  interested_product: string | null;
  quantity: string | null;
  message: string | null;
  status: InquiryStatus;
  language: "zh" | "en";
  source: string | null;
  channel: string | null;
  page_url: string | null;
  referrer: string | null;
  product_id: string | null;
  product_slug: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  is_read: boolean;
  read_at: string | null;
  notes: string | null;
  assignee: string | null;
  created_at: string;
  updated_at: string;
  inquiry_items?: InquiryItem[];
}

export interface Advantage {
  icon: string;
  title_cn: string;
  title_en: string;
  desc_cn: string;
  desc_en: string;
}

export interface CompanyProfile {
  id: string;
  title_cn: string | null;
  title_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  advantages_cn: Advantage[] | null;
  advantages_en: Advantage[] | null;
  phone: string | null;
  wechat: string | null;
  email: string | null;
  whatsapp: string | null;
  address_cn: string | null;
  address_en: string | null;
  wechat_qr_url: string | null;
  logo_url: string | null;
  updated_at: string;
}

export interface SiteSettings {
  id: string;
  site_name: string;
  // ----- 扩展字段 -----
  site_name_cn: string | null;
  site_name_en: string | null;
  brand_name: string | null;
  default_language: string;
  global_meta_title_cn: string | null;
  global_meta_title_en: string | null;
  global_meta_description_cn: string | null;
  global_meta_description_en: string | null;
  default_og_image_url: string | null;
  footer_text_cn: string | null;
  footer_text_en: string | null;
  navigation_json: NavItem[] | null;
  // --------------------
  // 保留旧字段（向后兼容）
  meta_title_cn: string | null;
  meta_title_en: string | null;
  meta_description_cn: string | null;
  meta_description_en: string | null;
  updated_at: string;
}

// 导航菜单项结构（site_settings.navigation_json 数组元素）
export interface NavItem {
  label_cn: string;
  label_en: string;
  href: string;
  sort_order?: number;
}

// 首页核心优势项（homepage_content.features_cn / features_en jsonb 数组元素）
export interface HomeFeatureItem {
  icon: string;
  title: string;
  description: string;
}

export interface HomepageContent {
  id: string;
  hero_eyebrow_cn: string | null;
  hero_eyebrow_en: string | null;
  hero_title_cn: string | null;
  hero_title_en: string | null;
  hero_highlight_cn: string | null;
  hero_highlight_en: string | null;
  hero_description_cn: string | null;
  hero_description_en: string | null;
  primary_cta_text_cn: string | null;
  primary_cta_text_en: string | null;
  secondary_cta_text_cn: string | null;
  secondary_cta_text_en: string | null;
  feature_section_title_cn: string | null;
  feature_section_title_en: string | null;
  feature_section_subtitle_cn: string | null;
  feature_section_subtitle_en: string | null;
  features_cn: HomeFeatureItem[] | null;
  features_en: HomeFeatureItem[] | null;
  category_section_title_cn: string | null;
  category_section_subtitle_cn: string | null;
  featured_products_title_cn: string | null;
  featured_products_subtitle_cn: string | null;
  bottom_cta_title_cn: string | null;
  bottom_cta_title_en: string | null;
  bottom_cta_description_cn: string | null;
  bottom_cta_description_en: string | null;
  is_active: boolean;
  updated_at: string;
}

// 页面内容区块结构（page_content.sections_cn / sections_en jsonb 数组元素）
export interface PageSection {
  title?: string;
  subtitle?: string;
  body?: string;
  icon?: string;
  items?: string[];
}

export interface PageContent {
  id: string;
  page_key: string;
  title_cn: string | null;
  title_en: string | null;
  subtitle_cn: string | null;
  subtitle_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  sections_cn: PageSection[] | null;
  sections_en: PageSection[] | null;
  seo_title_cn: string | null;
  seo_title_en: string | null;
  seo_description_cn: string | null;
  seo_description_en: string | null;
  updated_at: string;
}

// 询盘表单输入
export interface InquiryInput {
  locale?: "zh" | "en";
  name: string;
  company?: string;
  country?: string;
  phone?: string;
  wechat?: string;
  email?: string;
  whatsapp?: string;
  interested_product?: string;
  quantity?: string;
  message?: string;
  destination_port?: string;
  trade_term?: string;
  product_id?: string;
  product_slug?: string;
  source?: string;
  channel?: string;
  page_url?: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  privacy_accepted?: boolean;
  items?: InquiryListItemInput[];
}

export const analyticsEventNames = [
  "page_view",
  "product_view",
  "product_search",
  "category_click",
  "phone_click",
  "wechat_copy",
  "whatsapp_click",
  "email_click",
  "add_to_inquiry",
  "inquiry_start",
  "inquiry_success",
  // Catalog viewer taxonomy — distinguish open / load / copy / external / download.
  // `catalog_download` is the actual file download click; the others describe
  // different user actions so analytics can distinguish them.
  "catalog_open",
  "catalog_load_success",
  "catalog_load_failure",
  "catalog_copy_link",
  "catalog_open_external",
  "catalog_download",
  "certificate_view",
  "project_view",
] as const;

export type AnalyticsEventName = (typeof analyticsEventNames)[number];

export interface AnalyticsEvent {
  id: string;
  event_name: AnalyticsEventName;
  locale: "zh" | "en";
  page_path: string;
  product_id: string | null;
  project_id: string | null;
  source: string | null;
  channel: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  referrer: string | null;
  created_at: string;
}

export type AnalyticsEventInput = Omit<AnalyticsEvent, "id" | "created_at">;

export interface AnalyticsSummary {
  page_views: number;
  product_views: number;
  contact_clicks: number;
  inquiry_successes: number;
  popular_products: Array<{ product_id: string; name: string; count: number }>;
  popular_searches: Array<{ term: string; count: number }>;
  sources: Array<{ source: string; count: number }>;
  utm: Array<{ source: string; medium: string; campaign: string; count: number }>;
}

// ============================================================
// Supabase Database 类型（供 @supabase/ssr / @supabase/supabase-js 泛型使用）
// ============================================================
type SupabaseRow<T> = T & Record<string, unknown>;
type SupabaseInsert<T> = Partial<T> & Record<string, unknown>;
type SupabaseUpdate<T> = Partial<T> & Record<string, unknown>;

export type Database = {
  public: {
    Tables: {
      admin_profiles: {
        Row: SupabaseRow<AdminProfile>;
        Insert: SupabaseInsert<AdminProfile>;
        Update: SupabaseUpdate<AdminProfile>;
        Relationships: [];
      };
      categories: {
        Row: SupabaseRow<Category>;
        Insert: SupabaseInsert<Category>;
        Update: SupabaseUpdate<Category>;
        Relationships: [];
      };
      subcategories: {
        Row: SupabaseRow<Subcategory>;
        Insert: SupabaseInsert<Subcategory>;
        Update: SupabaseUpdate<Subcategory>;
        Relationships: [];
      };
      products: {
        Row: SupabaseRow<Product>;
        Insert: SupabaseInsert<Product>;
        Update: SupabaseUpdate<Product>;
        Relationships: [];
      };
      product_images: {
        Row: SupabaseRow<ProductImage>;
        Insert: SupabaseInsert<ProductImage>;
        Update: SupabaseUpdate<ProductImage>;
        Relationships: [];
      };
      certificates: {
        Row: SupabaseRow<Certificate>;
        Insert: SupabaseInsert<Certificate>;
        Update: SupabaseUpdate<Certificate>;
        Relationships: [];
      };
      inquiries: {
        Row: SupabaseRow<Inquiry>;
        Insert: SupabaseInsert<Inquiry>;
        Update: SupabaseUpdate<Inquiry>;
        Relationships: [];
      };
      analytics_events: {
        Row: SupabaseRow<AnalyticsEvent>;
        Insert: SupabaseInsert<AnalyticsEvent>;
        Update: SupabaseUpdate<AnalyticsEvent>;
        Relationships: [];
      };
      product_assets: {
        Row: SupabaseRow<ProductAsset>;
        Insert: SupabaseInsert<ProductAsset>;
        Update: SupabaseUpdate<ProductAsset>;
        Relationships: [];
      };
      projects: {
        Row: SupabaseRow<Project>;
        Insert: SupabaseInsert<Project>;
        Update: SupabaseUpdate<Project>;
        Relationships: [];
      };
      project_images: {
        Row: SupabaseRow<ProjectImage>;
        Insert: SupabaseInsert<ProjectImage>;
        Update: SupabaseUpdate<ProjectImage>;
        Relationships: [];
      };
      project_products: {
        Row: SupabaseRow<ProjectProduct>;
        Insert: SupabaseInsert<ProjectProduct>;
        Update: SupabaseUpdate<ProjectProduct>;
        Relationships: [];
      };
      inquiry_items: {
        Row: SupabaseRow<InquiryItem>;
        Insert: SupabaseInsert<InquiryItem>;
        Update: SupabaseUpdate<InquiryItem>;
        Relationships: [];
      };
      company_profile: {
        Row: SupabaseRow<CompanyProfile>;
        Insert: SupabaseInsert<CompanyProfile>;
        Update: SupabaseUpdate<CompanyProfile>;
        Relationships: [];
      };
      site_settings: {
        Row: SupabaseRow<SiteSettings>;
        Insert: SupabaseInsert<SiteSettings>;
        Update: SupabaseUpdate<SiteSettings>;
        Relationships: [];
      };
      homepage_content: {
        Row: SupabaseRow<HomepageContent>;
        Insert: SupabaseInsert<HomepageContent>;
        Update: SupabaseUpdate<HomepageContent>;
        Relationships: [];
      };
      page_content: {
        Row: SupabaseRow<PageContent>;
        Insert: SupabaseInsert<PageContent>;
        Update: SupabaseUpdate<PageContent>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      count_unread_inquiries: {
        Args: Record<string, never>;
        Returns: number;
      };
      search_published_products: {
        Args: {
          p_query?: string | null;
          p_category_id?: string | null;
          p_subcategory_id?: string | null;
          p_offset?: number;
          p_limit?: number;
        };
        Returns: unknown;
      };
      create_inquiry_with_items: {
        Args: { p_inquiry: Record<string, unknown>; p_items?: Record<string, unknown>[] };
        Returns: unknown;
      };
      get_analytics_summary: {
        Args: { p_start: string; p_end: string };
        Returns: unknown;
      };
      get_admin_dashboard_snapshot: {
        Args: Record<string, never>;
        Returns: {
          total_products: number;
          published_products: number;
          total_certificates: number;
          total_inquiries: number;
          unread_inquiries: number;
        };
      };
      save_product_with_images: {
        Args: {
          p_id: string | null;
          p_product: Record<string, unknown>;
          p_images?: Record<string, unknown>[];
        };
        Returns: string;
      };
      save_project_with_relations: {
        Args: {
          p_id: string | null;
          p_project: Record<string, unknown>;
          p_images?: Record<string, unknown>[];
          p_products?: Record<string, unknown>[];
        };
        Returns: string;
      };
    };
    Enums: Record<string, never>;
  };
};
