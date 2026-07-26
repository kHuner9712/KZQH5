-- ============================================================
-- Phase 15 (Section 7): Project transactional audit RPCs
-- -------------------------------------------------------------
-- This migration ADDS two new forward-only RPCs:
--   1. save_project_with_relations_and_audit
--   2. delete_project_with_audit
--
-- Why:
--   The existing save_project_with_relations handles optimistic lock,
--   images replace, product relations replace, and storage cleanup
--   enqueue in a single transaction — but does NOT write audit.
--   The admin UI was also calling repository functions directly from
--   the browser Supabase client, bypassing the trusted server boundary.
--
-- What this migration does:
--   * Defines save_project_with_relations_and_audit as a thin wrapper
--     around save_project_with_relations + an atomic admin_audit_log
--     insert in the SAME transaction. Any failure rolls back both the
--     business write and the audit row.
--   * Defines delete_project_with_audit to atomically:
--       - capture old image URLs / cover / video for cleanup enqueue
--       - delete the project row (CASCADE removes project_images,
--         project_products)
--       - enqueue removed managed Storage URLs into
--         storage_cleanup_queue (reason = 'row_deleted')
--       - write admin_audit_log (action = 'project.delete')
--     Any failure rolls back the delete, the cleanup enqueue, and the
--     audit row.
--
-- Safety contract (per RPC):
--   * language plpgsql
--   * security invoker   -> runs with caller privileges (service_role)
--   * set search_path = '' -> all tables qualified as public.<table>
--   * revoke from public/anon/authenticated
--   * grant execute to service_role only
--   * no exception handlers that swallow errors (no best-effort audit)
--   * audit insert is in the same transaction; failure rolls back the
--     business write
--
-- Forward-only: this migration only ADDS functions. It does not modify
-- existing tables, policies, or data.
-- This migration is NOT executed in this commit.
-- ============================================================

-- ============================================================
-- A. save_project_with_relations_and_audit
-- ============================================================
-- Wraps save_project_with_relations + audit insert in one transaction.
-- Returns the project id (uuid).
--
-- Parameters mirror save_project_with_relations plus actor fields.
-- On INSERT: action = 'project.create'.
-- On UPDATE: action = 'project.update'.
-- Audit failure (e.g. NOT NULL violation) rolls back the project save.
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
-- B. delete_project_with_audit
-- ============================================================
-- Atomically:
--   1. Capture old image URLs / cover_image_url / video_url
--   2. Delete the project (CASCADE removes project_images,
--      project_products via FK ON DELETE CASCADE)
--   3. Enqueue each removed managed Storage URL into
--      storage_cleanup_queue (reason = 'row_deleted')
--   4. Insert admin_audit_log (action = 'project.delete')
--
-- All four steps run in the SAME transaction. Any failure rolls back
-- the delete, the cleanup enqueue, and the audit row.
--
-- Parameters:
--   p_id                   : project id to delete (required)
--   p_expected_updated_at  : optimistic lock (required)
--   p_actor_id / email / role
-- Returns: the deleted project id (uuid).
-- Raises:
--   22004 / P0002 when id missing / project not found
--   40P01 when updated_at mismatch (stale version)
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
  v_old_video_url text;
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
  select cover_image_url, video_url, title_cn
    into v_old_cover_image_url, v_old_video_url, v_title
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

  if v_old_video_url is not null
     and btrim(v_old_video_url) <> '' then
    perform public.enqueue_managed_storage_cleanup(
      p_url := v_old_video_url,
      p_reason := 'row_deleted',
      p_source_type := 'project_video',
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
-- C. Update verify_required_schema to include delete_project_with_audit
-- ============================================================
-- save_project_with_relations_and_audit is already in the verification
-- list (added by 20260725190000). delete_project_with_audit is new.
-- We replace the function with a version that includes both.
-- ============================================================
drop function if exists public.verify_required_schema();

create function public.verify_required_schema()
returns table(object_name text, object_type text)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Tables
  return query select 'admin_profiles', 'table'::text;
  return query select 'admin_audit_log', 'table'::text;
  return query select 'storage_cleanup_queue', 'table'::text;
  return query select 'storage_object_refs', 'table'::text;
  return query select 'storage_audit_reconcile_queue', 'table'::text;
  return query select 'admin_storage_operations', 'table'::text;
  return query select 'product_assets', 'table'::text;
  return query select 'certificates', 'table'::text;

  -- Product asset columns (Catalog)
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

  -- Certificate columns
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

  -- Transactional business RPCs
  return query select 'save_product_with_images_and_audit', 'function'::text;
  return query select 'bulk_update_products_with_audit', 'function'::text;
  return query select 'bulk_delete_products_with_audit', 'function'::text;
  return query select 'save_project_with_relations', 'function'::text;
  return query select 'save_project_with_relations_and_audit', 'function'::text;
  return query select 'delete_project_with_audit', 'function'::text;

  -- Storage cleanup + audit
  return query select 'enqueue_managed_storage_cleanup', 'function'::text;
  return query select 'extract_managed_storage_path', 'function'::text;
  return query select 'check_storage_object_referenced', 'function'::text;
  return query select 'complete_storage_cleanup', 'function'::text;
  return query select 'record_storage_operation_started', 'function'::text;
  return query select 'complete_storage_operation', 'function'::text;
  return query select 'claim_storage_audit_reconcile', 'function'::text;
  return query select 'complete_storage_audit_reconcile', 'function'::text;

  -- Catalog publish RPCs
  return query select 'claim_catalog_asset_publish', 'function'::text;
  return query select 'finalize_catalog_asset_publish', 'function'::text;
  return query select 'recover_stale_catalog_publish', 'function'::text;
  return query select 'authorize_product_asset', 'function'::text;
  return query select 'save_product_asset_draft', 'function'::text;
  return query select 'update_product_asset_metadata', 'function'::text;
  return query select 'delete_product_asset_with_cleanup', 'function'::text;
  return query select 'unpublish_catalog_asset', 'function'::text;

  -- Certificate publish RPCs
  return query select 'save_certificate_draft', 'function'::text;
  return query select 'update_certificate_metadata', 'function'::text;
  return query select 'authorize_certificate', 'function'::text;
  return query select 'claim_certificate_publish', 'function'::text;
  return query select 'finalize_certificate_publish', 'function'::text;
  return query select 'unpublish_certificate', 'function'::text;
  return query select 'delete_certificate_with_cleanup', 'function'::text;
  return query select 'recover_stale_certificate_publish', 'function'::text;
end;
$$;

revoke all on function public.verify_required_schema()
  from public, anon, authenticated;
grant execute on function public.verify_required_schema()
  to service_role;
