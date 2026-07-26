-- Phase 3: Admin RBAC role constraint, audit log table, and optimistic
-- locking for transactional write RPCs.
--
-- This migration is ADDITIVE only:
--   * Adds updated_at + trigger + CHECK constraint to admin_profiles
--   * Creates admin_audit_log table (RLS enabled, service_role only)
--   * Replaces save_product_with_images / save_project_with_relations with
--     versions that accept p_expected_updated_at for optimistic locking
--
-- Safety contract:
--   * No existing table is dropped.
--   * The function replacements are backward compatible (new param has
--     default null → no optimistic lock check when caller omits it).
--   * RLS on admin_audit_log denies all access to anon/authenticated; only
--     service_role can insert/query.
--
-- This migration is NOT executed in this commit.

-- ============================================================
-- Part 1: admin_profiles — add updated_at, role CHECK constraint
-- ============================================================

-- Add updated_at column (nullable initially for backfill, then NOT NULL).
alter table public.admin_profiles
  add column if not exists updated_at timestamptz default now();

-- Backfill any NULL updated_at with created_at (or now() as fallback).
update public.admin_profiles
   set updated_at = coalesce(created_at, now())
 where updated_at is null;

-- Enforce NOT NULL after backfill.
alter table public.admin_profiles
  alter column updated_at set not null,
  alter column updated_at set default now();

-- Add the updated_at trigger (same pattern as other tables).
drop trigger if exists trg_admin_profiles_updated_at on public.admin_profiles;
create trigger trg_admin_profiles_updated_at
  before update on public.admin_profiles
  for each row execute function public.handle_updated_at();

-- Backfill NULL roles to 'admin' before adding the CHECK constraint.
update public.admin_profiles
   set role = 'admin'
 where role is null or btrim(role) = '';

alter table public.admin_profiles
  alter column role set default 'admin';

-- CHECK constraint: only known roles are permitted.
--   super_admin : full access (role management, destructive ops)
--   admin       : standard CMS write access (products, projects, inquiries)
--   editor      : limited write access (content only, no deletes)
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'admin_profiles_role_check'
       and conrelid = 'public.admin_profiles'::regclass
  ) then
    alter table public.admin_profiles
      add constraint admin_profiles_role_check
      check (role in ('super_admin', 'admin', 'editor'));
  end if;
end $$;

-- ============================================================
-- Part 2: admin_audit_log table
-- ============================================================

create table if not exists public.admin_audit_log (
  id bigserial primary key,
  actor_id uuid,                       -- references auth.users(id), nullable for system actions
  actor_email text,
  actor_role text,
  action text not null,                -- e.g. 'product.create', 'product.update', 'product.delete', 'inquiry.update'
  target_type text not null,           -- e.g. 'product', 'inquiry', 'project'
  target_id text,                      -- UUID or slug of the affected record
  summary text,                        -- short human-readable description (no sensitive data)
  created_at timestamptz not null default now()
);

-- Indexes for common query patterns.
create index if not exists idx_admin_audit_log_created_at
  on public.admin_audit_log (created_at desc);
create index if not exists idx_admin_audit_log_actor_id
  on public.admin_audit_log (actor_id);
create index if not exists idx_admin_audit_log_target
  on public.admin_audit_log (target_type, target_id);

-- RLS: enable but create NO policies. Only service_role can read/write.
alter table public.admin_audit_log enable row level security;

-- ============================================================
-- Part 3: Optimistic locking for save_product_with_images
-- ============================================================
--
-- The function is replaced with a version that accepts an optional
-- p_expected_updated_at parameter. When non-null, the UPDATE clause
-- includes `AND updated_at = p_expected_updated_at`. If zero rows are
-- updated:
--   - If the row exists but updated_at mismatch → raise 40P01 (conflict)
--   - If the row does not exist → raise P0002 (not found)
--
-- The new parameter defaults to null, so existing callers that omit it
-- behave exactly as before (no optimistic lock check).

drop function if exists public.save_product_with_images(uuid, jsonb, jsonb);

create function public.save_product_with_images(
  p_id uuid,
  p_product jsonb,
  p_images jsonb default '[]'::jsonb,
  p_expected_updated_at timestamptz default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_img jsonb;
  v_url text;
  v_row_exists boolean;
begin
  if p_product is null
     or btrim(p_product->>'name_cn') is null
     or btrim(p_product->>'slug') is null then
    raise exception 'product name_cn and slug are required'
      using errcode = '23502';
  end if;

  if p_id is null then
    insert into public.products (
      category_id, subcategory_id, name_cn, name_en, slug,
      summary_cn, summary_en, description_cn, description_en,
      material_cn, material_en, size, fire_rating, eco_grade,
      price_display_cn, price_display_en, moq,
      packaging_cn, packaging_en, logistics_cn, logistics_en,
      application_cn, application_en, video_url, cover_image_url,
      is_featured, is_published, sort_order,
      seo_title_cn, seo_title_en, seo_description_cn, seo_description_en,
      geo_summary_cn, geo_summary_en,
      keywords_cn, keywords_en, search_aliases,
      schema_extra, faq_cn, faq_en
    ) values (
      nullif(p_product->>'category_id', '')::uuid,
      nullif(p_product->>'subcategory_id', '')::uuid,
      p_product->>'name_cn',
      nullif(p_product->>'name_en', ''),
      p_product->>'slug',
      nullif(p_product->>'summary_cn', ''),
      nullif(p_product->>'summary_en', ''),
      nullif(p_product->>'description_cn', ''),
      nullif(p_product->>'description_en', ''),
      nullif(p_product->>'material_cn', ''),
      nullif(p_product->>'material_en', ''),
      nullif(p_product->>'size', ''),
      coalesce(nullif(p_product->>'fire_rating', ''), 'B级'),
      coalesce(nullif(p_product->>'eco_grade', ''), 'E0级'),
      nullif(p_product->>'price_display_cn', ''),
      nullif(p_product->>'price_display_en', ''),
      nullif(p_product->>'moq', ''),
      nullif(p_product->>'packaging_cn', ''),
      nullif(p_product->>'packaging_en', ''),
      nullif(p_product->>'logistics_cn', ''),
      nullif(p_product->>'logistics_en', ''),
      nullif(p_product->>'application_cn', ''),
      nullif(p_product->>'application_en', ''),
      nullif(p_product->>'video_url', ''),
      nullif(p_product->>'cover_image_url', ''),
      coalesce((p_product->>'is_featured')::boolean, false),
      coalesce((p_product->>'is_published')::boolean, false),
      coalesce((p_product->>'sort_order')::int, 0),
      nullif(p_product->>'seo_title_cn', ''),
      nullif(p_product->>'seo_title_en', ''),
      nullif(p_product->>'seo_description_cn', ''),
      nullif(p_product->>'seo_description_en', ''),
      nullif(p_product->>'geo_summary_cn', ''),
      nullif(p_product->>'geo_summary_en', ''),
      (p_product->'keywords_cn'),
      (p_product->'keywords_en'),
      (p_product->'search_aliases'),
      nullif(p_product->'schema_extra', 'null'::jsonb),
      nullif(p_product->'faq_cn', 'null'::jsonb),
      nullif(p_product->'faq_en', 'null'::jsonb)
    )
    returning id into v_id;
  else
    v_id := p_id;
    -- Phase 3: optimistic locking. When p_expected_updated_at is provided,
    -- the UPDATE only succeeds if the row's updated_at matches. This
    -- prevents a stale client from silently overwriting a newer edit.
    update public.products set
      category_id = nullif(p_product->>'category_id', '')::uuid,
      subcategory_id = nullif(p_product->>'subcategory_id', '')::uuid,
      name_cn = p_product->>'name_cn',
      name_en = nullif(p_product->>'name_en', ''),
      slug = p_product->>'slug',
      summary_cn = nullif(p_product->>'summary_cn', ''),
      summary_en = nullif(p_product->>'summary_en', ''),
      description_cn = nullif(p_product->>'description_cn', ''),
      description_en = nullif(p_product->>'description_en', ''),
      material_cn = nullif(p_product->>'material_cn', ''),
      material_en = nullif(p_product->>'material_en', ''),
      size = nullif(p_product->>'size', ''),
      fire_rating = coalesce(nullif(p_product->>'fire_rating', ''), 'B级'),
      eco_grade = coalesce(nullif(p_product->>'eco_grade', ''), 'E0级'),
      price_display_cn = nullif(p_product->>'price_display_cn', ''),
      price_display_en = nullif(p_product->>'price_display_en', ''),
      moq = nullif(p_product->>'moq', ''),
      packaging_cn = nullif(p_product->>'packaging_cn', ''),
      packaging_en = nullif(p_product->>'packaging_en', ''),
      logistics_cn = nullif(p_product->>'logistics_cn', ''),
      logistics_en = nullif(p_product->>'logistics_en', ''),
      application_cn = nullif(p_product->>'application_cn', ''),
      application_en = nullif(p_product->>'application_en', ''),
      video_url = nullif(p_product->>'video_url', ''),
      cover_image_url = nullif(p_product->>'cover_image_url', ''),
      is_featured = coalesce((p_product->>'is_featured')::boolean, false),
      is_published = coalesce((p_product->>'is_published')::boolean, false),
      sort_order = coalesce((p_product->>'sort_order')::int, 0),
      seo_title_cn = nullif(p_product->>'seo_title_cn', ''),
      seo_title_en = nullif(p_product->>'seo_title_en', ''),
      seo_description_cn = nullif(p_product->>'seo_description_cn', ''),
      seo_description_en = nullif(p_product->>'seo_description_en', ''),
      geo_summary_cn = nullif(p_product->>'geo_summary_cn', ''),
      geo_summary_en = nullif(p_product->>'geo_summary_en', ''),
      keywords_cn = (p_product->'keywords_cn'),
      keywords_en = (p_product->'keywords_en'),
      search_aliases = (p_product->'search_aliases'),
      schema_extra = nullif(p_product->'schema_extra', 'null'::jsonb),
      faq_cn = nullif(p_product->'faq_cn', 'null'::jsonb),
      faq_en = nullif(p_product->'faq_en', 'null'::jsonb),
      updated_at = now()
    where id = v_id
      and (p_expected_updated_at is null or updated_at = p_expected_updated_at);

    if not found then
      -- Distinguish "row doesn't exist" from "stale updated_at".
      select exists(select 1 from public.products where id = v_id)
        into v_row_exists;
      if v_row_exists and p_expected_updated_at is not null then
        raise exception 'product updated by another transaction'
          using errcode = '40P01';
      end if;
      raise exception 'product not found' using errcode = 'P0002';
    end if;
  end if;

  -- Replace images atomically within the same transaction.
  delete from public.product_images where product_id = v_id;
  if p_images is not null and jsonb_typeof(p_images) = 'array' then
    for v_img in select * from jsonb_array_elements(p_images) loop
      v_url := v_img->>'image_url';
      if v_url is null or btrim(v_url) = '' then
        raise exception 'product image_url is required' using errcode = '23502';
      end if;
      insert into public.product_images (product_id, image_url, alt_cn, alt_en, sort_order)
      values (
        v_id,
        v_url,
        nullif(v_img->>'alt_cn', ''),
        nullif(v_img->>'alt_en', ''),
        coalesce((v_img->>'sort_order')::int, 0)
      );
    end loop;
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_product_with_images(uuid, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_product_with_images(uuid, jsonb, jsonb, timestamptz)
  to service_role;

-- ============================================================
-- Part 4: Optimistic locking for save_project_with_relations
-- ============================================================

drop function if exists public.save_project_with_relations(uuid, jsonb, jsonb, jsonb);

create function public.save_project_with_relations(
  p_id uuid,
  p_project jsonb,
  p_images jsonb default '[]'::jsonb,
  p_products jsonb default '[]'::jsonb,
  p_expected_updated_at timestamptz default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_img jsonb;
  v_url text;
  v_link jsonb;
  v_row_exists boolean;
begin
  if p_project is null
     or btrim(p_project->>'title_cn') is null
     or btrim(p_project->>'slug') is null then
    raise exception 'project title_cn and slug are required'
      using errcode = '23502';
  end if;

  if p_id is null then
    insert into public.projects (
      slug, title_cn, title_en, summary_cn, summary_en,
      description_cn, description_en, country_cn, country_en,
      project_type_cn, project_type_en, cover_image_url,
      is_published, is_featured, sort_order,
      seo_title_cn, seo_title_en, seo_description_cn, seo_description_en
    ) values (
      p_project->>'slug',
      p_project->>'title_cn',
      nullif(p_project->>'title_en', ''),
      nullif(p_project->>'summary_cn', ''),
      nullif(p_project->>'summary_en', ''),
      nullif(p_project->>'description_cn', ''),
      nullif(p_project->>'description_en', ''),
      nullif(p_project->>'country_cn', ''),
      nullif(p_project->>'country_en', ''),
      nullif(p_project->>'project_type_cn', ''),
      nullif(p_project->>'project_type_en', ''),
      nullif(p_project->>'cover_image_url', ''),
      coalesce((p_project->>'is_published')::boolean, false),
      coalesce((p_project->>'is_featured')::boolean, false),
      coalesce((p_project->>'sort_order')::int, 0),
      nullif(p_project->>'seo_title_cn', ''),
      nullif(p_project->>'seo_title_en', ''),
      nullif(p_project->>'seo_description_cn', ''),
      nullif(p_project->>'seo_description_en', '')
    )
    returning id into v_id;
  else
    v_id := p_id;
    update public.projects set
      slug = p_project->>'slug',
      title_cn = p_project->>'title_cn',
      title_en = nullif(p_project->>'title_en', ''),
      summary_cn = nullif(p_project->>'summary_cn', ''),
      summary_en = nullif(p_project->>'summary_en', ''),
      description_cn = nullif(p_project->>'description_cn', ''),
      description_en = nullif(p_project->>'description_en', ''),
      country_cn = nullif(p_project->>'country_cn', ''),
      country_en = nullif(p_project->>'country_en', ''),
      project_type_cn = nullif(p_project->>'project_type_cn', ''),
      project_type_en = nullif(p_project->>'project_type_en', ''),
      cover_image_url = nullif(p_project->>'cover_image_url', ''),
      is_published = coalesce((p_project->>'is_published')::boolean, false),
      is_featured = coalesce((p_project->>'is_featured')::boolean, false),
      sort_order = coalesce((p_project->>'sort_order')::int, 0),
      seo_title_cn = nullif(p_project->>'seo_title_cn', ''),
      seo_title_en = nullif(p_project->>'seo_title_en', ''),
      seo_description_cn = nullif(p_project->>'seo_description_cn', ''),
      seo_description_en = nullif(p_project->>'seo_description_en', ''),
      updated_at = now()
    where id = v_id
      and (p_expected_updated_at is null or updated_at = p_expected_updated_at);

    if not found then
      select exists(select 1 from public.projects where id = v_id)
        into v_row_exists;
      if v_row_exists and p_expected_updated_at is not null then
        raise exception 'project updated by another transaction'
          using errcode = '40P01';
      end if;
      raise exception 'project not found' using errcode = 'P0002';
    end if;
  end if;

  -- Replace images atomically.
  delete from public.project_images where project_id = v_id;
  if p_images is not null and jsonb_typeof(p_images) = 'array' then
    for v_img in select * from jsonb_array_elements(p_images) loop
      v_url := v_img->>'image_url';
      if v_url is null or btrim(v_url) = '' then
        raise exception 'project image_url is required' using errcode = '23502';
      end if;
      insert into public.project_images (project_id, image_url, alt_cn, alt_en, sort_order)
      values (
        v_id,
        v_url,
        nullif(v_img->>'alt_cn', ''),
        nullif(v_img->>'alt_en', ''),
        coalesce((v_img->>'sort_order')::int, 0)
      );
    end loop;
  end if;

  -- Replace product associations atomically.
  delete from public.project_products where project_id = v_id;
  if p_products is not null and jsonb_typeof(p_products) = 'array' then
    for v_link in select * from jsonb_array_elements(p_products) loop
      if v_link->>'product_id' is null then
        raise exception 'project_products.product_id is required' using errcode = '23502';
      end if;
      insert into public.project_products (project_id, product_id, sort_order)
      values (
        v_id,
        (v_link->>'product_id')::uuid,
        coalesce((v_link->>'sort_order')::int, 0)
      );
    end loop;
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)
  to service_role;
