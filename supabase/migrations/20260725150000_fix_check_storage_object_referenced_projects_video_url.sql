-- ============================================================
-- Migration 20260725150000
-- Fix check_storage_object_referenced: drop projects.video_url reference
-- ============================================================
-- The projects table (created in 20260714084116_procurement_assets_and_projects.sql)
-- does NOT have a video_url column. Only products has video_url.
--
-- The original check_storage_object_referenced function (added in
-- 20260725110000) incorrectly referenced projects.video_url, which
-- causes "column does not exist" errors at runtime when the function
-- is invoked against a projects path.
--
-- This migration replaces the function body to only check
-- projects.cover_image_url (the only URL column on projects that
-- holds a storage path).
--
-- All other reference checks are preserved:
--   - products.cover_image_url, products.video_url
--   - product_images.image_url
--   - product_assets.file_url, product_assets.cover_image_url
--   - certificates.image_url
--   - projects.cover_image_url
-- ============================================================

create or replace function public.check_storage_object_referenced(
  p_bucket text,
  p_object_path text
) returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_pattern text;
  v_count integer;
begin
  if p_object_path is null or length(p_object_path) = 0 then
    return true; -- refuse delete if path is invalid
  end if;

  -- Build a LIKE pattern matching any URL ending with this path.
  v_pattern := '%' || p_object_path;

  -- Check products.cover_image_url / video_url
  select count(*) into v_count from public.products
    where cover_image_url like v_pattern
       or video_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check product_images.image_url
  select count(*) into v_count from public.product_images
    where image_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check product_assets.file_url / cover_image_url
  select count(*) into v_count from public.product_assets
    where file_url like v_pattern
       or cover_image_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check certificates.image_url
  select count(*) into v_count from public.certificates
    where image_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check projects.cover_image_url
  -- (projects has NO video_url column — do not reference it.)
  select count(*) into v_count from public.projects
    where cover_image_url like v_pattern;
  if v_count > 0 then return true; end if;

  return false;
end;
$$;

revoke all on function public.check_storage_object_referenced(text, text)
  from public, anon, authenticated;
grant execute on function public.check_storage_object_referenced(text, text)
  to service_role;
