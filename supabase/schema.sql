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
  email text,
  whatsapp text,
  interested_product text,
  quantity text,
  message text,
  status text default 'new',
  source text default 'h5',
  created_at timestamptz default now()
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
