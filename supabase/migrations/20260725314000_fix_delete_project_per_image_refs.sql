-- ============================================================
-- Migration 20260725314000
-- Fix delete_project_with_audit to mark per-image refs as pending_delete
-- ============================================================
-- Round-4 hardening follow-up. The per-object Registry model
-- introduced by 20260725311000 gives each project image its own
-- `storage_object_refs` row with:
--
--   owner_type = 'project_image'
--   owner_id   = project_images.id    -- per-image, NOT project.id
--   role       = 'image'
--
-- The version of `delete_project_with_audit` frozen by
-- 20260725280000 still uses the OLD contract:
--
--   perform public.mark_storage_object_refs_pending_delete(
--     p_owner_type := 'project_image',
--     p_owner_id := p_id                -- WRONG: project.id, not image.id
--   );
--
-- That call marks ZERO refs because no per-image ref has
-- owner_id = project.id. The cleanup dispatcher therefore never
-- sees a pending_delete transition for project images when a
-- project is deleted, and the per-image refs stay 'active'
-- forever — a Registry leak.
--
-- This migration rewrites `delete_project_with_audit` to:
--
--   1. Capture all `project_images.id` for the project BEFORE the
--      FK ON DELETE CASCADE wipes them.
--   2. For each image id, mark its per-image ref as pending_delete.
--   3. Enqueue cleanup for each image URL (already done by 20260725280000,
--      unchanged here).
--   4. Mark the project_cover ref as pending_delete (unchanged).
--
-- The same fix is applied to `bulk_delete_products_with_audit`:
-- the round-2 version did not mark ANY product_image refs as
-- pending_delete. With the per-object model, each product image
-- has its own ref (owner_id = product_images.id). Bulk delete now
-- iterates the doomed products' image ids and marks each ref.
--
-- Forward-only. No existing migration is modified.
-- ============================================================


-- ============================================================
-- A. delete_project_with_audit (REWRITTEN)
-- ============================================================
-- Signature unchanged: (uuid, timestamptz, uuid, text, text) -> uuid
--
-- Behavioral change: per-image refs (owner_id = project_images.id)
-- are now marked pending_delete BEFORE the parent project row is
-- deleted (which CASCADEs to project_images). The previous version
-- only marked refs with owner_id = project.id, which matched zero
-- rows under the round-4 per-object contract.
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
  v_old_image_ids uuid[] := array[]::uuid[];
  v_old_image_urls text[] := array[]::text[];
  v_image_id uuid;
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
  -- NOTE: public.projects has NO video_url column.
  select cover_image_url, title_cn
    into v_old_cover_image_url, v_title
    from public.projects
    where id = p_id
    for update;

  if not found then
    perform 1 from public.projects where id = p_id;
    if found then
      raise exception 'project updated by another transaction'
        using errcode = '40P01';
    end if;
    raise exception 'project not found' using errcode = 'P0002';
  end if;

  perform 1 from public.projects
    where id = p_id
      and updated_at = p_expected_updated_at;
  if not found then
    raise exception 'project updated by another transaction'
      using errcode = '40P01';
  end if;

  -- Capture old image ids + URLs BEFORE delete (CASCADE will wipe them).
  -- Per-image refs have owner_id = project_images.id, so we need the
  -- ids to mark each ref as pending_delete after the delete.
  select coalesce(array_agg(id), array[]::uuid[]),
         coalesce(array_agg(image_url), array[]::text[])
    into v_old_image_ids, v_old_image_urls
    from public.project_images
    where project_id = p_id;

  -- Delete the project. FK ON DELETE CASCADE removes project_images
  -- and project_products atomically.
  delete from public.projects where id = p_id;

  -- Mark per-image refs as pending_delete. Each image had its own ref
  -- (owner_id = project_images.id). The CASCADE delete above removed
  -- the project_images rows but the storage_object_refs rows still
  -- exist with status='active' — they must transition to pending_delete
  -- so the cleanup dispatcher can claim them.
  foreach v_image_id in array v_old_image_ids
  loop
    perform public.mark_storage_object_refs_pending_delete(
      p_owner_type := 'project_image',
      p_owner_id := v_image_id,
      p_role := 'image'
    );
  end loop;

  -- Enqueue cleanup for each removed image URL.
  -- enqueue_managed_storage_cleanup (round-4 strict version) returns
  -- NULL for external URLs, so external images are skipped.
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

  -- Mark the project_cover ref as pending_delete.
  perform public.mark_storage_object_refs_pending_delete(
    p_owner_type := 'project_cover',
    p_owner_id := p_id
  );

  if v_old_cover_image_url is not null
     and btrim(v_old_cover_image_url) <> '' then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_cover_image_url,
      p_reason := 'row_deleted',
      p_source_type := 'project_cover_image',
      p_source_id := p_id
    );
  end if;

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
-- B. bulk_delete_products_with_audit (REWRITTEN)
-- ============================================================
-- Signature unchanged: (uuid[], uuid, text, text) -> integer
--
-- Behavioral change: for each doomed product, capture its image ids
-- BEFORE delete and mark each per-image ref as pending_delete after
-- delete. Also enqueue cleanup for each image URL and the cover URL.
-- The round-2 version did not handle image refs at all.
-- ============================================================
create or replace function public.bulk_delete_products_with_audit(
  p_ids uuid[],
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_deleted_this_iter integer;
  v_id_list text;
  v_product_id uuid;
  v_image_id uuid;
  v_image_ids uuid[];
  v_image_urls text[];
  v_url text;
  v_cover_url text;
  v_video_url text;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    raise exception 'ids required' using errcode = '23502';
  end if;
  if array_length(p_ids, 1) > 500 then
    raise exception 'too many ids' using errcode = '22023';
  end if;

  -- For each doomed product, capture image ids + urls + cover + video
  -- BEFORE delete. The per-image refs use owner_id = product_images.id,
  -- so we need the ids to mark each ref as pending_delete.
  foreach v_product_id in array p_ids
  loop
    select coalesce(array_agg(id), array[]::uuid[]),
           coalesce(array_agg(image_url), array[]::text[])
      into v_image_ids, v_image_urls
      from public.product_images
      where product_id = v_product_id;

    select cover_image_url, video_url
      into v_cover_url, v_video_url
      from public.products
      where id = v_product_id;

    -- Delete the product. FK ON DELETE CASCADE removes product_images.
    delete from public.products where id = v_product_id;
    get diagnostics v_deleted_this_iter = row_count;
    v_count := v_count + v_deleted_this_iter;

    -- If the row didn't exist, skip ref/cleanup work for this id.
    if v_deleted_this_iter = 0 then
      continue;
    end if;

    -- Mark per-image refs as pending_delete.
    foreach v_image_id in array v_image_ids
    loop
      perform public.mark_storage_object_refs_pending_delete(
        p_owner_type := 'product_image',
        p_owner_id := v_image_id,
        p_role := 'image'
      );
    end loop;

    -- Enqueue cleanup for each image URL.
    foreach v_url in array v_image_urls
    loop
      if v_url is null or btrim(v_url) = '' then
        continue;
      end if;
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_url,
        p_reason := 'row_deleted',
        p_source_type := 'product_image',
        p_source_id := v_product_id
      );
    end loop;

    -- Mark cover + video refs as pending_delete.
    perform public.mark_storage_object_refs_pending_delete(
      p_owner_type := 'product_cover',
      p_owner_id := v_product_id
    );
    perform public.mark_storage_object_refs_pending_delete(
      p_owner_type := 'product_video',
      p_owner_id := v_product_id
    );

    if v_cover_url is not null and btrim(v_cover_url) <> '' then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_cover_url,
        p_reason := 'row_deleted',
        p_source_type := 'product_cover_image',
        p_source_id := v_product_id
      );
    end if;
    if v_video_url is not null and btrim(v_video_url) <> '' then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_video_url,
        p_reason := 'row_deleted',
        p_source_type := 'product_video',
        p_source_id := v_product_id
      );
    end if;
  end loop;

  select array_to_string(p_ids, ',') into v_id_list;
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id, p_actor_email, p_actor_role, 'product.delete', 'product', v_id_list,
    'Deleted ' || v_count || ' product(s)'
  );

  return v_count;
end;
$$;

revoke all on function public.bulk_delete_products_with_audit(uuid[], uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.bulk_delete_products_with_audit(uuid[], uuid, text, text)
  to service_role;


-- ============================================================
-- C. Runtime assertion — both functions still resolve
-- ============================================================
do $$
begin
  if to_regprocedure('public.delete_project_with_audit(uuid, timestamptz, uuid, text, text)') is null then
    raise exception 'delete_project_with_audit signature broken by 20260725314000'
      using errcode = 'P0001';
  end if;
  if to_regprocedure('public.bulk_delete_products_with_audit(uuid[], uuid, text, text)') is null then
    raise exception 'bulk_delete_products_with_audit signature broken by 20260725314000'
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
