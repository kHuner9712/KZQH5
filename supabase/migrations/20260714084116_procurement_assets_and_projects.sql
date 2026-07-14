-- ============================================================
-- KZQ 采购资料与应用案例
-- 新增公开展示资料、案例、多图和产品关联；不写入任何虚构内容。
-- ============================================================

create table public.product_assets (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete cascade,
  asset_type text not null,
  title_cn text not null,
  title_en text,
  description_cn text,
  description_en text,
  file_url text not null,
  file_size bigint,
  mime_type text,
  is_published boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_assets_asset_type_check check (
    asset_type in ('catalog', 'datasheet', 'installation', 'certificate', 'packaging', 'other')
  ),
  constraint product_assets_file_size_check check (file_size is null or file_size >= 0),
  constraint product_assets_file_url_check check (length(btrim(file_url)) > 0)
);

create index product_assets_product_id_idx on public.product_assets(product_id, sort_order);
create index product_assets_public_site_idx on public.product_assets(sort_order, created_at)
  where product_id is null and is_published = true;
create index product_assets_public_product_idx on public.product_assets(product_id, sort_order)
  where product_id is not null and is_published = true;

create trigger trg_product_assets_updated_at
  before update on public.product_assets
  for each row execute function public.handle_updated_at();

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title_cn text not null,
  title_en text,
  summary_cn text,
  summary_en text,
  description_cn text,
  description_en text,
  country_cn text,
  country_en text,
  project_type_cn text,
  project_type_en text,
  cover_image_url text,
  is_published boolean not null default false,
  is_featured boolean not null default false,
  sort_order integer not null default 0,
  seo_title_cn text,
  seo_title_en text,
  seo_description_cn text,
  seo_description_en text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_slug_check check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create index projects_public_list_idx on public.projects(is_featured desc, sort_order, created_at desc)
  where is_published = true;
create index projects_updated_at_idx on public.projects(updated_at desc);

create trigger trg_projects_updated_at
  before update on public.projects
  for each row execute function public.handle_updated_at();

create table public.project_images (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  image_url text not null,
  alt_cn text,
  alt_en text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint project_images_image_url_check check (length(btrim(image_url)) > 0)
);

create index project_images_project_id_idx on public.project_images(project_id, sort_order);

create table public.project_products (
  project_id uuid not null references public.projects(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (project_id, product_id)
);

create index project_products_product_id_idx on public.project_products(product_id);
create index project_products_project_id_idx on public.project_products(project_id, sort_order);

alter table public.product_assets enable row level security;
alter table public.projects enable row level security;
alter table public.project_images enable row level security;
alter table public.project_products enable row level security;

create policy "product_assets_public_read"
  on public.product_assets for select
  to anon, authenticated
  using (
    is_published = true
    and (
      product_id is null
      or exists (
        select 1 from public.products product
        where product.id = product_assets.product_id
          and product.is_published = true
      )
    )
  );

create policy "product_assets_admin_all"
  on public.product_assets for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "projects_public_read"
  on public.projects for select
  to anon, authenticated
  using (is_published = true);

create policy "projects_admin_all"
  on public.projects for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "project_images_public_read"
  on public.project_images for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.projects project
      where project.id = project_images.project_id
        and project.is_published = true
    )
  );

create policy "project_images_admin_all"
  on public.project_images for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "project_products_public_read"
  on public.project_products for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.projects project
      where project.id = project_products.project_id
        and project.is_published = true
    )
    and exists (
      select 1 from public.products product
      where product.id = project_products.product_id
        and product.is_published = true
    )
  );

create policy "project_products_admin_all"
  on public.project_products for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

grant select on table public.product_assets, public.projects, public.project_images, public.project_products
  to anon, authenticated;
grant insert, update, delete on table public.product_assets, public.projects, public.project_images, public.project_products
  to authenticated;
grant all on table public.product_assets, public.projects, public.project_images, public.project_products
  to service_role;
