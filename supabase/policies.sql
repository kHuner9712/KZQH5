-- ============================================================
-- KZQ 品牌 H5 - Row Level Security 策略
-- 在执行完 schema.sql 后执行本文件
-- ============================================================

-- ============================================================
-- 辅助函数：判断当前用户是否为管理员（存在于 admin_profiles）
-- ============================================================
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

-- ============================================================
-- 1. admin_profiles - 完全不开放给前端，仅服务端 service_role 可访问
-- ============================================================
alter table public.admin_profiles enable row level security;

-- 不创建任何 policy，前台 / 客户端完全无法读写
-- 服务端使用 service_role key 绕过 RLS

-- ============================================================
-- 2. categories
-- ============================================================
alter table public.categories enable row level security;

-- 匿名读取启用类目
drop policy if exists "categories_public_read" on public.categories;
create policy "categories_public_read"
  on public.categories for select
  to anon, authenticated
  using (is_active = true);

-- 管理员全部读写
drop policy if exists "categories_admin_all" on public.categories;
create policy "categories_admin_all"
  on public.categories for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- 3. subcategories
-- ============================================================
alter table public.subcategories enable row level security;

drop policy if exists "subcategories_public_read" on public.subcategories;
create policy "subcategories_public_read"
  on public.subcategories for select
  to anon, authenticated
  using (is_active = true);

drop policy if exists "subcategories_admin_all" on public.subcategories;
create policy "subcategories_admin_all"
  on public.subcategories for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- 4. products
-- ============================================================
alter table public.products enable row level security;

-- 匿名读取已发布产品
drop policy if exists "products_public_read" on public.products;
create policy "products_public_read"
  on public.products for select
  to anon, authenticated
  using (is_published = true);

-- 管理员全部读写
drop policy if exists "products_admin_all" on public.products;
create policy "products_admin_all"
  on public.products for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- 5. product_images
-- ============================================================
alter table public.product_images enable row level security;

-- 匿名读取所属产品已发布的图片
drop policy if exists "product_images_public_read" on public.product_images;
create policy "product_images_public_read"
  on public.product_images for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.products p
      where p.id = product_images.product_id
      and p.is_published = true
    )
  );

drop policy if exists "product_images_admin_all" on public.product_images;
create policy "product_images_admin_all"
  on public.product_images for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- 6. certificates
-- ============================================================
alter table public.certificates enable row level security;

drop policy if exists "certificates_public_read" on public.certificates;
create policy "certificates_public_read"
  on public.certificates for select
  to anon, authenticated
  using (is_published = true);

drop policy if exists "certificates_admin_all" on public.certificates;
create policy "certificates_admin_all"
  on public.certificates for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- 7. company_profile
-- ============================================================
alter table public.company_profile enable row level security;

-- 匿名可读
drop policy if exists "company_profile_public_read" on public.company_profile;
create policy "company_profile_public_read"
  on public.company_profile for select
  to anon, authenticated
  using (true);

-- 管理员全部读写
drop policy if exists "company_profile_admin_all" on public.company_profile;
create policy "company_profile_admin_all"
  on public.company_profile for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- 8. site_settings
-- ============================================================
alter table public.site_settings enable row level security;

drop policy if exists "site_settings_public_read" on public.site_settings;
create policy "site_settings_public_read"
  on public.site_settings for select
  to anon, authenticated
  using (true);

drop policy if exists "site_settings_admin_all" on public.site_settings;
create policy "site_settings_admin_all"
  on public.site_settings for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- 9. inquiries - 不开放 anon 直接写入
-- 询盘提交必须通过 /api/inquiries 路由（服务端 service_role 写入）
-- 服务端做 honeypot、限流、字段校验、垃圾内容判断
-- 不再开放 Supabase anon 直接 insert inquiries，避免绕过 API 防滥用
-- ============================================================
alter table public.inquiries enable row level security;

-- 删除旧的匿名 insert policy（如存在），不再重新创建
drop policy if exists "inquiries_public_insert" on public.inquiries;

-- 管理员全部读写（前台用户无法读取他人询盘）
drop policy if exists "inquiries_admin_all" on public.inquiries;
create policy "inquiries_admin_all"
  on public.inquiries for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- Storage Buckets 权限
-- ============================================================

-- public-assets bucket（公开读，管理员写）
insert into storage.buckets (id, name, public)
values ('public-assets', 'public-assets', true)
on conflict (id) do nothing;

-- private-assets bucket（预留，前台不可访问）
insert into storage.buckets (id, name, public)
values ('private-assets', 'private-assets', false)
on conflict (id) do nothing;

-- public-assets: 任何人可读
drop policy if exists "public_assets_read" on storage.objects;
create policy "public_assets_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'public-assets');

-- public-assets: 管理员可上传/更新/删除
drop policy if exists "public_assets_admin_write" on storage.objects;
create policy "public_assets_admin_write"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'public-assets' and public.is_admin()
  );

drop policy if exists "public_assets_admin_update" on storage.objects;
create policy "public_assets_admin_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'public-assets' and public.is_admin()
  );

drop policy if exists "public_assets_admin_delete" on storage.objects;
create policy "public_assets_admin_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'public-assets' and public.is_admin()
  );

-- private-assets: 仅管理员可读写
drop policy if exists "private_assets_admin_all" on storage.objects;
create policy "private_assets_admin_all"
  on storage.objects for all
  to authenticated
  using (
    bucket_id = 'private-assets' and public.is_admin()
  )
  with check (
    bucket_id = 'private-assets' and public.is_admin()
  );

-- ============================================================
-- 10. homepage_content - 首页内容（单例）
-- anon 可读 is_active=true；admin 全部读写
-- ============================================================
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

-- ============================================================
-- 11. page_content - 页面内容（about / certificates / contact / products）
-- 页面标题/描述/SEO/sections 均为公开内容，anon 全部可读；admin 全部读写
-- ============================================================
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
