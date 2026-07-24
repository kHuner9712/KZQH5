-- Phase 12: Catalog authorization metadata + resource source constraints.
--
-- This migration adds provenance and access-level metadata to product_assets
-- so the admin can track WHERE each catalog/datasheet/certificate asset came
-- from and WHO is allowed to view/download it.
--
-- Business constraint (from AGENTS.md):
--   "不得下载、复制或导入第三方网站、Scribd、镜像站或其他未确认授权的
--    Catalog/PDF/图片"
--   The system must not import catalog assets from unauthorized third-party
--   sources. The source_type + authorization_status columns make this
--   auditable at the database level.
--
-- This migration is ADDITIVE only:
--   * New columns have safe defaults (access_level='public',
--     authorization_status='pending') so existing rows remain accessible.
--   * The RLS policy is replaced with a version that also checks access_level.
--   * No existing data is lost or restricted.
--
-- This migration is NOT executed in this commit.

-- ============================================================
-- Part 1: Add authorization metadata columns to product_assets
-- ============================================================

alter table public.product_assets
  add column if not exists access_level text not null default 'public',
  add column if not exists source_type text,
  add column if not exists authorization_status text not null default 'pending';

-- Backfill source_type for existing rows: NULL means "unknown provenance".
-- Admin should review and update these to the correct source_type.

-- CHECK constraint: access_level must be one of the known values.
--   public     : visible to all visitors (anon)
--   registered : visible to authenticated users only
--   partner    : visible to admin/partner roles only
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_assets_access_level_check'
       and conrelid = 'public.product_assets'::regclass
  ) then
    alter table public.product_assets
      add constraint product_assets_access_level_check
      check (access_level in ('public', 'registered', 'partner'));
  end if;
end $$;

-- CHECK constraint: source_type (when present) must be one of the known values.
--   official       : obtained from the manufacturer's official channel
--   self-produced  : produced by KZQ internally
--   licensed       : obtained under a licensing agreement
--   public-domain  : public domain material
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_assets_source_type_check'
       and conrelid = 'public.product_assets'::regclass
  ) then
    alter table public.product_assets
      add constraint product_assets_source_type_check
      check (source_type is null or source_type in ('official', 'self-produced', 'licensed', 'public-domain'));
  end if;
end $$;

-- CHECK constraint: authorization_status must be one of the known values.
--   confirmed : the right to use this asset has been verified
--   pending   : authorization has not yet been confirmed (default)
--   restricted: asset is restricted and should not be publicly displayed
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_assets_authorization_status_check'
       and conrelid = 'public.product_assets'::regclass
  ) then
    alter table public.product_assets
      add constraint product_assets_authorization_status_check
      check (authorization_status in ('confirmed', 'pending', 'restricted'));
  end if;
end $$;

-- Index for filtering by access_level (public catalog queries).
create index if not exists idx_product_assets_access_level
  on public.product_assets (access_level)
  where is_published = true;

-- ============================================================
-- Part 2: Update RLS policy to enforce access_level
-- ============================================================
--
-- The original policy allowed anon/authenticated to read any is_published
-- asset. The new policy adds:
--   - access_level = 'public' for anon users
--   - access_level IN ('public', 'registered') for authenticated users
--   - admin (is_admin()) bypasses access_level (admin_all policy unchanged)
--
-- 'partner' assets are only visible to admin (via the admin_all policy).
-- 'restricted' authorization_status assets are excluded from public reads
-- regardless of access_level.

drop policy if exists "product_assets_public_read" on public.product_assets;

create policy "product_assets_public_read"
  on public.product_assets for select
  to anon, authenticated
  using (
    is_published = true
    and authorization_status != 'restricted'
    and (
      -- anon can only see public assets
      (auth.role() = 'anon' and access_level = 'public')
      or
      -- authenticated can see public + registered assets
      (auth.role() = 'authenticated' and access_level in ('public', 'registered'))
    )
    and (
      product_id is null
      or exists (
        select 1 from public.products product
        where product.id = product_assets.product_id
          and product.is_published = true
      )
    )
  );

-- The admin_all policy remains unchanged — admins can see all assets
-- regardless of access_level or authorization_status.
