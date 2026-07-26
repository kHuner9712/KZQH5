-- ============================================================
-- Migration 20260725160000
-- Transactional Storage cleanup enqueue (Section 9)
-- ============================================================
-- This migration makes business-save RPCs enqueue removed persisted
-- Storage objects into storage_cleanup_queue ATOMICALLY, in the SAME
-- transaction as the business write.
--
-- Why this is needed:
--   Before: image/cover replacement only updated the DB row. The old
--   Storage object remained in the bucket with no reference — a slow
--   leak. The client "best-effort" enqueue API was unreliable because
--   users could close the form before it fired.
--
-- After:
--   - save_product_with_images captures old image URLs (and old
--     cover_image_url / video_url) BEFORE replacement, computes
--     removed = old - new, and enqueues each removed MANAGED URL
--     (those pointing at our public-assets bucket) into
--     storage_cleanup_queue in the SAME transaction.
--   - save_project_with_relations does the same for project images
--     and cover_image_url / video_url.
--
-- Managed URL detection:
--   Only URLs pointing to our /storage/v1/object/public/public-assets/
--   path are enqueued. External URLs (e.g. https://example.com/foo.jpg)
--   and private-assets:// paths are NOT enqueued — we never delete
--   what we do not own.
--
-- Atomicity guarantee:
--   enqueue_storage_cleanup is SECURITY INVOKER + runs in the caller's
--   transaction. If the business UPDATE/INSERT fails, the cleanup
--   enqueue rolls back too. If the enqueue fails, the business save
--   rolls back (caller-visible error).
--
-- Idempotency:
--   enqueue_storage_cleanup is idempotent (unique partial index on
--   (bucket, object_path) WHERE status in pending/claimed/retry).
--   Repeated saves that keep the same image set do NOT create
--   duplicate cleanup rows.
--
-- Forward-only: this migration only ADDS or REPLACES functions; it
-- does not drop or modify existing table data.
-- ============================================================

-- ============================================================
-- A. Helper: extract managed public-assets storage path from URL
-- ============================================================
-- Returns the object path if the URL points to our public-assets
-- bucket, otherwise NULL. Used to decide whether a URL is "managed"
-- (we own it and can safely delete it) vs. external (we must not).
--
-- We cannot use a hard-coded Supabase URL here because the project
-- URL varies per environment. Instead we match the path suffix:
--   /storage/v1/object/public/public-assets/{path}
--
-- URLs that do NOT contain this suffix (external URLs, private-assets
-- signed URLs, relative paths, etc.) return NULL — no enqueue.
create or replace function public.extract_managed_storage_path(
  p_url text
) returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_prefix text := '/storage/v1/object/public/public-assets/';
  v_idx integer;
  v_rest text;
  v_q integer;
begin
  if p_url is null or btrim(p_url) = '' then
    return null;
  end if;
  v_idx := position(v_prefix in p_url);
  if v_idx = 0 then
    return null;
  end if;
  v_rest := substring(p_url from v_idx + length(v_prefix));
  -- Strip query string (signed URLs may have ?token=...)
  v_q := position('?' in v_rest);
  if v_q > 0 then
    v_rest := substring(v_rest from 1 for v_q - 1);
  end if;
  -- URL-decode (basic: %XX → byte). Supabase URLs use only standard
  -- encoding, so this is sufficient for path matching.
  v_rest := replace(v_rest, '%2F', '/');
  v_rest := replace(v_rest, '%2f', '/');
  return btrim(v_rest);
end;
$$;

revoke all on function public.extract_managed_storage_path(text)
  from public, anon, authenticated;
grant execute on function public.extract_managed_storage_path(text)
  to service_role;

-- ============================================================
-- B. Helper: enqueue managed storage cleanup (no-op for external URLs)
-- ============================================================
-- If p_url points to our public-assets bucket, extracts the path and
-- calls enqueue_storage_cleanup. Otherwise returns NULL (no-op).
-- This keeps the caller (save_product_with_images etc.) free of
-- URL-shape logic.
--
-- Returns the cleanup queue row id (uuid) if a row was created, or
-- NULL if no row was created (external URL, or idempotent skip).
create or replace function public.enqueue_managed_storage_cleanup(
  p_url text,
  p_reason text,
  p_source_type text default null,
  p_source_id uuid default null
) returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_path text;
  v_id uuid;
begin
  v_path := public.extract_managed_storage_path(p_url);
  if v_path is null or btrim(v_path) = '' then
    return null; -- external URL or empty → no enqueue
  end if;
  -- Bucket is always 'public-assets' because extract_managed_storage_path
  -- only matches the public-assets URL prefix. private-assets objects
  -- are managed by the publish flow + their own cleanup path.
  v_id := public.enqueue_storage_cleanup(
    p_bucket := 'public-assets',
    p_object_path := v_path,
    p_reason := p_reason,
    p_source_type := p_source_type,
    p_source_id := p_source_id
  );
  return v_id;
end;
$$;

revoke all on function public.enqueue_managed_storage_cleanup(text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_managed_storage_cleanup(text, text, text, uuid)
  to service_role;

-- ============================================================
-- C. Replace save_product_with_images to enqueue removed images
-- ============================================================
-- The function is replaced with a version that:
--   1. Captures old product_images.image_url rows before DELETE.
--   2. Captures old products.cover_image_url / video_url before UPDATE.
--   3. After applying new images and product fields, computes
--      removed = old - new for each URL field.
--   4. For each removed URL, calls enqueue_managed_storage_cleanup
--      (no-op for external URLs).
--   5. All enqueues run in the SAME transaction as the business write.
--      If the save fails, the enqueues roll back too.
--
-- The signature is unchanged: (uuid, jsonb, jsonb, timestamptz).
-- Callers do not need to be updated.
drop function if exists public.save_product_with_images(uuid, jsonb, jsonb, timestamptz);

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
  -- Snapshots of OLD URLs (before update) for cleanup enqueue
  v_old_cover_image_url text;
  v_old_video_url text;
  v_old_image_urls text[] := array[]::text[];
  -- NEW URLs (after update) for diffing
  v_new_cover_image_url text;
  v_new_video_url text;
  v_new_image_urls text[] := array[]::text[];
  -- Diff result
  v_removed_url text;
  v_kept boolean;
  v_existing_url text;
begin
  if p_product is null
     or btrim(p_product->>'name_cn') is null
     or btrim(p_product->>'slug') is null then
    raise exception 'product name_cn and slug are required'
      using errcode = '23502';
  end if;

  -- Capture OLD image URLs and product URL fields BEFORE mutation.
  -- Only relevant when updating an existing product; new products
  -- have nothing to clean up.
  if p_id is not null then
    select cover_image_url, video_url
      into v_old_cover_image_url, v_old_video_url
      from public.products
      where id = p_id;

    select array_agg(image_url) into v_old_image_urls
      from public.product_images
      where product_id = p_id;
    if v_old_image_urls is null then
      v_old_image_urls := array[]::text[];
    end if;
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
    -- Optimistic locking: only update if expected_updated_at matches.
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
      -- Collect NEW image URLs
      v_new_image_urls := array_append(v_new_image_urls, v_url);
    end loop;
  end if;

  -- Collect NEW product URL fields
  v_new_cover_image_url := nullif(p_product->>'cover_image_url', '');
  v_new_video_url := nullif(p_product->>'video_url', '');

  -- ============================================================
  -- Transactional cleanup enqueue: removed = old - new
  -- ============================================================
  -- Only enqueue URLs that:
  --   - Exist in OLD (had a value before)
  --   - Do NOT exist in NEW (no longer referenced)
  --   - Match our managed public-assets URL pattern (external URLs
  --     are NOT enqueued — we never delete what we do not own)
  --
  -- enqueue_managed_storage_cleanup is idempotent: if a cleanup row
  -- is already pending/claimed/retry for the same (bucket, path),
  -- it returns NULL without creating a duplicate.

  -- 1. Removed product images
  foreach v_removed_url in array v_old_image_urls
  loop
    if v_removed_url is null or btrim(v_removed_url) = '' then
      continue;
    end if;
    v_kept := false;
    foreach v_existing_url in array v_new_image_urls
    loop
      if v_existing_url = v_removed_url then
        v_kept := true;
        exit;
      end if;
    end loop;
    if not v_kept then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_removed_url,
        p_reason := 'replaced',
        p_source_type := 'product_image',
        p_source_id := v_id
      );
    end if;
  end loop;

  -- 2. Removed cover_image_url (only if value changed)
  if v_old_cover_image_url is not null
     and btrim(v_old_cover_image_url) <> ''
     and v_old_cover_image_url <> coalesce(v_new_cover_image_url, '') then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_cover_image_url,
      p_reason := 'replaced',
      p_source_type := 'product_cover_image',
      p_source_id := v_id
    );
  end if;

  -- 3. Removed video_url (only if value changed)
  if v_old_video_url is not null
     and btrim(v_old_video_url) <> ''
     and v_old_video_url <> coalesce(v_new_video_url, '') then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_video_url,
      p_reason := 'replaced',
      p_source_type := 'product_video',
      p_source_id := v_id
    );
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_product_with_images(uuid, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_product_with_images(uuid, jsonb, jsonb, timestamptz)
  to service_role;

-- ============================================================
-- D. Replace save_project_with_relations to enqueue removed images
-- ============================================================
-- Same pattern as save_product_with_images: capture old image URLs,
-- old cover_image_url and old video_url; after applying new fields,
-- enqueue removed managed URLs in the same transaction.
drop function if exists public.save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz);

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
  -- Snapshots of OLD URLs
  v_old_cover_image_url text;
  v_old_video_url text;
  v_old_image_urls text[] := array[]::text[];
  -- NEW URLs
  v_new_cover_image_url text;
  v_new_video_url text;
  v_new_image_urls text[] := array[]::text[];
  -- Diff
  v_removed_url text;
  v_kept boolean;
  v_existing_url text;
begin
  if p_project is null
     or btrim(p_project->>'title_cn') is null
     or btrim(p_project->>'slug') is null then
    raise exception 'project title_cn and slug are required'
      using errcode = '23502';
  end if;

  -- Capture OLD URLs for existing project
  if p_id is not null then
    select cover_image_url, video_url
      into v_old_cover_image_url, v_old_video_url
      from public.projects
      where id = p_id;

    select array_agg(image_url) into v_old_image_urls
      from public.project_images
      where project_id = p_id;
    if v_old_image_urls is null then
      v_old_image_urls := array[]::text[];
    end if;
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

  -- Replace project images atomically
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
      v_new_image_urls := array_append(v_new_image_urls, v_url);
    end loop;
  end if;

  -- Replace project-product links atomically
  delete from public.project_products where project_id = v_id;
  if p_products is not null and jsonb_typeof(p_products) = 'array' then
    for v_link in select * from jsonb_array_elements(p_products) loop
      insert into public.project_products (project_id, product_id, sort_order)
      values (
        v_id,
        nullif(v_link->>'product_id', '')::uuid,
        coalesce((v_link->>'sort_order')::int, 0)
      );
    end loop;
  end if;

  v_new_cover_image_url := nullif(p_project->>'cover_image_url', '');
  v_new_video_url := nullif(p_project->>'video_url', '');

  -- Transactional cleanup enqueue for removed project images and URLs
  foreach v_removed_url in array v_old_image_urls
  loop
    if v_removed_url is null or btrim(v_removed_url) = '' then
      continue;
    end if;
    v_kept := false;
    foreach v_existing_url in array v_new_image_urls
    loop
      if v_existing_url = v_removed_url then
        v_kept := true;
        exit;
      end if;
    end loop;
    if not v_kept then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_removed_url,
        p_reason := 'replaced',
        p_source_type := 'project_image',
        p_source_id := v_id
      );
    end if;
  end loop;

  if v_old_cover_image_url is not null
     and btrim(v_old_cover_image_url) <> ''
     and v_old_cover_image_url <> coalesce(v_new_cover_image_url, '') then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_cover_image_url,
      p_reason := 'replaced',
      p_source_type := 'project_cover_image',
      p_source_id := v_id
    );
  end if;

  if v_old_video_url is not null
     and btrim(v_old_video_url) <> ''
     and v_old_video_url <> coalesce(v_new_video_url, '') then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_video_url,
      p_reason := 'replaced',
      p_source_type := 'project_video',
      p_source_id := v_id
    );
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)
  to service_role;

-- ============================================================
-- D.2. Replace save_product_with_images_and_audit (PRODUCTION RPC)
-- ============================================================
-- The application calls save_product_with_images_and_audit, NOT
-- save_product_with_images directly. This wrapper adds audit logging
-- on top of the underlying business write. We replace it here with a
-- version that ALSO captures old image URLs / cover_image_url /
-- video_url and enqueues removed managed URLs into
-- storage_cleanup_queue in the SAME transaction.
--
-- Atomicity guarantee:
--   - If audit log insert fails → business write + cleanup enqueue
--     roll back (no partial state).
--   - If cleanup enqueue fails → business write + audit roll back.
--   - If business write fails → nothing else runs.
--
-- The signature is unchanged so callers (admin-product-write.ts) do
-- not need to be updated.
drop function if exists public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text);

create or replace function public.save_product_with_images_and_audit(
  p_id uuid,
  p_product jsonb,
  p_images jsonb default '[]'::jsonb,
  p_expected_updated_at timestamptz default null,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_img jsonb;
  v_row jsonb;
  v_action text;
  v_name text;
  v_url text;
  -- Snapshots of OLD URLs (before update) for cleanup enqueue
  v_old_cover_image_url text;
  v_old_video_url text;
  v_old_image_urls text[] := array[]::text[];
  -- NEW URLs (after update) for diffing
  v_new_cover_image_url text;
  v_new_video_url text;
  v_new_image_urls text[] := array[]::text[];
  -- Diff result
  v_removed_url text;
  v_kept boolean;
  v_existing_url text;
begin
  if p_product is null
     or btrim(p_product->>'name_cn') is null
     or btrim(p_product->>'slug') is null then
    raise exception 'product name_cn and slug are required'
      using errcode = '23502';
  end if;

  v_img := coalesce(p_images, '[]'::jsonb);

  -- Capture OLD image URLs and product URL fields BEFORE mutation
  -- (only relevant for UPDATE; new products have nothing to clean up)
  if p_id is not null then
    select cover_image_url, video_url
      into v_old_cover_image_url, v_old_video_url
      from public.products
      where id = p_id;

    select array_agg(image_url) into v_old_image_urls
      from public.product_images
      where product_id = p_id;
    if v_old_image_urls is null then
      v_old_image_urls := array[]::text[];
    end if;
  end if;

  if p_id is null then
    v_action := 'product.create';
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
      nullif(p_product->>'fire_rating', ''),
      nullif(p_product->>'eco_grade', ''),
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
      coalesce(nullif(p_product->>'sort_order', '')::integer, 0),
      nullif(p_product->>'seo_title_cn', ''),
      nullif(p_product->>'seo_title_en', ''),
      nullif(p_product->>'seo_description_cn', ''),
      nullif(p_product->>'seo_description_en', ''),
      nullif(p_product->>'geo_summary_cn', ''),
      nullif(p_product->>'geo_summary_en', ''),
      p_product->'keywords_cn',
      p_product->'keywords_en',
      p_product->'search_aliases',
      p_product->'schema_extra',
      p_product->'faq_cn',
      p_product->'faq_en'
    ) returning id into v_id;
  else
    v_action := 'product.update';
    -- Optimistic lock check
    if p_expected_updated_at is not null then
      perform 1 from public.products
        where id = p_id and updated_at = p_expected_updated_at
        for update;
      if not found then
        raise exception 'optimistic lock conflict'
          using errcode = '40P01';
      end if;
    end if;

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
      fire_rating = nullif(p_product->>'fire_rating', ''),
      eco_grade = nullif(p_product->>'eco_grade', ''),
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
      sort_order = coalesce(nullif(p_product->>'sort_order', '')::integer, 0),
      seo_title_cn = nullif(p_product->>'seo_title_cn', ''),
      seo_title_en = nullif(p_product->>'seo_title_en', ''),
      seo_description_cn = nullif(p_product->>'seo_description_cn', ''),
      seo_description_en = nullif(p_product->>'seo_description_en', ''),
      geo_summary_cn = nullif(p_product->>'geo_summary_cn', ''),
      geo_summary_en = nullif(p_product->>'geo_summary_en', ''),
      keywords_cn = p_product->'keywords_cn',
      keywords_en = p_product->'keywords_en',
      search_aliases = p_product->'search_aliases',
      schema_extra = p_product->'schema_extra',
      faq_cn = p_product->'faq_cn',
      faq_en = p_product->'faq_en',
      updated_at = now()
    where id = p_id
    returning id into v_id;

    if v_id is null then
      raise exception 'product not found' using errcode = 'P0002';
    end if;

    -- Replace images atomically
    delete from public.product_images where product_id = v_id;
  end if;

  -- Insert images
  if jsonb_typeof(v_img) = 'array' then
    for i in 0 .. jsonb_array_length(v_img) - 1 loop
      v_row := v_img->i;
      v_url := v_row->>'image_url';
      insert into public.product_images (product_id, image_url, alt_cn, alt_en, sort_order)
      values (
        v_id,
        v_url,
        nullif(v_row->>'alt_cn', ''),
        nullif(v_row->>'alt_en', ''),
        coalesce(nullif(v_row->>'sort_order', '')::integer, i)
      );
      -- Collect NEW image URLs
      if v_url is not null then
        v_new_image_urls := array_append(v_new_image_urls, v_url);
      end if;
    end loop;
  end if;

  v_name := p_product->>'name_cn';

  -- Collect NEW product URL fields
  v_new_cover_image_url := nullif(p_product->>'cover_image_url', '');
  v_new_video_url := nullif(p_product->>'video_url', '');

  -- Atomic audit log insert — fails the transaction if it errors
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id, p_actor_email, p_actor_role, v_action, 'product', v_id::text,
    case when v_action = 'product.create'
      then 'Created product "' || coalesce(v_name, v_id::text) || '"'
      else 'Updated product "' || coalesce(v_name, v_id::text) || '"'
    end
  );

  -- ============================================================
  -- Transactional cleanup enqueue: removed = old - new
  -- ============================================================
  -- Only enqueue URLs that:
  --   - Exist in OLD (had a value before)
  --   - Do NOT exist in NEW (no longer referenced)
  --   - Match our managed public-assets URL pattern (external URLs
  --     are NOT enqueued — we never delete what we do not own)
  --
  -- enqueue_managed_storage_cleanup is idempotent: if a cleanup row
  -- is already pending/claimed/retry for the same (bucket, path),
  -- it returns NULL without creating a duplicate.

  -- 1. Removed product images
  foreach v_removed_url in array v_old_image_urls
  loop
    if v_removed_url is null or btrim(v_removed_url) = '' then
      continue;
    end if;
    v_kept := false;
    foreach v_existing_url in array v_new_image_urls
    loop
      if v_existing_url = v_removed_url then
        v_kept := true;
        exit;
      end if;
    end loop;
    if not v_kept then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_removed_url,
        p_reason := 'replaced',
        p_source_type := 'product_image',
        p_source_id := v_id
      );
    end if;
  end loop;

  -- 2. Removed cover_image_url (only if value changed)
  if v_old_cover_image_url is not null
     and btrim(v_old_cover_image_url) <> ''
     and v_old_cover_image_url <> coalesce(v_new_cover_image_url, '') then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_cover_image_url,
      p_reason := 'replaced',
      p_source_type := 'product_cover_image',
      p_source_id := v_id
    );
  end if;

  -- 3. Removed video_url (only if value changed)
  if v_old_video_url is not null
     and btrim(v_old_video_url) <> ''
     and v_old_video_url <> coalesce(v_new_video_url, '') then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_video_url,
      p_reason := 'replaced',
      p_source_type := 'product_video',
      p_source_id := v_id
    );
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- E. schema_verification_rpc: add new helpers to known list
-- ============================================================
-- The schema_verification RPC validates that expected functions exist.
-- We add the two new helpers so the readiness check knows about them.
-- (The verification RPC is replaced rather than altered to keep the
-- migration forward-only and idempotent.)
create or replace function public.verify_required_schema() returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_missing text[];
  v_fn_exists boolean;
  v_table_exists boolean;
  v_col_exists boolean;
begin
  -- Tables
  select exists(select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'inquiries')
    into v_table_exists;
  if not v_table_exists then v_missing := array_append(v_missing, 'table:inquiries'); end if;

  select exists(select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'inquiry_outbox')
    into v_table_exists;
  if not v_table_exists then v_missing := array_append(v_missing, 'table:inquiry_outbox'); end if;

  select exists(select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'inquiry_outbox_deliveries')
    into v_table_exists;
  if not v_table_exists then v_missing := array_append(v_missing, 'table:inquiry_outbox_deliveries'); end if;

  select exists(select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'storage_cleanup_queue')
    into v_table_exists;
  if not v_table_exists then v_missing := array_append(v_missing, 'table:storage_cleanup_queue'); end if;

  select exists(select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'admin_storage_operations')
    into v_table_exists;
  if not v_table_exists then v_missing := array_append(v_missing, 'table:admin_storage_operations'); end if;

  -- Functions (representative; not exhaustive)
  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'create_inquiry_with_items')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:create_inquiry_with_items'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'save_product_with_images')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:save_product_with_images'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'save_project_with_relations')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:save_project_with_relations'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'enqueue_storage_cleanup')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:enqueue_storage_cleanup'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'enqueue_managed_storage_cleanup')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:enqueue_managed_storage_cleanup'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'extract_managed_storage_path')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:extract_managed_storage_path'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'check_storage_object_referenced')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:check_storage_object_referenced'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'claim_storage_cleanup')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:claim_storage_cleanup'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'complete_storage_cleanup')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:complete_storage_cleanup'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'publish_catalog_asset')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:publish_catalog_asset'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'record_storage_operation_started')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:record_storage_operation_started'); end if;

  select exists(select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'complete_storage_operation')
    into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:complete_storage_operation'); end if;

  v_result := jsonb_build_object(
    'ok', array_length(v_missing, 1) is null,
    'missing', to_jsonb(coalesce(v_missing, array[]::text[]))
  );

  return v_result;
end;
$$;

revoke all on function public.verify_required_schema()
  from public, anon, authenticated;
grant execute on function public.verify_required_schema()
  to service_role;
