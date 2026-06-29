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
  image_url: string;
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
  default_language: string;
  meta_title_cn: string | null;
  meta_title_en: string | null;
  meta_description_cn: string | null;
  meta_description_en: string | null;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
