-- ============================================================
-- KZQ 品牌 H5 产品展示站 - 数据库 Schema
-- 在 Supabase SQL Editor 中执行
-- ============================================================

-- 启用 pgcrypto 用于 gen_random_uuid()
create extension if not exists "pgcrypto";

-- ============================================================
-- 1. admin_profiles - 管理员档案（关联 auth.users）
-- ============================================================
create table if not exists public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text default 'admin',
  created_at timestamptz default now()
);

-- ============================================================
-- 2. categories - 一级类目
-- ============================================================
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name_cn text not null,
  name_en text,
  slug text unique not null,
  description_cn text,
  description_en text,
  sort_order int default 0,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- 3. subcategories - 二级类目
-- ============================================================
create table if not exists public.subcategories (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id) on delete cascade,
  name_cn text not null,
  name_en text,
  slug text unique not null,
  description_cn text,
  description_en text,
  sort_order int default 0,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- 4. products - 产品
-- ============================================================
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id) on delete set null,
  subcategory_id uuid references public.subcategories(id) on delete set null,
  name_cn text not null,
  name_en text,
  slug text unique not null,
  summary_cn text,
  summary_en text,
  description_cn text,
  description_en text,
  material_cn text,
  material_en text,
  size text,
  fire_rating text default 'B级',
  eco_grade text default 'E0级',
  price_display_cn text,
  price_display_en text,
  moq text,
  packaging_cn text,
  packaging_en text,
  logistics_cn text,
  logistics_en text,
  application_cn text,
  application_en text,
  video_url text,
  cover_image_url text,
  is_featured boolean default false,
  is_published boolean default false,
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- 5. product_images - 产品多图
-- ============================================================
create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete cascade,
  image_url text not null,
  alt_cn text,
  alt_en text,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- ============================================================
-- 6. certificates - 资质证书（仅展示版/水印版图片）
-- ============================================================
create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  name_cn text not null,
  name_en text,
  description_cn text,
  description_en text,
  image_url text,
  applicable_scope_cn text,
  applicable_scope_en text,
  is_published boolean default false,
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- 7. inquiries - 询盘（前台匿名可写不可读）
-- ============================================================
create table if not exists public.inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  country text,
  phone text,
  wechat text,
  email text,
  whatsapp text,
  interested_product text,
  quantity text,
  message text,
  status text default 'new',
  language text not null default 'zh',
  source text,
  channel text,
  page_url text,
  referrer text,
  product_id uuid,
  product_slug text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  is_read boolean not null default false,
  read_at timestamptz,
  notes text,
  assignee text,
  created_at timestamptz default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 8. company_profile - 公司信息（单例）
-- ============================================================
create table if not exists public.company_profile (
  id uuid primary key default gen_random_uuid(),
  title_cn text,
  title_en text,
  description_cn text,
  description_en text,
  advantages_cn jsonb default '[]'::jsonb,
  advantages_en jsonb default '[]'::jsonb,
  phone text,
  wechat text,
  email text,
  whatsapp text,
  address_cn text,
  address_en text,
  wechat_qr_url text,
  logo_url text,
  updated_at timestamptz default now()
);

-- ============================================================
-- 9. site_settings - 站点设置（单例）
-- ============================================================
create table if not exists public.site_settings (
  id uuid primary key default gen_random_uuid(),
  site_name text default 'KZQ Product Catalog',
  default_language text default 'zh',
  meta_title_cn text,
  meta_title_en text,
  meta_description_cn text,
  meta_description_en text,
  updated_at timestamptz default now()
);

-- ============================================================
-- 索引
-- ============================================================
create index if not exists idx_subcategories_category_id on public.subcategories(category_id);
create index if not exists idx_products_category_id on public.products(category_id);
create index if not exists idx_products_subcategory_id on public.products(subcategory_id);
create index if not exists idx_products_slug on public.products(slug);
create index if not exists idx_products_is_published on public.products(is_published);
create index if not exists idx_product_images_product_id on public.product_images(product_id);
create index if not exists idx_inquiries_status on public.inquiries(status);
create index if not exists idx_inquiries_created_at on public.inquiries(created_at desc);

-- ============================================================
-- updated_at 自动更新触发器
-- ============================================================
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_categories_updated_at on public.categories;
create trigger trg_categories_updated_at before update on public.categories
  for each row execute function public.handle_updated_at();

drop trigger if exists trg_subcategories_updated_at on public.subcategories;
create trigger trg_subcategories_updated_at before update on public.subcategories
  for each row execute function public.handle_updated_at();

drop trigger if exists trg_products_updated_at on public.products;
create trigger trg_products_updated_at before update on public.products
  for each row execute function public.handle_updated_at();

drop trigger if exists trg_certificates_updated_at on public.certificates;
create trigger trg_certificates_updated_at before update on public.certificates
  for each row execute function public.handle_updated_at();

drop trigger if exists trg_company_profile_updated_at on public.company_profile;
create trigger trg_company_profile_updated_at before update on public.company_profile
  for each row execute function public.handle_updated_at();

drop trigger if exists trg_site_settings_updated_at on public.site_settings;
create trigger trg_site_settings_updated_at before update on public.site_settings
  for each row execute function public.handle_updated_at();

-- ============================================================
-- 新用户注册时自动写入 admin_profiles（仅当手动创建账号时使用）
-- 实际管理员可通过 SQL 手动插入：insert into admin_profiles(id,email) values ('<auth.users.id>','email')
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- 不自动赋予 admin 角色，需管理员手动在 admin_profiles 中登记
  -- 此处仅留 hook，默认不插入任何数据，避免任何人注册即成管理员
  return null;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- ============================================================
-- ====== CMS 升级：site_settings 扩展 + homepage_content + page_content + products GEO 字段 + 索引 ======
-- 使用 alter table ... add column if not exists 兼容已有库的平滑升级，不破坏现有数据。
-- ============================================================
-- ============================================================

-- ------------------------------------------------------------
-- 1. site_settings 扩展字段
-- ------------------------------------------------------------
alter table public.site_settings
  add column if not exists site_name_cn text;
alter table public.site_settings
  add column if not exists site_name_en text;
alter table public.site_settings
  add column if not exists brand_name text;
-- default_language 已存在，仅在缺失时补齐
alter table public.site_settings
  add column if not exists default_language text default 'zh';
alter table public.site_settings
  add column if not exists global_meta_title_cn text;
alter table public.site_settings
  add column if not exists global_meta_title_en text;
alter table public.site_settings
  add column if not exists global_meta_description_cn text;
alter table public.site_settings
  add column if not exists global_meta_description_en text;
alter table public.site_settings
  add column if not exists default_og_image_url text;
alter table public.site_settings
  add column if not exists footer_text_cn text;
alter table public.site_settings
  add column if not exists footer_text_en text;
alter table public.site_settings
  add column if not exists navigation_json jsonb default '[]'::jsonb;

-- ------------------------------------------------------------
-- 2. homepage_content - 首页内容（单例）
-- ------------------------------------------------------------
create table if not exists public.homepage_content (
  id uuid primary key default gen_random_uuid(),
  hero_eyebrow_cn text,
  hero_eyebrow_en text,
  hero_title_cn text,
  hero_title_en text,
  hero_highlight_cn text,
  hero_highlight_en text,
  hero_description_cn text,
  hero_description_en text,
  primary_cta_text_cn text,
  primary_cta_text_en text,
  secondary_cta_text_cn text,
  secondary_cta_text_en text,
  feature_section_title_cn text,
  feature_section_title_en text,
  feature_section_subtitle_cn text,
  feature_section_subtitle_en text,
  features_cn jsonb default '[]'::jsonb,
  features_en jsonb default '[]'::jsonb,
  category_section_title_cn text,
  category_section_subtitle_cn text,
  featured_products_title_cn text,
  featured_products_subtitle_cn text,
  bottom_cta_title_cn text,
  bottom_cta_title_en text,
  bottom_cta_description_cn text,
  bottom_cta_description_en text,
  is_active boolean default true,
  updated_at timestamptz default now()
);

drop trigger if exists trg_homepage_content_updated_at on public.homepage_content;
create trigger trg_homepage_content_updated_at before update on public.homepage_content
  for each row execute function public.handle_updated_at();

-- ------------------------------------------------------------
-- 3. page_content - 页面内容（about / certificates / contact / products）
-- ------------------------------------------------------------
create table if not exists public.page_content (
  id uuid primary key default gen_random_uuid(),
  page_key text unique not null,
  title_cn text,
  title_en text,
  subtitle_cn text,
  subtitle_en text,
  description_cn text,
  description_en text,
  sections_cn jsonb default '[]'::jsonb,
  sections_en jsonb default '[]'::jsonb,
  seo_title_cn text,
  seo_title_en text,
  seo_description_cn text,
  seo_description_en text,
  updated_at timestamptz default now()
);

drop trigger if exists trg_page_content_updated_at on public.page_content;
create trigger trg_page_content_updated_at before update on public.page_content
  for each row execute function public.handle_updated_at();

-- ------------------------------------------------------------
-- 4. products GEO / SEO 扩展字段
-- ------------------------------------------------------------
alter table public.products
  add column if not exists seo_title_cn text;
alter table public.products
  add column if not exists seo_title_en text;
alter table public.products
  add column if not exists seo_description_cn text;
alter table public.products
  add column if not exists seo_description_en text;
alter table public.products
  add column if not exists geo_summary_cn text;
alter table public.products
  add column if not exists geo_summary_en text;
alter table public.products
  add column if not exists keywords_cn text[];
alter table public.products
  add column if not exists keywords_en text[];
alter table public.products
  add column if not exists faq_cn jsonb default '[]'::jsonb;
alter table public.products
  add column if not exists faq_en jsonb default '[]'::jsonb;
alter table public.products
  add column if not exists search_aliases text[];
alter table public.products
  add column if not exists schema_extra jsonb default '{}'::jsonb;

-- ------------------------------------------------------------
-- 5. 索引（大量产品管理与搜索优化）
-- ------------------------------------------------------------
create index if not exists idx_products_is_featured on public.products(is_featured);
create index if not exists idx_products_updated_at on public.products(updated_at desc);
-- 名称搜索（前缀 / 包含）：ilike 查询常用，btree 仍可用于前缀；这里补 gin trgm 需扩展，先用 btree name_cn
create index if not exists idx_products_name_cn on public.products(name_cn);
create index if not exists idx_products_name_en on public.products(name_en);
-- keywords / search_aliases GIN 索引（数组包含查询）
create index if not exists idx_products_keywords_cn_gin on public.products using gin (keywords_cn);
create index if not exists idx_products_keywords_en_gin on public.products using gin (keywords_en);
create index if not exists idx_products_search_aliases_gin on public.products using gin (search_aliases);
-- homepage_content / page_content 索引
create index if not exists idx_homepage_content_active on public.homepage_content(is_active);
create index if not exists idx_page_content_key on public.page_content(page_key);
