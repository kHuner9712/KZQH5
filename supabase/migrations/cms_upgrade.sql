-- ============================================================
-- KZQ CMS 升级迁移 - 一次性在已有库上执行
-- 内容：site_settings 扩展 + homepage_content 表 + page_content 表 + products GEO 字段 + 索引 + RLS
-- 幂等设计：全部使用 create table if not exists / add column if not exists / create index if not exists
-- 执行顺序：schema.sql（含本迁移内容）→ policies.sql → seed.sql（或本文件可直接执行）
-- ============================================================

create extension if not exists "pgcrypto";

-- handle_updated_at 触发器函数（若 schema.sql 未执行则补齐）
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 1. site_settings 扩展字段
-- ------------------------------------------------------------
alter table public.site_settings
  add column if not exists site_name_cn text;
alter table public.site_settings
  add column if not exists site_name_en text;
alter table public.site_settings
  add column if not exists brand_name text;
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
-- 2. homepage_content 表（单例）
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
-- 3. page_content 表（about / certificates / contact / products）
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
-- 5. 索引
-- ------------------------------------------------------------
create index if not exists idx_products_is_featured on public.products(is_featured);
create index if not exists idx_products_updated_at on public.products(updated_at desc);
create index if not exists idx_products_name_cn on public.products(name_cn);
create index if not exists idx_products_name_en on public.products(name_en);
create index if not exists idx_products_keywords_cn_gin on public.products using gin (keywords_cn);
create index if not exists idx_products_keywords_en_gin on public.products using gin (keywords_en);
create index if not exists idx_products_search_aliases_gin on public.products using gin (search_aliases);
create index if not exists idx_homepage_content_active on public.homepage_content(is_active);
create index if not exists idx_page_content_key on public.page_content(page_key);

-- ------------------------------------------------------------
-- 6. RLS 策略
-- ------------------------------------------------------------
-- is_admin() 辅助函数（若 policies.sql 未执行则补齐）
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
as $$
  select exists (
    select 1 from public.admin_profiles
    where id = auth.uid()
  );
$$;

-- homepage_content：anon 读 is_active=true；admin 全部
alter table public.homepage_content enable row level security;

drop policy if exists "homepage_content_public_read" on public.homepage_content;
create policy "homepage_content_public_read"
  on public.homepage_content for select
  to anon, authenticated
  using (is_active = true);

drop policy if exists "homepage_content_admin_all" on public.homepage_content;
create policy "homepage_content_admin_all"
  on public.homepage_content for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- page_content：anon 全部可读（页面内容均为公开）；admin 全部
alter table public.page_content enable row level security;

drop policy if exists "page_content_public_read" on public.page_content;
create policy "page_content_public_read"
  on public.page_content for select
  to anon, authenticated
  using (true);

drop policy if exists "page_content_admin_all" on public.page_content;
create policy "page_content_admin_all"
  on public.page_content for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
