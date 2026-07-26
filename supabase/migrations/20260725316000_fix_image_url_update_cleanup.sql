-- ============================================================
-- Migration 20260725316000
-- Fix image URL update cleanup (per-object ref lifecycle)
-- ============================================================
-- Round-4 hardening. The reconciliation logic frozen by
-- 20260725311000 (register_each_managed_image_object) handles
-- two cases correctly:
--
--   * REMOVE image (input has no matching id) -> ref -> pending_delete,
--     cleanup enqueued, row deleted. CORRECT.
--   * INSERT new image (input has no id) -> new row, new active ref.
--     CORRECT.
--
-- But the UPDATE-by-id case has a gap:
--
--   * UPDATE image (input has id matching existing row) -> row updated,
--     register_managed_storage_ref_from_url called. The old active ref
--     is marked `superseded` (by register_storage_object_ref), NOT
--     `pending_delete`. No cleanup is enqueued for the old URL.
--
-- This means:
--   1. Replacing a product image URL by id does NOT enqueue cleanup
--      for the old object. The old Supabase storage object is leaked.
--   2. The old ref is `superseded`, not `pending_delete`, so the
--      cleanup dispatcher never processes it.
--   3. Test case "replace URL creates 1 cleanup" (round-4 requirement #6)
--      fails because the cleanup queue has 0 rows for the old path.
--
-- Fix: before UPDATE-ing an image row by id, capture the OLD url.
-- If the URL changed:
--   a. mark_storage_object_refs_pending_delete(owner_type, owner_id, role)
--      -> old active ref becomes pending_delete (eligible for cleanup).
--   b. enqueue_managed_storage_cleanup(old_url, 'replaced', ...)
--      -> old object scheduled for physical deletion.
--   c. register_managed_storage_ref_from_url(new_url) -> new active ref.
--
-- If the URL did NOT change (only alt/sort_order changed), skip (a)
-- and (b) — requirement #5: "only alt text change does not create
-- cleanup". Still call (c) to refresh the active ref.
--
-- The same gap exists in save_project_with_relations. Both are
-- fixed here.
--
-- Forward-only. Signatures unchanged. No data backfill.
-- ============================================================


-- ============================================================
-- A. save_product_with_images_and_audit (REWRITTEN)
-- ============================================================
-- Same signature: (uuid, jsonb, jsonb, timestamptz, uuid, text, text) -> uuid
--
-- Only behavioral change vs 20260725311000:
--   * UPDATE-by-id path now detects URL changes and enqueues
--     cleanup for the old URL (mark pending_delete + enqueue).
--
-- All other logic (INSERT path, REMOVE path, cover/video cleanup,
-- audit log) is unchanged.
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
  v_input_id text;
  v_input_image_id uuid;
  v_existing_image_id uuid;
  -- Snapshots of OLD state (before mutation)
  v_old_cover_image_url text;
  v_old_video_url text;
  v_existing_ids uuid[] := array[]::uuid[];
  v_input_ids uuid[] := array[]::uuid[];
  v_removed_ids uuid[] := array[]::uuid[];
  v_removed_url text;
  v_kept_image_id uuid;
  v_kept_image_url text;
  v_old_image_url text;
  v_i integer;
begin
  if p_product is null
     or btrim(p_product->>'name_cn') is null
     or btrim(p_product->>'slug') is null then
    raise exception 'product name_cn and slug are required'
      using errcode = '23502';
  end if;

  v_img := coalesce(p_images, '[]'::jsonb);

  if p_id is null then
    -- ============ INSERT path ============
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
      (select array_agg(e) from jsonb_array_elements_text(p_product->'keywords_cn') as e),
      (select array_agg(e) from jsonb_array_elements_text(p_product->'keywords_en') as e),
      (select array_agg(e) from jsonb_array_elements_text(p_product->'search_aliases') as e),
      p_product->'schema_extra',
      p_product->'faq_cn',
      p_product->'faq_en'
    ) returning id into v_id;

    -- Insert images (all are new on INSERT path)
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
        )
        returning id into v_kept_image_id;

        perform public.register_managed_storage_ref_from_url(
          p_owner_type := 'product_image',
          p_owner_id := v_kept_image_id,
          p_role := 'image',
          p_url := v_url
        );
      end loop;
    end if;
  else
    -- ============ UPDATE path ============
    v_action := 'product.update';

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for product update'
        using errcode = '22004';
    end if;
    perform 1 from public.products
      where id = p_id and updated_at = p_expected_updated_at
      for update;
    if not found then
      raise exception 'optimistic lock conflict'
        using errcode = '40P01';
    end if;

    select cover_image_url, video_url
      into v_old_cover_image_url, v_old_video_url
      from public.products
      where id = p_id;

    select coalesce(array_agg(id), array[]::uuid[])
      into v_existing_ids
      from public.product_images
      where product_id = p_id;

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

    -- ============ Image reconciliation ============
    if jsonb_typeof(v_img) = 'array' then
      for i in 0 .. jsonb_array_length(v_img) - 1 loop
        v_row := v_img->i;
        v_input_id := v_row->>'id';
        if v_input_id is not null and btrim(v_input_id) <> '' then
          v_input_ids := array_append(v_input_ids, v_input_id::uuid);
        end if;
      end loop;
    end if;

    if v_existing_ids <> array[]::uuid[] then
      foreach v_existing_image_id in array v_existing_ids loop
        if not (v_existing_image_id = any(v_input_ids)) then
          v_removed_ids := array_append(v_removed_ids, v_existing_image_id);
        end if;
      end loop;
    end if;

    -- Process removed images: ref -> pending_delete, enqueue cleanup, DELETE row
    foreach v_existing_image_id in array v_removed_ids loop
      select image_url into v_removed_url
        from public.product_images
        where id = v_existing_image_id;

      perform public.mark_storage_object_refs_pending_delete(
        p_owner_type := 'product_image',
        p_owner_id := v_existing_image_id,
        p_role := 'image'
      );

      if v_removed_url is not null and btrim(v_removed_url) <> '' then
        perform public.enqueue_managed_storage_cleanup(
          p_url := v_removed_url,
          p_reason := 'replaced',
          p_source_type := 'product_image',
          p_source_id := v_id
        );
      end if;

      delete from public.product_images where id = v_existing_image_id;
    end loop;

    -- Process input images: UPDATE if id matches, INSERT otherwise
    if jsonb_typeof(v_img) = 'array' then
      for i in 0 .. jsonb_array_length(v_img) - 1 loop
        v_row := v_img->i;
        v_url := v_row->>'image_url';
        v_input_id := v_row->>'id';

        if v_input_id is not null and btrim(v_input_id) <> ''
           and (v_input_id::uuid = any(v_existing_ids)) then
          -- UPDATE existing image row.
          -- Capture the OLD url BEFORE the update so we can detect
          -- URL changes and enqueue cleanup for the old object.
          select image_url into v_old_image_url
            from public.product_images
            where id = v_input_id::uuid;

          update public.product_images set
            image_url = v_url,
            alt_cn = nullif(v_row->>'alt_cn', ''),
            alt_en = nullif(v_row->>'alt_en', ''),
            sort_order = coalesce(nullif(v_row->>'sort_order', '')::integer, i)
          where id = v_input_id::uuid
          returning id into v_kept_image_id;

          -- If the URL changed, mark the old active ref as
          -- pending_delete (NOT superseded) and enqueue cleanup.
          -- Requirement #5: only-alt-text changes do NOT create
          -- cleanup. Requirement #6: URL replacement creates 1
          -- cleanup.
          if v_old_image_url is not null
             and btrim(v_old_image_url) <> ''
             and v_old_image_url <> coalesce(v_url, '') then
            perform public.mark_storage_object_refs_pending_delete(
              p_owner_type := 'product_image',
              p_owner_id := v_kept_image_id,
              p_role := 'image'
            );
            perform public.enqueue_managed_storage_cleanup(
              p_url := v_old_image_url,
              p_reason := 'replaced',
              p_source_type := 'product_image',
              p_source_id := v_id
            );
          end if;
        else
          -- INSERT new image row
          insert into public.product_images (product_id, image_url, alt_cn, alt_en, sort_order)
          values (
            v_id,
            v_url,
            nullif(v_row->>'alt_cn', ''),
            nullif(v_row->>'alt_en', ''),
            coalesce(nullif(v_row->>'sort_order', '')::integer, i)
          )
          returning id into v_kept_image_id;
        end if;

        -- Register one active ref per image, owner_id = image row id
        perform public.register_managed_storage_ref_from_url(
          p_owner_type := 'product_image',
          p_owner_id := v_kept_image_id,
          p_role := 'image',
          p_url := v_url
        );
      end loop;
    end if;
  end if;

  v_name := p_product->>'name_cn';

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id, p_actor_email, p_actor_role, v_action, 'product', v_id::text,
    case when v_action = 'product.create'
      then 'Created product "' || coalesce(v_name, v_id::text) || '"'
      else 'Updated product "' || coalesce(v_name, v_id::text) || '"'
    end
  );

  if v_old_cover_image_url is not null
     and btrim(v_old_cover_image_url) <> ''
     and v_old_cover_image_url <> coalesce(nullif(p_product->>'cover_image_url', ''), '') then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_cover_image_url,
      p_reason := 'replaced',
      p_source_type := 'product_cover_image',
      p_source_id := v_id
    );
  end if;

  if v_old_video_url is not null
     and btrim(v_old_video_url) <> ''
     and v_old_video_url <> coalesce(nullif(p_product->>'video_url', ''), '') then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_video_url,
      p_reason := 'replaced',
      p_source_type := 'product_video',
      p_source_id := v_id
    );
  end if;

  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'product_cover',
    p_owner_id := v_id,
    p_role := 'cover',
    p_url := nullif(p_product->>'cover_image_url', '')
  );
  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'product_video',
    p_owner_id := v_id,
    p_role := 'video',
    p_url := nullif(p_product->>'video_url', '')
  );

  return v_id;
end;
$$;

revoke all on function public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- B. save_project_with_relations (REWRITTEN)
-- ============================================================
-- Same signature: (uuid, jsonb, jsonb, jsonb, timestamptz) -> uuid
--
-- Only behavioral change vs 20260725311000:
--   * UPDATE-by-id path now detects URL changes and enqueues
--     cleanup for the old URL (mark pending_delete + enqueue).
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
  v_row jsonb;
  v_input_id text;
  v_input_image_id uuid;
  v_existing_image_id uuid;
  v_existing_ids uuid[] := array[]::uuid[];
  v_input_ids uuid[] := array[]::uuid[];
  v_removed_ids uuid[] := array[]::uuid[];
  v_removed_url text;
  v_kept_image_id uuid;
  v_old_image_url text;
  v_i integer;
  v_old_cover_image_url text;
begin
  if p_project is null
     or btrim(p_project->>'title_cn') is null
     or btrim(p_project->>'slug') is null then
    raise exception 'project title_cn and slug are required'
      using errcode = '23502';
  end if;

  v_img := coalesce(p_images, '[]'::jsonb);

  if p_id is not null then
    select cover_image_url
      into v_old_cover_image_url
      from public.projects
      where id = p_id;

    select coalesce(array_agg(id), array[]::uuid[])
      into v_existing_ids
      from public.project_images
      where project_id = p_id;
  end if;

  if p_id is null then
    -- ============ INSERT path ============
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
      coalesce(nullif(p_project->>'sort_order', '')::int, 0),
      nullif(p_project->>'seo_title_cn', ''),
      nullif(p_project->>'seo_title_en', ''),
      nullif(p_project->>'seo_description_cn', ''),
      nullif(p_project->>'seo_description_en', '')
    )
    returning id into v_id;

    if jsonb_typeof(v_img) = 'array' then
      for i in 0 .. jsonb_array_length(v_img) - 1 loop
        v_row := v_img->i;
        v_url := v_row->>'image_url';
        insert into public.project_images (project_id, image_url, alt_cn, alt_en, sort_order)
        values (
          v_id,
          v_url,
          nullif(v_row->>'alt_cn', ''),
          nullif(v_row->>'alt_en', ''),
          coalesce(nullif(v_row->>'sort_order', '')::integer, i)
        )
        returning id into v_kept_image_id;

        perform public.register_managed_storage_ref_from_url(
          p_owner_type := 'project_image',
          p_owner_id := v_kept_image_id,
          p_role := 'image',
          p_url := v_url
        );
      end loop;
    end if;
  else
    -- ============ UPDATE path ============
    v_id := p_id;

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for project update'
        using errcode = '22004';
    end if;
    perform 1 from public.projects
      where id = v_id and updated_at = p_expected_updated_at
      for update;
    if not found then
      perform 1 from public.projects where id = v_id;
      if found then
        raise exception 'project updated by another transaction'
          using errcode = '40P01';
      end if;
      raise exception 'project not found' using errcode = 'P0002';
    end if;

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
      sort_order = coalesce(nullif(p_project->>'sort_order', '')::int, 0),
      seo_title_cn = nullif(p_project->>'seo_title_cn', ''),
      seo_title_en = nullif(p_project->>'seo_title_en', ''),
      seo_description_cn = nullif(p_project->>'seo_description_cn', ''),
      seo_description_en = nullif(p_project->>'seo_description_en', ''),
      updated_at = now()
    where id = v_id;

    if not found then
      raise exception 'project not found' using errcode = 'P0002';
    end if;

    -- ============ Image reconciliation ============
    if jsonb_typeof(v_img) = 'array' then
      for i in 0 .. jsonb_array_length(v_img) - 1 loop
        v_row := v_img->i;
        v_input_id := v_row->>'id';
        if v_input_id is not null and btrim(v_input_id) <> '' then
          v_input_ids := array_append(v_input_ids, v_input_id::uuid);
        end if;
      end loop;
    end if;

    if v_existing_ids <> array[]::uuid[] then
      foreach v_existing_image_id in array v_existing_ids loop
        if not (v_existing_image_id = any(v_input_ids)) then
          v_removed_ids := array_append(v_removed_ids, v_existing_image_id);
        end if;
      end loop;
    end if;

    -- Process removed images
    foreach v_existing_image_id in array v_removed_ids loop
      select image_url into v_removed_url
        from public.project_images
        where id = v_existing_image_id;

      perform public.mark_storage_object_refs_pending_delete(
        p_owner_type := 'project_image',
        p_owner_id := v_existing_image_id,
        p_role := 'image'
      );

      if v_removed_url is not null and btrim(v_removed_url) <> '' then
        perform public.enqueue_managed_storage_cleanup(
          p_url := v_removed_url,
          p_reason := 'replaced',
          p_source_type := 'project_image',
          p_source_id := v_id
        );
      end if;

      delete from public.project_images where id = v_existing_image_id;
    end loop;

    -- Process input images: UPDATE if id matches, INSERT otherwise
    if jsonb_typeof(v_img) = 'array' then
      for i in 0 .. jsonb_array_length(v_img) - 1 loop
        v_row := v_img->i;
        v_url := v_row->>'image_url';
        v_input_id := v_row->>'id';

        if v_input_id is not null and btrim(v_input_id) <> ''
           and (v_input_id::uuid = any(v_existing_ids)) then
          -- UPDATE existing image row.
          -- Capture OLD url BEFORE update to detect URL changes.
          select image_url into v_old_image_url
            from public.project_images
            where id = v_input_id::uuid;

          update public.project_images set
            image_url = v_url,
            alt_cn = nullif(v_row->>'alt_cn', ''),
            alt_en = nullif(v_row->>'alt_en', ''),
            sort_order = coalesce(nullif(v_row->>'sort_order', '')::integer, i)
          where id = v_input_id::uuid
          returning id into v_kept_image_id;

          -- URL change -> mark old ref pending_delete + enqueue cleanup.
          if v_old_image_url is not null
             and btrim(v_old_image_url) <> ''
             and v_old_image_url <> coalesce(v_url, '') then
            perform public.mark_storage_object_refs_pending_delete(
              p_owner_type := 'project_image',
              p_owner_id := v_kept_image_id,
              p_role := 'image'
            );
            perform public.enqueue_managed_storage_cleanup(
              p_url := v_old_image_url,
              p_reason := 'replaced',
              p_source_type := 'project_image',
              p_source_id := v_id
            );
          end if;
        else
          insert into public.project_images (project_id, image_url, alt_cn, alt_en, sort_order)
          values (
            v_id,
            v_url,
            nullif(v_row->>'alt_cn', ''),
            nullif(v_row->>'alt_en', ''),
            coalesce(nullif(v_row->>'sort_order', '')::integer, i)
          )
          returning id into v_kept_image_id;
        end if;

        perform public.register_managed_storage_ref_from_url(
          p_owner_type := 'project_image',
          p_owner_id := v_kept_image_id,
          p_role := 'image',
          p_url := v_url
        );
      end loop;
    end if;
  end if;

  -- Replace project-product relations
  delete from public.project_products where project_id = v_id;
  if jsonb_typeof(coalesce(p_products, '[]'::jsonb)) = 'array' then
    for i in 0 .. jsonb_array_length(coalesce(p_products, '[]'::jsonb)) - 1 loop
      v_link := (coalesce(p_products, '[]'::jsonb))->i;
      insert into public.project_products (project_id, product_id, sort_order)
      values (
        v_id,
        (v_link->>'product_id')::uuid,
        coalesce(nullif(v_link->>'sort_order', '')::integer, i)
      )
      on conflict (project_id, product_id) do update
        set sort_order = excluded.sort_order;
    end loop;
  end if;

  if v_old_cover_image_url is not null
     and btrim(v_old_cover_image_url) <> ''
     and v_old_cover_image_url <> coalesce(nullif(p_project->>'cover_image_url', ''), '') then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_cover_image_url,
      p_reason := 'replaced',
      p_source_type := 'project_cover_image',
      p_source_id := v_id
    );
  end if;

  perform public.register_managed_storage_ref_from_url(
    p_owner_type := 'project_cover',
    p_owner_id := v_id,
    p_role := 'cover',
    p_url := nullif(p_project->>'cover_image_url', '')
  );

  return v_id;
end;
$$;

revoke all on function public.save_project_with_relations(
  uuid, jsonb, jsonb, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.save_project_with_relations(
  uuid, jsonb, jsonb, jsonb, timestamptz
) to service_role;


-- ============================================================
-- C. Runtime assertion — verify both functions still resolve
-- ============================================================
do $$
begin
  if to_regprocedure('public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)') is null then
    raise exception 'save_product_with_images_and_audit signature broken by 20260725316000'
      using errcode = 'P0001';
  end if;
  if to_regprocedure('public.save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)') is null then
    raise exception 'save_project_with_relations signature broken by 20260725316000'
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
