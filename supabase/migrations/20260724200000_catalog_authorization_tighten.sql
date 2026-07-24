-- ============================================================
-- Phase 12 correction: tighten Catalog authorization model.
--
-- Problem with 20260724190000_catalog_authorization_metadata.sql:
--   * access_level default 'public' + authorization_status default
--     'pending' allowed anon to read public+pending assets.
--   * RLS only excluded 'restricted'. This is wrong: pending assets
--     have NOT been confirmed and must NOT be publicly readable.
--   * 'authenticated' was treated as equivalent to a vetted customer
--     or partner. The project has no complete customer authorization
--     system, so 'authenticated' must not grant private access.
--
-- Corrected model (simplified to match actual capability):
--   access_level:
--     - public   : visible to all visitors (anon) once confirmed
--     - private  : visible only via service_role (admin RBAC)
--   authorization_status:
--     - pending    : NOT publicly readable (awaiting admin review)
--     - confirmed  : publicly readable (if access_level='public')
--     - restricted : never publicly readable
--
-- Public anon read requires ALL of:
--   is_published = true
--   AND access_level = 'public'
--   AND authorization_status = 'confirmed'
--
-- Admin access is via service_role only (bypasses RLS), gated by
-- application-layer RBAC in lib/services/admin-auth.ts.
--
-- This migration is ADDITIVE to 20260724190000 and does not modify
-- that historical migration file. It is NOT executed in this commit.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Backfill: collapse registered/partner -> private
-- ------------------------------------------------------------
-- Existing rows with the old 'registered' or 'partner' values become
-- 'private'. No data is lost; access is tightened, never loosened.
update public.product_assets
  set access_level = 'private'
  where access_level in ('registered', 'partner');

-- ------------------------------------------------------------
-- 2. Replace access_level CHECK constraint
-- ------------------------------------------------------------
alter table public.product_assets
  drop constraint if exists product_assets_access_level_check;

alter table public.product_assets
  add constraint product_assets_access_level_check
  check (access_level in ('public', 'private'));

-- ------------------------------------------------------------
-- 3. authorization_status CHECK constraint stays the same
--    (pending | confirmed | restricted) — no change needed, but
--    ensure it exists for fresh installs that skip 20260724190000.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 4. Replace RLS policy: anon needs public + confirmed + published
-- ------------------------------------------------------------
-- authenticated role is NOT granted private access. The project has
-- no customer authorization system; 'authenticated' only means a
-- Supabase Auth user exists, which does not imply vetted customer or
-- partner status. Private assets are reachable only via service_role
-- (admin RBAC at the application layer).
drop policy if exists "product_assets_public_read" on public.product_assets;

create policy "product_assets_public_read"
  on public.product_assets for select
  to anon, authenticated
  using (
    is_published = true
    and access_level = 'public'
    and authorization_status = 'confirmed'
    and (
      product_id is null
      or exists (
        select 1 from public.products product
        where product.id = product_assets.product_id
          and product.is_published = true
      )
    )
  );

-- ------------------------------------------------------------
-- 5. Update index to match the tightened predicate
-- ------------------------------------------------------------
drop index if exists idx_product_assets_access_level;
create index idx_product_assets_access_level
  on public.product_assets (access_level)
  where is_published = true and authorization_status = 'confirmed';
