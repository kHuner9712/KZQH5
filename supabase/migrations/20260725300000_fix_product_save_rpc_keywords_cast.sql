-- ============================================================
-- 20260725300000_fix_product_save_rpc_keywords_cast.sql
-- ------------------------------------------------------------
-- Forward-only migration: fix PostgreSQL 16 incompatibility in
-- save_product_with_images_and_audit.
--
-- Background:
--   The function (re)defined by 20260725280000 inserts/updates the
--   text[] columns keywords_cn, keywords_en, search_aliases using
--   `p_product->'keywords_cn'` which returns jsonb. PostgreSQL 16
--   removed the implicit jsonb->text[] coercion, so every call
--   raises:
--     ERROR: column "keywords_cn" is of type text[] but expression
--            is of type jsonb
--
--   The bug existed in 20260725090000 (original definition) and was
--   carried forward verbatim by 20260725280000. It only surfaced
--   now because the storage_object_ref_lifecycle.sql test suite
--   (section N.1) calls the function with a payload that omits
--   the keywords fields, exercising the code path on PG16.
--
-- Fix:
--   Convert the jsonb value to text[] via jsonb_array_elements_text.
--   When the jsonb is NULL (key absent) or not an array, the
--   subquery returns no rows, array_agg returns NULL, and we pass
--   NULL to the nullable column -- preserving the original
--   pass-through semantics.
--
--   Only the 6 assignment sites (3 INSERT + 3 UPDATE) change;
--   the rest of the function body is copied verbatim from
--   20260725280000 to avoid introducing unrelated drift.
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
      -- PG16 fix: jsonb -> text[] via jsonb_array_elements_text.
      -- Returns NULL when the key is absent or the value is not an
      -- array, matching the original pass-through semantics.
      (select array_agg(e) from jsonb_array_elements_text(p_product->'keywords_cn') as e),
      (select array_agg(e) from jsonb_array_elements_text(p_product->'keywords_en') as e),
      (select array_agg(e) from jsonb_array_elements_text(p_product->'search_aliases') as e),
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
      -- PG16 fix: same jsonb -> text[] conversion as the INSERT path.
      keywords_cn = (select array_agg(e) from jsonb_array_elements_text(p_product->'keywords_cn') as e),
      keywords_en = (select array_agg(e) from jsonb_array_elements_text(p_product->'keywords_en') as e),
      search_aliases = (select array_agg(e) from jsonb_array_elements_text(p_product->'search_aliases') as e),
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
-- End of migration
-- ============================================================
