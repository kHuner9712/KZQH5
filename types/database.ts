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

export interface Inquiry {
  id: string;
  name: string;
  company: string | null;
  country: string | null;
  email: string | null;
  whatsapp: string | null;
  interested_product: string | null;
  quantity: string | null;
  message: string | null;
  status: InquiryStatus;
  source: string | null;
  created_at: string;
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
  name: string;
  company?: string;
  country?: string;
  email?: string;
  whatsapp?: string;
  interested_product?: string;
  quantity?: string;
  message?: string;
}

// ============================================================
// Supabase Database 类型（供 @supabase/ssr / @supabase/supabase-js 泛型使用）
// ============================================================
export type Database = {
  public: {
    Tables: {
      admin_profiles: {
        Row: AdminProfile;
        Insert: Partial<AdminProfile>;
        Update: Partial<AdminProfile>;
      };
      categories: {
        Row: Category;
        Insert: Partial<Category>;
        Update: Partial<Category>;
      };
      subcategories: {
        Row: Subcategory;
        Insert: Partial<Subcategory>;
        Update: Partial<Subcategory>;
      };
      products: {
        Row: Product;
        Insert: Partial<Product>;
        Update: Partial<Product>;
      };
      product_images: {
        Row: ProductImage;
        Insert: Partial<ProductImage>;
        Update: Partial<ProductImage>;
      };
      certificates: {
        Row: Certificate;
        Insert: Partial<Certificate>;
        Update: Partial<Certificate>;
      };
      inquiries: {
        Row: Inquiry;
        Insert: Partial<Inquiry>;
        Update: Partial<Inquiry>;
      };
      company_profile: {
        Row: CompanyProfile;
        Insert: Partial<CompanyProfile>;
        Update: Partial<CompanyProfile>;
      };
      site_settings: {
        Row: SiteSettings;
        Insert: Partial<SiteSettings>;
        Update: Partial<SiteSettings>;
      };
      homepage_content: {
        Row: HomepageContent;
        Insert: Partial<HomepageContent>;
        Update: Partial<HomepageContent>;
      };
      page_content: {
        Row: PageContent;
        Insert: Partial<PageContent>;
        Update: Partial<PageContent>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
