-- ============================================================
-- Migration 20260725280000
-- Extend Managed Storage Registry coverage + fix projects.video_url bug
-- ============================================================
-- This migration closes three gaps surfaced during the PR #12 review:
--
--   1. BUG: save_project_with_relations (frozen by 20260725160000)
--      and delete_project_with_audit (frozen by 20260725220000)
--      both reference a `projects.video_url` column that does NOT
--      exist on public.projects (created in 20260714084116). Only
--      public.products has video_url. The bad SELECT would raise
--      `column does not exist` at runtime the first time a project
--      update/delete touches a row whose cover_image_url is non-null.
--      In practice the bug is latent because the FOR UPDATE / select
--      list is parsed at function EXECUTE time, not CREATE time, and
--      the admin UI rarely exercises the project edit flow under
--      service_role. But it WILL fail the moment a real edit lands.
--      The earlier fix 20260725150000 only patched
--      check_storage_object_referenced; it did NOT touch the two
--      RPCs that still select the dead column.
--
--   2. COVERAGE GAP: check_storage_object_referenced only inspects
--      products / product_images / product_assets / certificates /
--      projects.cover_image_url. It does NOT inspect:
--        - project_images.image_url
--        - company_profile.logo_url
--        - company_profile.wechat_qr_url
--        - site_settings.default_og_image_url
--      The Cleanup Dispatcher calls check_storage_object_referenced
--      before physically deleting a managed object. Without these
--      four columns, the dispatcher could delete an object that is
--      still referenced by a project image, company logo, wechat QR,
--      or site OG image — a data-loss bug.
--
--   3. REGISTRY COVERAGE: storage_object_refs (created in
--      20260725170000) reserves owner_type values for
--      product_image / product_cover / product_video /
--      project_image / project_cover / company_logo /
--      company_wechat_qr / site_og_image — but the only callers of
--      register_storage_object_ref today are the Catalog and
--      Certificate publish flows. Every other business write RPC
--      enqueues cleanup for replaced URLs (via
--      enqueue_managed_storage_cleanup) WITHOUT registering the new
--      ref, so the registry has no active row pointing at the
--      surviving object. That breaks audit reconciliation: there is
--      no way to enumerate "every managed object currently owned
--      by this product/project/company" without re-scanning the
--      business tables.
--
--      This migration adds a thin helper
--      `register_managed_storage_ref_from_url` (URL -> bucket + path
--      -> register_storage_object_ref) and wires it into:
--        - save_product_with_images_and_audit (product_cover,
--          product_video, product_image*)
--        - save_project_with_relations_and_audit (project_cover,
--          project_image*)
--        - save_company_profile_with_audit (company_logo,
--          company_wechat_qr)
--        - save_site_settings_with_audit (site_og_image)
--      (* = one ref per image row, owner_id = product/project id
--       plus a deterministic role suffix is NOT allowed by the
--       single-active-ref unique index, so we register image refs
--       with role = 'image' and accept that only the most recently
--       inserted image is the 'active' one. Image-row-level tracking
--       is handled by the cleanup queue's source_id, not by the
--       registry. The registry's job here is to mark "this product
--       owns at least one managed image", which is enough for
--       audit reconciliation to find orphaned objects.)
--
-- Forward-only. Signatures unchanged. No data backfill.
-- ============================================================


-- ============================================================
-- A. register_managed_storage_ref_from_url helper
-- ============================================================
-- If p_url points to our public-assets bucket, extracts the path
-- and calls register_storage_object_ref. Otherwise returns NULL
-- (external URL or empty -> not a managed object, no ref to track).
--
-- This is the URL-aware twin of enqueue_managed_storage_cleanup:
--   * enqueue_managed_storage_cleanup schedules the OLD object for
--     physical deletion.
--   * register_managed_storage_ref_from_url records the NEW object
--     as the active ref so audit reconciliation can find it.
--
-- Both helpers are no-ops for external URLs.
--
-- Returns the storage_object_refs.id of the new active ref, or NULL.
create or replace function public.register_managed_storage_ref_from_url(
  p_owner_type text,
  p_owner_id uuid,
  p_role text,
  p_url text,
  p_visibility text default 'public',
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_sha256 text default null
) returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_path text;
  v_ref_id uuid;
begin
  if p_owner_type is null or p_owner_id is null or p_role is null
     or p_url is null or btrim(p_url) = '' then
    return null;
  end if;
  -- Only public-assets URLs are managed. private-assets is handled
  -- by the Catalog/Certificate publish flow directly (with bucket
  -- and path passed explicitly). External URLs are not tracked.
  v_path := public.extract_managed_storage_path(p_url);
  if v_path is null or btrim(v_path) = '' then
    return null;
  end if;
  v_ref_id := public.register_storage_object_ref(
    p_owner_type := p_owner_type,
    p_owner_id := p_owner_id,
    p_role := p_role,
    p_bucket := 'public-assets',
    p_object_path := v_path,
    p_visibility := p_visibility,
    p_mime_type := p_mime_type,
    p_size_bytes := p_size_bytes,
    p_sha256 := p_sha256
  );
  return v_ref_id;
end;
$$;

revoke all on function public.register_managed_storage_ref_from_url(
  text, uuid, text, text, text, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.register_managed_storage_ref_from_url(
  text, uuid, text, text, text, text, bigint, text
) to service_role;


-- ============================================================
-- B. Replace check_storage_object_referenced to cover all
--    managed-URL columns
-- ============================================================
-- Same signature (text, text) -> boolean. Adds four new column
-- scans. The order is preserved (products first, certificates last)
-- to keep the function's behavior stable for the existing callers.
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
  -- (projects has NO video_url column — see migration 20260725150000.)
  select count(*) into v_count from public.projects
    where cover_image_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check project_images.image_url
  select count(*) into v_count from public.project_images
    where image_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check company_profile.logo_url / wechat_qr_url
  select count(*) into v_count from public.company_profile
    where logo_url like v_pattern
       or wechat_qr_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check site_settings.default_og_image_url
  select count(*) into v_count from public.site_settings
    where default_og_image_url like v_pattern;
  if v_count > 0 then return true; end if;

  return false;
end;
$$;

revoke all on function public.check_storage_object_referenced(text, text)
  from public, anon, authenticated;
grant execute on function public.check_storage_object_referenced(text, text)
  to service_role;


-- ============================================================
-- C. Replace save_product_with_images_and_audit to register refs
-- ============================================================
-- Same signature. The only behavioral change vs the version frozen
-- by 20260725160000 is:
--   * After applying new images / cover / video, ALSO call
--     register_managed_storage_ref_from_url for each NEW managed
--     URL. This creates active refs in storage_object_refs so
--     audit reconciliation can enumerate every managed object
--     currently owned by this product.
--   * Refs are registered AFTER the business write + audit log
--     insert succeed, in the SAME transaction. Any failure rolls
--     back the business write + audit + ref registration together.
--
-- The existing enqueue_managed_storage_cleanup calls for REMOVED
-- URLs are unchanged — they still enqueue cleanup for the OLD
-- object. The new register calls record the NEW object as active.
--
-- Image refs: only one active (owner_type, owner_id, role='image')
-- ref is allowed per product (unique partial index). We register
-- the FIRST image in the array; this is enough to mark "this
-- product owns at least one managed image". Per-image tracking is
-- the cleanup queue's job (source_id = product id, source_type =
-- 'product_image'), not the registry's.
-- ============================================================
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
  v_first_image_url text;
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
        if v_first_image_url is null then
          v_first_image_url := v_url;
        end if;
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

  -- ============================================================
  -- Register NEW managed object refs (active) for audit reconcile
  -- ============================================================
  -- No-op for external URLs. Supersedes any prior active ref for
  -- the same (owner_type, owner_id, role) tuple. Image refs use
  -- role='image' and only the first image is registered (see
  -- migration header for rationale).
  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'product_cover',
    p_owner_id := v_id,
    p_role := 'cover',
    p_url := v_new_cover_image_url
  );
  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'product_video',
    p_owner_id := v_id,
    p_role := 'video',
    p_url := v_new_video_url
  );
  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'product_image',
    p_owner_id := v_id,
    p_role := 'image',
    p_url := v_first_image_url
  );

  return v_id;
end;
$$;

revoke all on function public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- D. Replace save_project_with_relations to drop video_url bug
-- ============================================================
-- Same signature. Two changes vs the version frozen by
-- 20260725160000:
--   1. BUG FIX: remove the `select cover_image_url, video_url ...
--      from public.projects` line. projects has NO video_url
--      column (only products does). The bad select would raise
--      `column projects.video_url does not exist` at runtime.
--      Also remove the corresponding enqueue_managed_storage_cleanup
--      call for the (non-existent) project video_url.
--   2. Register managed refs for the NEW cover_image_url and first
--      project_image after the business write + audit (when called
--      via the *_and_audit wrapper) — actually this function is
--      the inner helper; ref registration belongs in the audit
--      wrapper (section E below) to keep the inner helper
--      side-effect-free of registry writes. This section ONLY
--      fixes the video_url bug.
-- ============================================================
create or replace function public.save_project_with_relations(
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
  v_old_image_urls text[] := array[]::text[];
  -- NEW URLs
  v_new_cover_image_url text;
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

  -- Capture OLD URLs for existing project.
  -- NOTE: public.projects has NO video_url column (only products does).
  -- The earlier version of this function selected video_url from
  -- public.projects, which raised `column does not exist` at runtime.
  if p_id is not null then
    select cover_image_url
      into v_old_cover_image_url
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

  -- Transactional cleanup enqueue for removed project images and cover
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

  -- NOTE: public.projects has NO video_url column. The earlier
  -- version of this function had a third enqueue_managed_storage_cleanup
  -- call for `v_old_video_url` here; that code path was dead AND
  -- the upstream `select ... video_url from public.projects` would
  -- raise `column does not exist`. Both are removed.

  return v_id;
end;
$$;

revoke all on function public.save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)
  to service_role;


-- ============================================================
-- E. Replace save_project_with_relations_and_audit to register refs
-- ============================================================
-- Same signature. The only behavioral change vs the version frozen
-- by 20260725220000 is: after the underlying save_project_with_relations
-- + audit insert succeed, register managed refs for the NEW
-- cover_image_url and first project_image. This marks "this project
-- owns at least one managed cover/image" for audit reconciliation.
-- ============================================================
create or replace function public.save_project_with_relations_and_audit(
  p_id uuid,
  p_project jsonb,
  p_images jsonb default '[]'::jsonb,
  p_products jsonb default '[]'::jsonb,
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
  v_action text;
  v_title text;
  v_first_image_url text;
  v_img jsonb;
  v_url text;
begin
  -- Delegate the business write + cleanup enqueue to the existing RPC.
  -- Any error raised inside propagates and aborts this transaction.
  v_id := public.save_project_with_relations(
    p_id := p_id,
    p_project := p_project,
    p_images := p_images,
    p_products := p_products,
    p_expected_updated_at := p_expected_updated_at
  );

  if v_id is null then
    raise exception 'save_project_with_relations returned null'
      using errcode = 'P0001';
  end if;

  -- Determine action and fetch display title for the audit summary.
  if p_id is null then
    v_action := 'project.create';
  else
    v_action := 'project.update';
  end if;

  select title_cn into v_title from public.projects where id = v_id;

  -- Atomic audit insert — same transaction as the business write.
  -- Failure here rolls back the project save (no best-effort audit).
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'project',
    v_id::text,
    coalesce(v_title, '')
  );

  -- Register managed refs for NEW cover + first image. No-op for
  -- external URLs. Supersedes any prior active ref.
  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'project_cover',
    p_owner_id := v_id,
    p_role := 'cover',
    p_url := nullif(p_project->>'cover_image_url', '')
  );

  if p_images is not null and jsonb_typeof(p_images) = 'array' then
    for v_img in select * from jsonb_array_elements(p_images) loop
      v_url := v_img->>'image_url';
      if v_url is not null and btrim(v_url) <> '' then
        v_first_image_url := v_url;
        exit; -- first only
      end if;
    end loop;
  end if;

  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'project_image',
    p_owner_id := v_id,
    p_role := 'image',
    p_url := v_first_image_url
  );

  return v_id;
end;
$$;

revoke all on function public.save_project_with_relations_and_audit(
  uuid, jsonb, jsonb, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_project_with_relations_and_audit(
  uuid, jsonb, jsonb, jsonb, timestamptz, uuid, text, text
) to service_role;


-- ============================================================
-- F. Replace delete_project_with_audit to drop video_url bug
-- ============================================================
-- Same signature. Two changes vs the version frozen by
-- 20260725220000:
--   1. BUG FIX: remove the `select cover_image_url, video_url ...
--      from public.projects` line. projects has NO video_url column.
--      Also remove the corresponding enqueue_managed_storage_cleanup
--      call for the (non-existent) project video_url, and the
--      v_old_video_url declaration.
--   2. Mark all active storage_object_refs for this project
--      (project_cover, project_image) as pending_delete so audit
--      reconciliation knows the objects are pending physical
--      deletion. (The cleanup queue still owns the actual delete.)
-- ============================================================
create or replace function public.delete_project_with_audit(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row_exists boolean;
  v_old_cover_image_url text;
  v_old_image_urls text[] := array[]::text[];
  v_url text;
  v_title text;
begin
  if p_id is null then
    raise exception 'project id required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at required' using errcode = '22004';
  end if;

  -- Optimistic lock: SELECT ... FOR UPDATE to pin the row.
  -- NOTE: public.projects has NO video_url column (only products does).
  -- The earlier version of this function selected video_url from
  -- public.projects, which raised `column does not exist` at runtime.
  select cover_image_url, title_cn
    into v_old_cover_image_url, v_title
    from public.projects
    where id = p_id
    for update;

  if not found then
    -- Distinguish "row doesn't exist" from "stale updated_at".
    perform 1 from public.projects where id = p_id;
    if found then
      raise exception 'project updated by another transaction'
        using errcode = '40P01';
    end if;
    raise exception 'project not found' using errcode = 'P0002';
  end if;

  -- Verify updated_at matches. We use a separate check because the
  -- FOR UPDATE above does not include updated_at in the predicate.
  perform 1 from public.projects
    where id = p_id
      and updated_at = p_expected_updated_at;
  if not found then
    raise exception 'project updated by another transaction'
      using errcode = '40P01';
  end if;

  -- Capture old image URLs BEFORE delete (CASCADE will wipe them).
  select array_agg(image_url) into v_old_image_urls
    from public.project_images
    where project_id = p_id;
  if v_old_image_urls is null then
    v_old_image_urls := array[]::text[];
  end if;

  -- Delete the project. FK ON DELETE CASCADE removes project_images
  -- and project_products atomically.
  delete from public.projects where id = p_id;

  -- Enqueue removed managed Storage URLs for cleanup.
  -- External URLs and private-assets:// paths are skipped by
  -- enqueue_managed_storage_cleanup (returns NULL for non-managed).
  foreach v_url in array v_old_image_urls
  loop
    if v_url is null or btrim(v_url) = '' then
      continue;
    end if;
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_url,
      p_reason := 'row_deleted',
      p_source_type := 'project_image',
      p_source_id := p_id
    );
  end loop;

  if v_old_cover_image_url is not null
     and btrim(v_old_cover_image_url) <> '' then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_cover_image_url,
      p_reason := 'row_deleted',
      p_source_type := 'project_cover_image',
      p_source_id := p_id
    );
  end if;

  -- NOTE: public.projects has NO video_url column. The earlier
  -- version of this function had a third enqueue_managed_storage_cleanup
  -- call for `v_old_video_url` here; that code path was dead AND
  -- the upstream select would raise. Removed.

  -- Mark all active storage_object_refs for this project as
  -- pending_delete. The cleanup queue still owns the physical
  -- delete; this just keeps the registry truthful.
  perform public.mark_storage_object_refs_pending_delete(
    p_owner_type := 'project_cover',
    p_owner_id := p_id
  );
  perform public.mark_storage_object_refs_pending_delete(
    p_owner_type := 'project_image',
    p_owner_id := p_id
  );

  -- Atomic audit insert — same transaction as the delete.
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    'project.delete',
    'project',
    p_id::text,
    coalesce(v_title, '')
  );

  return p_id;
end;
$$;

revoke all on function public.delete_project_with_audit(
  uuid, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.delete_project_with_audit(
  uuid, timestamptz, uuid, text, text
) to service_role;


-- ============================================================
-- G. Replace save_company_profile_with_audit to register refs
-- ============================================================
-- Same signature. The only behavioral change vs the version frozen
-- by 20260725230000 is: after the business write + audit succeed,
-- register managed refs for the NEW logo_url and wechat_qr_url.
-- ============================================================
create or replace function public.save_company_profile_with_audit(
  p_id uuid,
  p_payload jsonb,
  p_expected_updated_at timestamptz default null,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.company_profile%rowtype;
  v_old_logo_url text;
  v_old_wechat_qr_url text;
  v_id uuid;
  v_action text;
begin
  if p_payload is null then
    raise exception 'payload is required' using errcode = '22004';
  end if;

  if p_id is not null then
    -- UPDATE: optimistic lock via SELECT ... FOR UPDATE
    select * into v_existing
      from public.company_profile
      where id = p_id
      for update;

    if not found then
      raise exception 'company_profile not found' using errcode = 'P0002';
    end if;

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for update'
        using errcode = '22004';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    v_old_logo_url := v_existing.logo_url;
    v_old_wechat_qr_url := v_existing.wechat_qr_url;

    update public.company_profile set
      title_cn = nullif(p_payload->>'title_cn', ''),
      title_en = nullif(p_payload->>'title_en', ''),
      description_cn = nullif(p_payload->>'description_cn', ''),
      description_en = nullif(p_payload->>'description_en', ''),
      advantages_cn = p_payload->'advantages_cn',
      advantages_en = p_payload->'advantages_en',
      phone = nullif(p_payload->>'phone', ''),
      wechat = nullif(p_payload->>'wechat', ''),
      email = nullif(p_payload->>'email', ''),
      whatsapp = nullif(p_payload->>'whatsapp', ''),
      address_cn = nullif(p_payload->>'address_cn', ''),
      address_en = nullif(p_payload->>'address_en', ''),
      wechat_qr_url = nullif(p_payload->>'wechat_qr_url', ''),
      logo_url = nullif(p_payload->>'logo_url', '')
    where id = p_id;

    v_id := p_id;
    v_action := 'company_profile.update';

    -- Enqueue old managed storage objects for cleanup if replaced.
    if v_old_logo_url is not null
       and btrim(v_old_logo_url) <> ''
       and (p_payload->>'logo_url' is null
            or p_payload->>'logo_url' <> v_old_logo_url) then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_old_logo_url,
        p_reason := 'replaced',
        p_source_type := 'company_logo',
        p_source_id := v_id
      );
    end if;

    if v_old_wechat_qr_url is not null
       and btrim(v_old_wechat_qr_url) <> ''
       and (p_payload->>'wechat_qr_url' is null
            or p_payload->>'wechat_qr_url' <> v_old_wechat_qr_url) then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_old_wechat_qr_url,
        p_reason := 'replaced',
        p_source_type := 'company_wechat_qr',
        p_source_id := v_id
      );
    end if;
  else
    -- INSERT
    insert into public.company_profile (
      title_cn, title_en, description_cn, description_en,
      advantages_cn, advantages_en,
      phone, wechat, email, whatsapp,
      address_cn, address_en, wechat_qr_url, logo_url
    ) values (
      nullif(p_payload->>'title_cn', ''),
      nullif(p_payload->>'title_en', ''),
      nullif(p_payload->>'description_cn', ''),
      nullif(p_payload->>'description_en', ''),
      p_payload->'advantages_cn',
      p_payload->'advantages_en',
      nullif(p_payload->>'phone', ''),
      nullif(p_payload->>'wechat', ''),
      nullif(p_payload->>'email', ''),
      nullif(p_payload->>'whatsapp', ''),
      nullif(p_payload->>'address_cn', ''),
      nullif(p_payload->>'address_en', ''),
      nullif(p_payload->>'wechat_qr_url', ''),
      nullif(p_payload->>'logo_url', '')
    ) returning id into v_id;

    v_action := 'company_profile.create';
  end if;

  -- Atomic audit insert — same transaction as the business write.
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'company_profile',
    v_id::text,
    coalesce(p_payload->>'title_cn', '')
  );

  -- Register managed refs for NEW logo + wechat_qr. No-op for
  -- external URLs.
  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'company_logo',
    p_owner_id := v_id,
    p_role := 'logo',
    p_url := nullif(p_payload->>'logo_url', '')
  );
  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'company_wechat_qr',
    p_owner_id := v_id,
    p_role := 'wechat_qr',
    p_url := nullif(p_payload->>'wechat_qr_url', '')
  );

  return jsonb_build_object(
    'id', v_id,
    'updated_at', (select updated_at from public.company_profile where id = v_id)
  );
end;
$$;

revoke all on function public.save_company_profile_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_company_profile_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) to service_role;


-- ============================================================
-- H. Replace save_site_settings_with_audit to register OG image ref
-- ============================================================
-- Same signature. The only behavioral change vs the version frozen
-- by 20260725230000 is: after the business write + audit succeed,
-- register a managed ref for the NEW default_og_image_url.
-- ============================================================
create or replace function public.save_site_settings_with_audit(
  p_id uuid,
  p_payload jsonb,
  p_expected_updated_at timestamptz default null,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.site_settings%rowtype;
  v_old_og_image_url text;
  v_id uuid;
  v_action text;
  v_default_language text;
begin
  if p_payload is null then
    raise exception 'payload is required' using errcode = '22004';
  end if;

  -- Validate required field: site_name
  if btrim(p_payload->>'site_name') is null then
    raise exception 'site_name is required' using errcode = '23502';
  end if;

  -- Validate default_language
  v_default_language := coalesce(nullif(p_payload->>'default_language', ''), 'zh');
  if v_default_language not in ('zh', 'en') then
    raise exception 'default_language must be zh or en' using errcode = '22004';
  end if;

  if p_id is not null then
    -- UPDATE: optimistic lock
    select * into v_existing
      from public.site_settings
      where id = p_id
      for update;

    if not found then
      raise exception 'site_settings not found' using errcode = 'P0002';
    end if;

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for update'
        using errcode = '22004';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    v_old_og_image_url := v_existing.default_og_image_url;

    update public.site_settings set
      site_name = p_payload->>'site_name',
      site_name_cn = nullif(p_payload->>'site_name_cn', ''),
      site_name_en = nullif(p_payload->>'site_name_en', ''),
      brand_name = nullif(p_payload->>'brand_name', ''),
      default_language = v_default_language,
      global_meta_title_cn = nullif(p_payload->>'global_meta_title_cn', ''),
      global_meta_title_en = nullif(p_payload->>'global_meta_title_en', ''),
      global_meta_description_cn = nullif(p_payload->>'global_meta_description_cn', ''),
      global_meta_description_en = nullif(p_payload->>'global_meta_description_en', ''),
      default_og_image_url = nullif(p_payload->>'default_og_image_url', ''),
      footer_text_cn = nullif(p_payload->>'footer_text_cn', ''),
      footer_text_en = nullif(p_payload->>'footer_text_en', ''),
      navigation_json = coalesce(p_payload->'navigation_json', '[]'::jsonb)
    where id = p_id;

    v_id := p_id;
    v_action := 'site_settings.update';

    -- Enqueue old OG image for cleanup if replaced.
    if v_old_og_image_url is not null
       and btrim(v_old_og_image_url) <> ''
       and (p_payload->>'default_og_image_url' is null
            or p_payload->>'default_og_image_url' <> v_old_og_image_url) then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_old_og_image_url,
        p_reason := 'replaced',
        p_source_type := 'site_og_image',
        p_source_id := v_id
      );
    end if;
  else
    -- INSERT
    insert into public.site_settings (
      site_name, site_name_cn, site_name_en, brand_name,
      default_language,
      global_meta_title_cn, global_meta_title_en,
      global_meta_description_cn, global_meta_description_en,
      default_og_image_url,
      footer_text_cn, footer_text_en,
      navigation_json
    ) values (
      p_payload->>'site_name',
      nullif(p_payload->>'site_name_cn', ''),
      nullif(p_payload->>'site_name_en', ''),
      nullif(p_payload->>'brand_name', ''),
      v_default_language,
      nullif(p_payload->>'global_meta_title_cn', ''),
      nullif(p_payload->>'global_meta_title_en', ''),
      nullif(p_payload->>'global_meta_description_cn', ''),
      nullif(p_payload->>'global_meta_description_en', ''),
      nullif(p_payload->>'default_og_image_url', ''),
      nullif(p_payload->>'footer_text_cn', ''),
      nullif(p_payload->>'footer_text_en', ''),
      coalesce(p_payload->'navigation_json', '[]'::jsonb)
    ) returning id into v_id;

    v_action := 'site_settings.create';
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'site_settings',
    v_id::text,
    coalesce(p_payload->>'site_name', '')
  );

  -- Register managed ref for NEW OG image. No-op for external URLs.
  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'site_og_image',
    p_owner_id := v_id,
    p_role := 'og_image',
    p_url := nullif(p_payload->>'default_og_image_url', '')
  );

  return jsonb_build_object(
    'id', v_id,
    'updated_at', (select updated_at from public.site_settings where id = v_id)
  );
end;
$$;

revoke all on function public.save_site_settings_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_site_settings_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) to service_role;


-- ============================================================
-- I. Update list_required_schema_objects to include the new helper
-- ============================================================
-- The prior version of list_required_schema_objects() (frozen by
-- 20260725260000) does NOT include register_managed_storage_ref_from_url
-- in its function catalog. verify_required_schema() reads from
-- list_required_schema_objects() dynamically, so adding the new
-- helper here makes the verifier check its existence automatically.
--
-- IMPORTANT: This section was previously a broken DROP+CREATE of
-- verify_required_schema() with the WRONG return type
-- (table(object_name text, object_type text) instead of
-- table(missing text)). That broke the verifier contract: every
-- test in supabase/tests/schema_verifier_runtime.sql calls
-- verify_required_schema() as v(missing) and expects 0 rows on a
-- healthy schema. The DROP+CREATE has been replaced with a
-- CREATE OR REPLACE of list_required_schema_objects() — the
-- catalog function — which is what the original intent was.
--
-- verify_required_schema() itself (defined by 20260725262000) is
-- NOT touched here. Its return type remains TABLE(missing text).
-- ============================================================
create or replace function public.list_required_schema_objects()
returns table(object_name text, object_type text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- ---- Tables ----
  return query select 'admin_profiles', 'table'::text;
  return query select 'admin_audit_log', 'table'::text;
  return query select 'storage_cleanup_queue', 'table'::text;
  return query select 'storage_object_refs', 'table'::text;
  return query select 'storage_audit_reconcile_queue', 'table'::text;
  return query select 'admin_storage_operations', 'table'::text;
  return query select 'product_assets', 'table'::text;
  return query select 'certificates', 'table'::text;
  return query select 'company_profile', 'table'::text;
  return query select 'site_settings', 'table'::text;
  return query select 'homepage_content', 'table'::text;
  return query select 'page_content', 'table'::text;
  return query select 'categories', 'table'::text;
  return query select 'subcategories', 'table'::text;
  return query select 'projects', 'table'::text;
  return query select 'project_images', 'table'::text;
  return query select 'project_products', 'table'::text;

  -- ---- Columns (catalog asset publish state machine) ----
  return query select 'product_assets.catalog_topic_id', 'column'::text;
  return query select 'product_assets.cover_image_url', 'column'::text;
  return query select 'product_assets.published_at', 'column'::text;
  return query select 'product_assets.content_hash', 'column'::text;
  return query select 'product_assets.source_bucket', 'column'::text;
  return query select 'product_assets.source_object_path', 'column'::text;
  return query select 'product_assets.published_bucket', 'column'::text;
  return query select 'product_assets.published_object_path', 'column'::text;
  return query select 'product_assets.publish_status', 'column'::text;
  return query select 'product_assets.publish_token', 'column'::text;
  return query select 'product_assets.access_level', 'column'::text;
  return query select 'product_assets.source_type', 'column'::text;
  return query select 'product_assets.authorization_status', 'column'::text;
  return query select 'product_assets.candidate_public_bucket', 'column'::text;
  return query select 'product_assets.candidate_public_path', 'column'::text;
  return query select 'product_assets.candidate_sha256', 'column'::text;
  return query select 'product_assets.last_publish_error_code', 'column'::text;

  -- ---- Columns (certificate publish state machine) ----
  return query select 'certificates.source_bucket', 'column'::text;
  return query select 'certificates.source_object_path', 'column'::text;
  return query select 'certificates.published_bucket', 'column'::text;
  return query select 'certificates.published_object_path', 'column'::text;
  return query select 'certificates.publish_status', 'column'::text;
  return query select 'certificates.publish_token', 'column'::text;
  return query select 'certificates.access_level', 'column'::text;
  return query select 'certificates.source_type', 'column'::text;
  return query select 'certificates.authorization_status', 'column'::text;
  return query select 'certificates.candidate_public_bucket', 'column'::text;
  return query select 'certificates.candidate_public_path', 'column'::text;
  return query select 'certificates.candidate_sha256', 'column'::text;
  return query select 'certificates.last_publish_error_code', 'column'::text;

  -- ---- Columns (storage_cleanup_queue audit saga) ----
  return query select 'storage_cleanup_queue.storage_operation_id', 'column'::text;
  return query select 'storage_cleanup_queue.final_status', 'column'::text;

  -- ---- Functions (storage cleanup lifecycle) ----
  return query select 'enqueue_storage_cleanup', 'function'::text;
  return query select 'claim_storage_cleanup', 'function'::text;
  return query select 'complete_storage_cleanup(uuid, uuid, boolean, text, uuid, text)', 'function'::text;
  return query select 'check_storage_object_referenced', 'function'::text;
  return query select 'extract_managed_storage_path', 'function'::text;
  return query select 'enqueue_managed_storage_cleanup', 'function'::text;
  return query select 'record_storage_operation_started', 'function'::text;
  return query select 'complete_storage_operation', 'function'::text;
  return query select 'claim_storage_audit_reconcile', 'function'::text;
  return query select 'complete_storage_audit_reconcile', 'function'::text;
  return query select 'extract_managed_storage_path_strict', 'function'::text;
  return query select 'register_storage_object_ref', 'function'::text;
  return query select 'register_managed_storage_ref_from_url', 'function'::text;
  return query select 'mark_storage_object_refs_deleted', 'function'::text;
  return query select 'mark_storage_object_refs_pending_delete', 'function'::text;

  -- ---- Functions (catalog asset publish) ----
  return query select 'claim_catalog_asset_publish', 'function'::text;
  return query select 'finalize_catalog_asset_publish', 'function'::text;
  return query select 'recover_stale_catalog_publish', 'function'::text;
  return query select 'authorize_product_asset', 'function'::text;
  return query select 'save_product_asset_draft', 'function'::text;
  return query select 'update_product_asset_metadata', 'function'::text;
  return query select 'delete_product_asset_with_cleanup', 'function'::text;
  return query select 'unpublish_catalog_asset', 'function'::text;

  -- ---- Functions (certificate publish) ----
  return query select 'save_certificate_draft', 'function'::text;
  return query select 'update_certificate_metadata', 'function'::text;
  return query select 'authorize_certificate', 'function'::text;
  return query select 'claim_certificate_publish', 'function'::text;
  return query select 'finalize_certificate_publish', 'function'::text;
  return query select 'unpublish_certificate', 'function'::text;
  return query select 'delete_certificate_with_cleanup', 'function'::text;
  return query select 'recover_stale_certificate_publish', 'function'::text;

  -- ---- Functions (transactional business writes) ----
  return query select 'save_product_with_images_and_audit', 'function'::text;
  return query select 'bulk_update_products_with_audit', 'function'::text;
  return query select 'bulk_delete_products_with_audit', 'function'::text;
  return query select 'save_project_with_relations', 'function'::text;
  return query select 'save_project_with_relations_and_audit', 'function'::text;
  return query select 'delete_project_with_audit', 'function'::text;

  -- ---- Functions (CMS content) ----
  return query select 'save_company_profile_with_audit', 'function'::text;
  return query select 'save_site_settings_with_audit', 'function'::text;
  return query select 'save_homepage_content_with_audit', 'function'::text;
  return query select 'save_page_content_with_audit', 'function'::text;
  return query select 'save_category_with_audit', 'function'::text;
  return query select 'delete_category_with_audit', 'function'::text;
  return query select 'save_subcategory_with_audit', 'function'::text;
  return query select 'delete_subcategory_with_audit', 'function'::text;

  -- ---- Functions (schema verification) ----
  return query select 'verify_schema_readiness', 'function'::text;
  return query select 'list_required_schema_objects', 'function'::text;
  return query select 'verify_required_schema', 'function'::text;

  return;
end;
$$;

revoke all on function public.list_required_schema_objects()
  from public, anon, authenticated;
grant execute on function public.list_required_schema_objects()
  to service_role;
