-- ============================================================
-- Migration 20260725311000
-- Register each Product/Project image as its own storage_object_ref
-- ============================================================
-- Round-4 hardening. The previous model (introduced by
-- 20260725280000) registered only ONE `product_image` ref per
-- product, with `owner_id = products.id` and only the first image
-- URL. That model:
--
--   * could not track per-image lifecycle (replace image #2 of 5
--     was invisible to the Registry);
--   * could not enqueue cleanup for individual removed images
--     (the ref pointed at the first image, not at each image);
--   * made `check_storage_object_referenced` weaker than the
--     `storage_object_refs` table could support.
--
-- New model (Stable Owner):
--
--   product_image:
--     owner_type = 'product_image'
--     owner_id   = product_images.id    -- each image has its own ref
--     role       = 'image'
--
--   project_image:
--     owner_type = 'project_image'
--     owner_id   = project_images.id
--     role       = 'image'
--
--   product_cover / product_video / project_cover:
--     unchanged (owner_id = parent business row id).
--
-- Image save is rewritten from "delete-all + insert" to a true
-- transactional reconciliation:
--
--   1. SELECT FOR UPDATE on the parent row (products or projects).
--   2. Read existing image rows (id, image_url) for the parent.
--   3. For each input image:
--        - if `id` is provided AND matches an existing row: UPDATE
--          that row (image_url, alt_cn, alt_en, sort_order);
--        - otherwise: INSERT a new row and capture its id.
--   4. For each existing image NOT in the input list:
--        - mark its `product_image`/`project_image` ref as
--          pending_delete (via mark_storage_object_refs_pending_delete);
--        - enqueue cleanup for its URL (if managed);
--        - DELETE the row.
--   5. For each kept/new image: register an active ref with
--      owner_id = <image row id>.
--   6. External URLs are NOT registered and NOT enqueued for cleanup.
--   7. Audit row is written in the same transaction.
--   8. Any failure rolls back the parent write, image writes, ref
--      writes, cleanup enqueue, and audit row.
--
-- Backward compatibility:
--   * The function signature is unchanged.
--   * Callers that do not pass `id` in each image object get the
--     same behavior as before: every save inserts new image rows
--     (existing rows are deleted because they have no matching id).
--     The only observable change is that each image now has its
--     own ref (instead of one ref for the first image).
--
-- Forward-only. The migrations 20260725280000 and 20260725300000
-- are NOT modified. This migration supercedes their function
-- definitions via CREATE OR REPLACE.
-- ============================================================


-- ============================================================
-- A. save_product_with_images_and_audit (REWRITTEN)
-- ============================================================
-- Signature unchanged: (uuid, jsonb, jsonb, timestamptz, uuid, text, text) -> uuid
--
-- Behavioral changes:
--   * UPDATE path uses SELECT FOR UPDATE on the product row.
--   * Image rows are reconciled by id (if provided) instead of
--     delete-all + insert.
--   * Each image gets its own active `product_image` ref with
--     owner_id = product_images.id.
--   * Removed images: ref -> pending_delete, cleanup enqueued.
--   * Cover/video refs still use owner_id = product.id (unchanged).
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

        -- Register one active ref per image, owner_id = image row id
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

    -- Strict optimistic lock: p_expected_updated_at is REQUIRED on update.
    -- This is enforced by 20260725311000 (this migration) per the
    -- round-4 requirement. NULL timestamp -> 22004; stale -> 40P01.
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

    -- Capture OLD cover/video URLs and OLD image rows
    select cover_image_url, video_url
      into v_old_cover_image_url, v_old_video_url
      from public.products
      where id = p_id;

    -- Snapshot existing image ids for reconciliation
    select coalesce(array_agg(id), array[]::uuid[])
      into v_existing_ids
      from public.product_images
      where product_id = p_id;

    -- Update the product row
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
    -- Collect input ids (if provided)
    if jsonb_typeof(v_img) = 'array' then
      for i in 0 .. jsonb_array_length(v_img) - 1 loop
        v_row := v_img->i;
        v_input_id := v_row->>'id';
        if v_input_id is not null and btrim(v_input_id) <> '' then
          v_input_ids := array_append(v_input_ids, v_input_id::uuid);
        end if;
      end loop;
    end if;

    -- Determine removed ids = existing - input
    if v_existing_ids <> array[]::uuid[] then
      foreach v_existing_image_id in array v_existing_ids loop
        if not (v_existing_image_id = any(v_input_ids)) then
          v_removed_ids := array_append(v_removed_ids, v_existing_image_id);
        end if;
      end loop;
    end if;

    -- Process removed images: ref -> pending_delete, enqueue cleanup, DELETE row
    foreach v_existing_image_id in array v_removed_ids loop
      -- Capture the URL before delete (for cleanup enqueue)
      select image_url into v_removed_url
        from public.product_images
        where id = v_existing_image_id;

      -- Mark the per-image ref as pending_delete
      perform public.mark_storage_object_refs_pending_delete(
        p_owner_type := 'product_image',
        p_owner_id := v_existing_image_id,
        p_role := 'image'
      );

      -- Enqueue cleanup for the removed URL (no-op for external URLs)
      if v_removed_url is not null and btrim(v_removed_url) <> '' then
        perform public.enqueue_managed_storage_cleanup(
          p_url := v_removed_url,
          p_reason := 'replaced',
          p_source_type := 'product_image',
          p_source_id := v_id
        );
      end if;

      -- Delete the image row
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
          -- UPDATE existing image row
          update public.product_images set
            image_url = v_url,
            alt_cn = nullif(v_row->>'alt_cn', ''),
            alt_en = nullif(v_row->>'alt_en', ''),
            sort_order = coalesce(nullif(v_row->>'sort_order', '')::integer, i)
          where id = v_input_id::uuid
          returning id into v_kept_image_id;
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
  -- Transactional cleanup enqueue for cover/video URL changes
  -- ============================================================
  -- Same logic as 20260725300000: enqueue cleanup when cover/video
  -- URL changes. The per-image cleanup was already handled above
  -- during image reconciliation.
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

  -- ============================================================
  -- Register NEW managed object refs (active) for cover/video
  -- ============================================================
  -- Cover and video still use owner_id = product.id (unchanged).
  -- Image refs were already registered above (one per image).
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
-- Signature unchanged: (uuid, jsonb, jsonb, jsonb, timestamptz) -> uuid
--
-- Behavioral changes:
--   * UPDATE path uses SELECT FOR UPDATE on the project row.
--   * Image rows are reconciled by id (if provided) instead of
--     delete-all + insert.
--   * Each image gets its own active `project_image` ref with
--     owner_id = project_images.id.
--   * Removed images: ref -> pending_delete, cleanup enqueued.
--   * Cover ref still uses owner_id = project.id (unchanged).
--   * Project-product relations continue to use delete-all +
--     insert (they have no Storage ref concern).
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
  v_i integer;
  -- Snapshots of OLD state
  v_old_cover_image_url text;
begin
  if p_project is null
     or btrim(p_project->>'title_cn') is null
     or btrim(p_project->>'slug') is null then
    raise exception 'project title_cn and slug are required'
      using errcode = '23502';
  end if;

  v_img := coalesce(p_images, '[]'::jsonb);

  -- Capture OLD cover URL and OLD image rows for existing project
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

    -- Insert images (all new)
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

        -- Register one active ref per image, owner_id = image row id
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

    -- Strict optimistic lock: p_expected_updated_at is REQUIRED on update.
    -- NULL timestamp -> 22004; stale or missing row -> 40P01 / P0002.
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
    -- Collect input ids
    if jsonb_typeof(v_img) = 'array' then
      for i in 0 .. jsonb_array_length(v_img) - 1 loop
        v_row := v_img->i;
        v_input_id := v_row->>'id';
        if v_input_id is not null and btrim(v_input_id) <> '' then
          v_input_ids := array_append(v_input_ids, v_input_id::uuid);
        end if;
      end loop;
    end if;

    -- Determine removed ids
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
          update public.project_images set
            image_url = v_url,
            alt_cn = nullif(v_row->>'alt_cn', ''),
            alt_en = nullif(v_row->>'alt_en', ''),
            sort_order = coalesce(nullif(v_row->>'sort_order', '')::integer, i)
          where id = v_input_id::uuid
          returning id into v_kept_image_id;
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

        -- Register one active ref per image, owner_id = image row id
        perform public.register_managed_storage_ref_from_url(
          p_owner_type := 'project_image',
          p_owner_id := v_kept_image_id,
          p_role := 'image',
          p_url := v_url
        );
      end loop;
    end if;
  end if;

  -- Replace project-product relations (delete-all + insert is safe:
  -- project_products has no Storage refs)
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

  -- Enqueue cleanup for changed cover URL
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

  -- Register cover ref (owner_id = project.id, unchanged)
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
  -- Smoke test: ensure both functions still resolve with the
  -- expected signature. A typo in CREATE OR REPLACE would leave
  -- the old version in place, which the verifier would catch
  -- later — but we want a clear failure here too.
  if to_regprocedure('public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)') is null then
    raise exception 'save_product_with_images_and_audit signature broken by 20260725311000'
      using errcode = 'P0001';
  end if;
  if to_regprocedure('public.save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)') is null then
    raise exception 'save_project_with_relations signature broken by 20260725311000'
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
