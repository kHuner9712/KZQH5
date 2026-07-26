-- ============================================================
-- Phase 17: Wire storage_object_refs into the asset lifecycle.
--
-- Prior state (phantom registry):
--   * storage_object_refs table was created by 20260725170000 with a
--     full schema (owner_type / owner_id / role / bucket / object_path
--     / visibility / status / mime_type / size_bytes / sha256), a
--     unique partial index on (owner_type, owner_id, role) WHERE
--     status='active', and RLS enabled with service_role-only access.
--   * But NO migration ever performed INSERT/UPDATE/DELETE on it. The
--     table was a ghost registry: every draft/publish/replace/unpublish
--     /delete RPC wrote structured storage refs into business-table
--     columns (product_assets.source_bucket, .published_bucket,
--     certificates.source_bucket, .published_bucket) and enqueued
--     cleanup via storage_cleanup_queue, but never registered a single
--     row in storage_object_refs.
--
-- This migration wires the registry into the catalog asset lifecycle
-- so it is no longer a phantom. It is forward-only and additive:
--   * Two new helper RPCs register / mark-deleted refs atomically.
--   * Eight existing RPCs are CREATE OR REPLACE'd with the SAME
--     signatures, adding registry maintenance in the same transaction
--     (so any registry failure rolls back the business write too).
--   * complete_storage_cleanup is CREATE OR REPLACE'd (same 6-arg
--     signature frozen by 20260725240000) to mark matching active
--     refs as 'deleted' when a storage object is successfully removed.
--
-- Scope of wiring in this migration:
--   * save_product_asset_draft       -> register 'source' ref
--   * finalize_catalog_asset_publish -> register 'published' ref,
--                                        supersede 'source' ref
--   * unpublish_catalog_asset        -> mark 'published' ref deleted
--   * delete_product_asset_with_cleanup -> mark all refs deleted
--   * save_certificate_draft         -> register 'source' ref
--   * finalize_certificate_publish   -> register 'published' ref,
--                                        supersede 'source' ref
--   * unpublish_certificate          -> mark 'published' ref deleted
--   * delete_certificate_with_cleanup -> mark all refs deleted
--   * complete_storage_cleanup       -> mark matching active refs
--                                        deleted on success
--
-- Image replace RPCs (save_product_with_images_and_audit,
-- save_project_with_relations_and_audit, save_company_profile_with_audit,
-- save_site_settings_with_audit, save_homepage_content_with_audit) are
-- NOT wired in this migration. They take URL strings (not structured
-- bucket+path refs), and wiring them requires URL->path extraction at
-- write time. The catalog lifecycle above is the primary draft/replace/
-- publish/cleanup flow and is fully wired. Image replace wiring is
-- tracked as a follow-up; until it lands the PR description MUST NOT
-- claim storage_object_refs is the "only new write model".
--
-- Safety contract (per function):
--   * language plpgsql
--   * security invoker   -> runs with caller privileges (service_role)
--   * set search_path = '' -> all tables qualified as public.<table>
--   * revoke from public/anon/authenticated
--   * grant execute to service_role only
-- ============================================================


-- ============================================================
-- A. Helper: register_storage_object_ref
-- ============================================================
-- Atomically:
--   1. Marks any existing 'active' ref for (owner_type, owner_id, role)
--      as 'superseded' (preserves history; the unique partial index
--      requires at most one active row per triple).
--   2. Inserts a new 'active' ref with the given bucket/path/metadata.
--
-- Returns the new ref id. The caller's transaction wraps both steps,
-- so a failure in either rolls back the whole business write.
--
-- Visibility defaults to 'private' (drafts) and is set to 'public' by
-- the finalize_* RPCs when they register the 'published' ref.
-- ============================================================
create or replace function public.register_storage_object_ref(
  p_owner_type text,
  p_owner_id uuid,
  p_role text,
  p_bucket text,
  p_object_path text,
  p_visibility text default 'private',
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
  v_id uuid;
begin
  if p_owner_type is null or p_owner_id is null or p_role is null
     or p_bucket is null or p_object_path is null then
    raise exception 'register_storage_object_ref: required arg is null'
      using errcode = '22004';
  end if;
  if p_bucket not in ('public-assets', 'private-assets') then
    raise exception 'register_storage_object_ref: invalid bucket %', p_bucket
      using errcode = '22004';
  end if;
  if p_visibility not in ('public', 'private', 'external') then
    raise exception 'register_storage_object_ref: invalid visibility %', p_visibility
      using errcode = '22004';
  end if;
  if btrim(p_object_path) = '' then
    raise exception 'register_storage_object_ref: empty object_path'
      using errcode = '22004';
  end if;

  -- Supersede any existing active ref for this (owner_type, owner_id, role).
  -- The unique partial index storage_object_refs_owner_role_active_uniq
  -- would otherwise reject the INSERT below.
  update public.storage_object_refs
    set status = 'superseded', updated_at = now()
    where owner_type = p_owner_type
      and owner_id = p_owner_id
      and role = p_role
      and status = 'active';

  insert into public.storage_object_refs (
    owner_type, owner_id, role, bucket, object_path,
    visibility, status, mime_type, size_bytes, sha256
  ) values (
    p_owner_type, p_owner_id, p_role, p_bucket, p_object_path,
    p_visibility, 'active', p_mime_type, p_size_bytes, p_sha256
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_storage_object_ref(text, uuid, text, text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.register_storage_object_ref(text, uuid, text, text, text, text, text, bigint, text)
  to service_role;


-- ============================================================
-- B. Helper: mark_storage_object_refs_deleted
-- ============================================================
-- Marks all 'active' refs for a given (owner_type, owner_id) [and
-- optional role] as 'deleted'. Used by unpublish_* (role='published')
-- and delete_*_with_cleanup (all roles).
--
-- Returns the number of refs transitioned to 'deleted'.
-- ============================================================
create or replace function public.mark_storage_object_refs_deleted(
  p_owner_type text,
  p_owner_id uuid,
  p_role text default null
) returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if p_owner_type is null or p_owner_id is null then
    raise exception 'mark_storage_object_refs_deleted: required arg is null'
      using errcode = '22004';
  end if;

  if p_role is not null then
    update public.storage_object_refs
      set status = 'deleted', updated_at = now()
      where owner_type = p_owner_type
        and owner_id = p_owner_id
        and role = p_role
        and status = 'active';
  else
    update public.storage_object_refs
      set status = 'deleted', updated_at = now()
      where owner_type = p_owner_type
        and owner_id = p_owner_id
        and status = 'active';
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_storage_object_refs_deleted(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_storage_object_refs_deleted(text, uuid, text)
  to service_role;


-- ============================================================
-- C. save_product_asset_draft — register 'source' ref
-- ============================================================
-- Replaces the version in 20260725190000. Signature is unchanged:
--   (uuid, jsonb, text, text, text, bigint, text, timestamptz,
--    uuid, text, text) returns jsonb
--
-- NEW behavior: after inserting/updating the product_assets row, calls
-- register_storage_object_ref with owner_type='product_asset',
-- role='source', bucket='private-assets', object_path=p_source_object_path.
-- On UPDATE with a new source path, the helper atomically marks the
-- old active 'source' ref as 'superseded' before inserting the new one.
--
-- The registry write runs in the same transaction as the business
-- write + audit. Any failure rolls back everything.
-- ============================================================
create or replace function public.save_product_asset_draft(
  p_id uuid,
  p_payload jsonb,
  p_source_bucket text,
  p_source_object_path text,
  p_mime_type text default null,
  p_file_size bigint default null,
  p_sha256 text default null,
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
  v_existing public.product_assets%rowtype;
  v_id uuid;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_product_id text;
  v_asset_type text;
  v_catalog_topic_id text;
  v_title_cn text;
  v_title_en text;
  v_description_cn text;
  v_description_en text;
  v_cover_image_url text;
  v_published_at text;
  v_content_hash text;
  v_sort_order integer;
  v_is_published boolean;
  v_access_level text;
  v_source_type text;
  v_authorization_status text;
  v_ref_id uuid;
begin
  v_product_id := v_payload->>'product_id';
  v_asset_type := v_payload->>'asset_type';
  v_catalog_topic_id := v_payload->>'catalog_topic_id';
  v_title_cn := v_payload->>'title_cn';
  v_title_en := v_payload->>'title_en';
  v_description_cn := v_payload->>'description_cn';
  v_description_en := v_payload->>'description_en';
  v_cover_image_url := v_payload->>'cover_image_url';
  v_published_at := v_payload->>'published_at';
  v_content_hash := v_payload->>'content_hash';
  v_sort_order := coalesce((v_payload->>'sort_order')::integer, 0);
  v_is_published := coalesce((v_payload->>'is_published')::boolean, false);
  v_access_level := coalesce(v_payload->>'access_level', 'private');
  v_source_type := v_payload->>'source_type';
  v_authorization_status := coalesce(v_payload->>'authorization_status', 'pending');

  if p_source_bucket is null or p_source_bucket <> 'private-assets' then
    raise exception 'source_bucket must be private-assets for draft'
      using errcode = '22004';
  end if;
  if p_source_object_path is null or btrim(p_source_object_path) = '' then
    raise exception 'source_object_path is required for draft'
      using errcode = '22004';
  end if;

  if p_id is not null then
    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required on update'
        using errcode = '22004';
    end if;

    select * into v_existing
      from public.product_assets
      where id = p_id
      for update;

    if not found then
      raise exception 'asset not found' using errcode = 'P0002';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    if v_existing.publish_status in ('publishing', 'published') then
      raise exception 'cannot save draft over a publishing/published asset'
        using errcode = '22004';
    end if;

    update public.product_assets set
      product_id = nullif(v_product_id, '')::uuid,
      asset_type = v_asset_type,
      catalog_topic_id = nullif(v_catalog_topic_id, ''),
      title_cn = v_title_cn,
      title_en = nullif(v_title_en, ''),
      description_cn = nullif(v_description_cn, ''),
      description_en = nullif(v_description_en, ''),
      cover_image_url = nullif(v_cover_image_url, ''),
      published_at = nullif(v_published_at, '')::date,
      content_hash = nullif(v_content_hash, ''),
      sort_order = v_sort_order,
      is_published = v_is_published,
      access_level = v_access_level,
      source_type = nullif(v_source_type, ''),
      authorization_status = v_authorization_status,
      source_bucket = p_source_bucket,
      source_object_path = p_source_object_path,
      mime_type = p_mime_type,
      file_size = p_file_size,
      content_hash = v_content_hash,
      publish_status = 'draft',
      publish_error_code = null
    where id = p_id;

    -- Register the new 'source' ref. The helper atomically marks the
    -- previous active 'source' ref as 'superseded' before inserting.
    v_ref_id := public.register_storage_object_ref(
      p_owner_type := 'product_asset',
      p_owner_id := p_id,
      p_role := 'source',
      p_bucket := p_source_bucket,
      p_object_path := p_source_object_path,
      p_visibility := 'private',
      p_mime_type := p_mime_type,
      p_size_bytes := p_file_size,
      p_sha256 := p_sha256
    );

    insert into public.admin_audit_log (
      actor_id, actor_email, actor_role, action, target_type, target_id,
      metadata
    ) values (
      p_actor_id, p_actor_email, p_actor_role,
      'catalog_asset.draft_save',
      'product_asset', p_id,
      jsonb_build_object(
        'source_bucket', p_source_bucket,
        'source_object_path', p_source_object_path,
        'storage_object_ref_id', v_ref_id
      )
    );

    return jsonb_build_object(
      'status', 'updated',
      'id', p_id,
      'storage_object_ref_id', v_ref_id,
      'updated_at', (select updated_at from public.product_assets where id = p_id)
    );
  end if;

  -- INSERT path.
  insert into public.product_assets (
    product_id, asset_type, catalog_topic_id,
    title_cn, title_en, description_cn, description_en,
    file_url, cover_image_url, file_size, mime_type,
    is_published, sort_order, published_at, content_hash,
    access_level, source_type, authorization_status,
    source_bucket, source_object_path,
    publish_status
  ) values (
    nullif(v_product_id, '')::uuid,
    v_asset_type,
    nullif(v_catalog_topic_id, ''),
    v_title_cn,
    nullif(v_title_en, ''),
    nullif(v_description_cn, ''),
    nullif(v_description_en, ''),
    null,
    nullif(v_cover_image_url, ''),
    p_file_size,
    p_mime_type,
    v_is_published,
    v_sort_order,
    nullif(v_published_at, '')::date,
    nullif(v_content_hash, ''),
    v_access_level,
    nullif(v_source_type, ''),
    v_authorization_status,
    p_source_bucket,
    p_source_object_path,
    'draft'
  )
  returning id into v_id;

  v_ref_id := public.register_storage_object_ref(
    p_owner_type := 'product_asset',
    p_owner_id := v_id,
    p_role := 'source',
    p_bucket := p_source_bucket,
    p_object_path := p_source_object_path,
    p_visibility := 'private',
    p_mime_type := p_mime_type,
    p_size_bytes := p_file_size,
    p_sha256 := p_sha256
  );

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'catalog_asset.draft_create',
    'product_asset', v_id,
    jsonb_build_object(
      'source_bucket', p_source_bucket,
      'source_object_path', p_source_object_path,
      'storage_object_ref_id', v_ref_id
    )
  );

  return jsonb_build_object(
    'status', 'created',
    'id', v_id,
    'storage_object_ref_id', v_ref_id,
    'updated_at', (select updated_at from public.product_assets where id = v_id)
  );
end;
$$;

revoke all on function public.save_product_asset_draft(uuid, jsonb, text, text, text, bigint, text, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_product_asset_draft(uuid, jsonb, text, text, text, bigint, text, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- D. finalize_catalog_asset_publish — register 'published' ref,
--    supersede 'source' ref
-- ============================================================
-- Replaces the version in 20260725190000. Signature unchanged:
--   (uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
--   returns jsonb
--
-- NEW behavior:
--   1. Registers 'published' ref: bucket='public-assets',
--      visibility='public', object_path=p_public_object_path.
--      The helper atomically supersedes any prior active 'published'
--      ref for this asset.
--   2. Marks the 'source' ref as 'superseded' (the private draft is
--      no longer the active source once published).
--   3. Enqueue old private source for cleanup (existing behavior).
--   4. Atomic audit row.
-- ============================================================
create or replace function public.finalize_catalog_asset_publish(
  p_asset_id uuid,
  p_publish_token uuid,
  p_public_bucket text,
  p_public_object_path text,
  p_public_url text,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_sha256 text default null,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.product_assets%rowtype;
  v_cleanup_id uuid;
  v_result jsonb;
  v_old_source_path text;
  v_published_ref_id uuid;
begin
  if p_asset_id is null or p_publish_token is null then
    raise exception 'asset_id and publish_token are required'
      using errcode = '22004';
  end if;
  if p_public_bucket is null or p_public_bucket <> 'public-assets' then
    raise exception 'public_bucket must be public-assets'
      using errcode = '22004';
  end if;
  if p_public_object_path is null or btrim(p_public_object_path) = '' then
    raise exception 'public_object_path is required' using errcode = '22004';
  end if;
  if p_public_url is null or btrim(p_public_url) = '' then
    raise exception 'public_url is required' using errcode = '22004';
  end if;

  select * into v_row
    from public.product_assets
    where id = p_asset_id
    for update;

  if not found then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  if v_row.publish_status <> 'publishing' then
    raise exception 'asset is not in publishing state'
      using errcode = '40P01';
  end if;
  if v_row.publish_token is null or v_row.publish_token <> p_publish_token then
    raise exception 'publish_token mismatch' using errcode = '40P01';
  end if;

  v_old_source_path := v_row.source_object_path;

  update public.product_assets set
    published_bucket = p_public_bucket,
    published_object_path = p_public_object_path,
    file_url = p_public_url,
    publish_status = 'published',
    publish_token = null,
    publish_started_at = null,
    publish_error_code = null,
    candidate_public_bucket = p_public_bucket,
    candidate_public_path = p_public_object_path,
    candidate_sha256 = p_sha256,
    last_publish_error_code = null,
    mime_type = coalesce(p_mime_type, mime_type)
  where id = v_row.id;

  -- Register the new 'published' ref (atomically supersedes any prior
  -- active 'published' ref for this asset).
  v_published_ref_id := public.register_storage_object_ref(
    p_owner_type := 'product_asset',
    p_owner_id := v_row.id,
    p_role := 'published',
    p_bucket := p_public_bucket,
    p_object_path := p_public_object_path,
    p_visibility := 'public',
    p_mime_type := p_mime_type,
    p_size_bytes := p_size_bytes,
    p_sha256 := p_sha256
  );

  -- Mark the 'source' ref as 'superseded' (the private draft is no
  -- longer the active source once the asset is published).
  update public.storage_object_refs
    set status = 'superseded', updated_at = now()
    where owner_type = 'product_asset'
      and owner_id = v_row.id
      and role = 'source'
      and status = 'active';

  -- Enqueue old private source for cleanup. Any failure here aborts
  -- the whole transaction (rolling back the UPDATE + registry writes).
  if v_old_source_path is not null and v_row.source_bucket = 'private-assets' then
    v_cleanup_id := public.enqueue_storage_cleanup(
      p_bucket := 'private-assets',
      p_object_path := v_old_source_path,
      p_reason := 'replaced',
      p_source_type := 'catalog_asset',
      p_source_id := v_row.id
    );
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'catalog_asset.publish',
    'product_asset', v_row.id,
    jsonb_build_object(
      'public_bucket', p_public_bucket,
      'public_object_path', p_public_object_path,
      'cleanup_id', v_cleanup_id,
      'sha256', p_sha256,
      'published_ref_id', v_published_ref_id
    )
  );

  select jsonb_build_object(
    'status', 'published',
    'asset_id', v_row.id,
    'published_bucket', p_public_bucket,
    'published_object_path', p_public_object_path,
    'file_url', p_public_url,
    'cleanup_id', v_cleanup_id,
    'published_ref_id', v_published_ref_id
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.finalize_catalog_asset_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_catalog_asset_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  to service_role;


-- ============================================================
-- E. unpublish_catalog_asset — mark 'published' ref deleted
-- ============================================================
-- Replaces the version in 20260725190000. Signature unchanged:
--   (uuid, timestamptz, uuid, text, text) returns jsonb
--
-- NEW behavior: after the business UPDATE, calls
-- mark_storage_object_refs_deleted('product_asset', p_id, 'published')
-- to transition the active 'published' ref to 'deleted'. The 'source'
-- ref (if any) is left as-is; the asset returns to draft state and
-- the source ref may be re-activated by a new draft save.
-- ============================================================
create or replace function public.unpublish_catalog_asset(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.product_assets%rowtype;
  v_cleanup_id uuid;
  v_old_published_path text;
  v_old_published_bucket text;
  v_refs_deleted integer;
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required' using errcode = '22004';
  end if;

  select * into v_row
    from public.product_assets
    where id = p_id
    for update;

  if not found then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  if v_row.updated_at <> p_expected_updated_at then
    raise exception 'stale updated_at' using errcode = '40P01';
  end if;

  if v_row.publish_status <> 'published' then
    return jsonb_build_object(
      'status', 'already_unpublished',
      'id', p_id,
      'updated_at', v_row.updated_at
    );
  end if;

  v_old_published_bucket := v_row.published_bucket;
  v_old_published_path := v_row.published_object_path;

  update public.product_assets set
    is_published = false,
    publish_status = 'draft',
    published_bucket = null,
    published_object_path = null,
    publish_token = null,
    publish_started_at = null,
    publish_error_code = null
  where id = p_id;

  -- Mark the 'published' ref as deleted (the public object is being
  -- removed). The 'source' ref stays active/superseded so a future
  -- draft save can re-register it.
  v_refs_deleted := public.mark_storage_object_refs_deleted(
    p_owner_type := 'product_asset',
    p_owner_id := p_id,
    p_role := 'published'
  );

  if v_old_published_bucket is not null
     and v_old_published_path is not null
     and btrim(v_old_published_path) <> '' then
    v_cleanup_id := public.enqueue_storage_cleanup(
      p_bucket := v_old_published_bucket,
      p_object_path := v_old_published_path,
      p_reason := 'unpublished',
      p_source_type := 'catalog_asset',
      p_source_id := p_id
    );
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'catalog_asset.unpublish',
    'product_asset', p_id,
    jsonb_build_object(
      'old_published_bucket', v_old_published_bucket,
      'old_published_path', v_old_published_path,
      'cleanup_id', v_cleanup_id,
      'refs_deleted', v_refs_deleted
    )
  );

  return jsonb_build_object(
    'status', 'unpublished',
    'id', p_id,
    'cleanup_id', v_cleanup_id,
    'refs_deleted', v_refs_deleted,
    'updated_at', (select updated_at from public.product_assets where id = p_id)
  );
end;
$$;

revoke all on function public.unpublish_catalog_asset(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.unpublish_catalog_asset(uuid, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- F. delete_product_asset_with_cleanup — mark all refs deleted
-- ============================================================
-- Replaces the version in 20260725190000. Signature unchanged:
--   (uuid, timestamptz, uuid, text, text) returns jsonb
--
-- NEW behavior: BEFORE deleting the business row (so we still have
-- the owner_id), calls mark_storage_object_refs_deleted('product_asset',
-- p_id, NULL) to mark ALL active refs (both 'source' and 'published')
-- as 'deleted'. Then enqueues cleanup for the published + source
-- objects (existing behavior). Then deletes the row.
-- ============================================================
create or replace function public.delete_product_asset_with_cleanup(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.product_assets%rowtype;
  v_cleanup_id_published uuid;
  v_cleanup_id_source uuid;
  v_refs_deleted integer;
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required' using errcode = '22004';
  end if;

  select * into v_row
    from public.product_assets
    where id = p_id
    for update;

  if not found then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  if v_row.updated_at <> p_expected_updated_at then
    raise exception 'stale updated_at' using errcode = '40P01';
  end if;

  -- Mark ALL active refs (source + published) as 'deleted' BEFORE the
  -- business row delete (so the owner_id still joins to them).
  v_refs_deleted := public.mark_storage_object_refs_deleted(
    p_owner_type := 'product_asset',
    p_owner_id := p_id,
    p_role := null
  );

  if v_row.published_bucket is not null
     and v_row.published_object_path is not null
     and btrim(v_row.published_object_path) <> '' then
    v_cleanup_id_published := public.enqueue_storage_cleanup(
      p_bucket := v_row.published_bucket,
      p_object_path := v_row.published_object_path,
      p_reason := 'row_deleted',
      p_source_type := 'catalog_asset',
      p_source_id := v_row.id
    );
  end if;

  if v_row.source_bucket is not null
     and v_row.source_object_path is not null
     and btrim(v_row.source_object_path) <> '' then
    v_cleanup_id_source := public.enqueue_storage_cleanup(
      p_bucket := v_row.source_bucket,
      p_object_path := v_row.source_object_path,
      p_reason := 'row_deleted',
      p_source_type := 'catalog_asset',
      p_source_id := v_row.id
    );
  end if;

  delete from public.product_assets where id = p_id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'catalog_asset.delete',
    'product_asset', p_id,
    jsonb_build_object(
      'cleanup_id_published', v_cleanup_id_published,
      'cleanup_id_source', v_cleanup_id_source,
      'refs_deleted', v_refs_deleted
    )
  );

  return jsonb_build_object(
    'status', 'deleted',
    'id', p_id,
    'cleanup_id_published', v_cleanup_id_published,
    'cleanup_id_source', v_cleanup_id_source,
    'refs_deleted', v_refs_deleted
  );
end;
$$;

revoke all on function public.delete_product_asset_with_cleanup(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.delete_product_asset_with_cleanup(uuid, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- G. save_certificate_draft — register 'source' ref
-- ============================================================
-- Replaces the version in 20260725190000. Signature unchanged:
--   (uuid, jsonb, text, text, text, bigint, text, timestamptz,
--    uuid, text, text) returns jsonb
--
-- NEW behavior: registers a 'source' ref with owner_type='certificate'.
-- ============================================================
create or replace function public.save_certificate_draft(
  p_id uuid,
  p_payload jsonb,
  p_source_bucket text,
  p_source_object_path text,
  p_mime_type text default null,
  p_file_size bigint default null,
  p_sha256 text default null,
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
  v_existing public.certificates%rowtype;
  v_id uuid;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_name_cn text;
  v_name_en text;
  v_description_cn text;
  v_description_en text;
  v_applicable_scope_cn text;
  v_applicable_scope_en text;
  v_sort_order integer;
  v_is_published boolean;
  v_ref_id uuid;
begin
  v_name_cn := v_payload->>'name_cn';
  v_name_en := v_payload->>'name_en';
  v_description_cn := v_payload->>'description_cn';
  v_description_en := v_payload->>'description_en';
  v_applicable_scope_cn := v_payload->>'applicable_scope_cn';
  v_applicable_scope_en := v_payload->>'applicable_scope_en';
  v_sort_order := coalesce((v_payload->>'sort_order')::integer, 0);
  v_is_published := coalesce((v_payload->>'is_published')::boolean, false);

  if p_source_bucket is null or p_source_bucket <> 'private-assets' then
    raise exception 'source_bucket must be private-assets for draft'
      using errcode = '22004';
  end if;
  if p_source_object_path is null or btrim(p_source_object_path) = '' then
    raise exception 'source_object_path is required for draft'
      using errcode = '22004';
  end if;

  if p_id is not null then
    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required on update'
        using errcode = '22004';
    end if;

    select * into v_existing
      from public.certificates
      where id = p_id
      for update;

    if not found then
      raise exception 'certificate not found' using errcode = 'P0002';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    if v_existing.publish_status in ('publishing', 'published') then
      raise exception 'cannot save draft over a publishing/published certificate'
        using errcode = '22004';
    end if;

    update public.certificates set
      name_cn = v_name_cn,
      name_en = nullif(v_name_en, ''),
      description_cn = nullif(v_description_cn, ''),
      description_en = nullif(v_description_en, ''),
      applicable_scope_cn = nullif(v_applicable_scope_cn, ''),
      applicable_scope_en = nullif(v_applicable_scope_en, ''),
      sort_order = v_sort_order,
      is_published = v_is_published,
      source_bucket = p_source_bucket,
      source_object_path = p_source_object_path,
      mime_type = p_mime_type,
      file_size = p_file_size,
      publish_status = 'draft',
      publish_error_code = null
    where id = p_id;

    v_ref_id := public.register_storage_object_ref(
      p_owner_type := 'certificate',
      p_owner_id := p_id,
      p_role := 'source',
      p_bucket := p_source_bucket,
      p_object_path := p_source_object_path,
      p_visibility := 'private',
      p_mime_type := p_mime_type,
      p_size_bytes := p_file_size,
      p_sha256 := p_sha256
    );

    insert into public.admin_audit_log (
      actor_id, actor_email, actor_role, action, target_type, target_id,
      metadata
    ) values (
      p_actor_id, p_actor_email, p_actor_role,
      'certificate.draft_save',
      'certificate', p_id,
      jsonb_build_object(
        'source_object_path', p_source_object_path,
        'storage_object_ref_id', v_ref_id
      )
    );

    return jsonb_build_object(
      'status', 'updated',
      'id', p_id,
      'storage_object_ref_id', v_ref_id,
      'updated_at', (select updated_at from public.certificates where id = p_id)
    );
  end if;

  insert into public.certificates (
    name_cn, name_en, description_cn, description_en,
    applicable_scope_cn, applicable_scope_en,
    image_url, file_size, mime_type,
    is_published, sort_order,
    source_bucket, source_object_path,
    publish_status
  ) values (
    v_name_cn,
    nullif(v_name_en, ''),
    nullif(v_description_cn, ''),
    nullif(v_description_en, ''),
    nullif(v_applicable_scope_cn, ''),
    nullif(v_applicable_scope_en, ''),
    null,
    p_file_size,
    p_mime_type,
    v_is_published,
    v_sort_order,
    p_source_bucket,
    p_source_object_path,
    'draft'
  )
  returning id into v_id;

  v_ref_id := public.register_storage_object_ref(
    p_owner_type := 'certificate',
    p_owner_id := v_id,
    p_role := 'source',
    p_bucket := p_source_bucket,
    p_object_path := p_source_object_path,
    p_visibility := 'private',
    p_mime_type := p_mime_type,
    p_size_bytes := p_file_size,
    p_sha256 := p_sha256
  );

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'certificate.draft_create',
    'certificate', v_id,
    jsonb_build_object(
      'source_object_path', p_source_object_path,
      'storage_object_ref_id', v_ref_id
    )
  );

  return jsonb_build_object(
    'status', 'created',
    'id', v_id,
    'storage_object_ref_id', v_ref_id,
    'updated_at', (select updated_at from public.certificates where id = v_id)
  );
end;
$$;

revoke all on function public.save_certificate_draft(uuid, jsonb, text, text, text, bigint, text, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_certificate_draft(uuid, jsonb, text, text, text, bigint, text, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- H. finalize_certificate_publish — register 'published' ref,
--    supersede 'source' ref
-- ============================================================
-- Replaces the version in 20260725190000. Signature unchanged:
--   (uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
--   returns jsonb
-- ============================================================
create or replace function public.finalize_certificate_publish(
  p_id uuid,
  p_publish_token uuid,
  p_public_bucket text,
  p_public_object_path text,
  p_public_url text,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_sha256 text default null,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.certificates%rowtype;
  v_cleanup_id uuid;
  v_result jsonb;
  v_old_source_path text;
  v_published_ref_id uuid;
begin
  if p_id is null or p_publish_token is null then
    raise exception 'id and publish_token are required' using errcode = '22004';
  end if;
  if p_public_bucket is null or p_public_bucket <> 'public-assets' then
    raise exception 'public_bucket must be public-assets'
      using errcode = '22004';
  end if;
  if p_public_object_path is null or btrim(p_public_object_path) = '' then
    raise exception 'public_object_path is required' using errcode = '22004';
  end if;
  if p_public_url is null or btrim(p_public_url) = '' then
    raise exception 'public_url is required' using errcode = '22004';
  end if;

  select * into v_row
    from public.certificates
    where id = p_id
    for update;

  if not found then
    raise exception 'certificate not found' using errcode = 'P0002';
  end if;

  if v_row.publish_status <> 'publishing' then
    raise exception 'certificate is not in publishing state'
      using errcode = '40P01';
  end if;
  if v_row.publish_token is null or v_row.publish_token <> p_publish_token then
    raise exception 'publish_token mismatch' using errcode = '40P01';
  end if;

  v_old_source_path := v_row.source_object_path;

  update public.certificates set
    published_bucket = p_public_bucket,
    published_object_path = p_public_object_path,
    image_url = p_public_url,
    publish_status = 'published',
    publish_token = null,
    publish_started_at = null,
    publish_error_code = null,
    candidate_public_bucket = p_public_bucket,
    candidate_public_path = p_public_object_path,
    candidate_sha256 = p_sha256,
    last_publish_error_code = null,
    mime_type = coalesce(p_mime_type, mime_type)
  where id = v_row.id;

  v_published_ref_id := public.register_storage_object_ref(
    p_owner_type := 'certificate',
    p_owner_id := v_row.id,
    p_role := 'published',
    p_bucket := p_public_bucket,
    p_object_path := p_public_object_path,
    p_visibility := 'public',
    p_mime_type := p_mime_type,
    p_size_bytes := p_size_bytes,
    p_sha256 := p_sha256
  );

  -- Supersede the 'source' ref (private draft no longer active).
  update public.storage_object_refs
    set status = 'superseded', updated_at = now()
    where owner_type = 'certificate'
      and owner_id = v_row.id
      and role = 'source'
      and status = 'active';

  if v_old_source_path is not null and v_row.source_bucket = 'private-assets' then
    v_cleanup_id := public.enqueue_storage_cleanup(
      p_bucket := 'private-assets',
      p_object_path := v_old_source_path,
      p_reason := 'replaced',
      p_source_type := 'certificate',
      p_source_id := v_row.id
    );
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'certificate.publish',
    'certificate', v_row.id,
    jsonb_build_object(
      'public_bucket', p_public_bucket,
      'public_object_path', p_public_object_path,
      'cleanup_id', v_cleanup_id,
      'sha256', p_sha256,
      'published_ref_id', v_published_ref_id
    )
  );

  select jsonb_build_object(
    'status', 'published',
    'id', v_row.id,
    'published_bucket', p_public_bucket,
    'published_object_path', p_public_object_path,
    'image_url', p_public_url,
    'cleanup_id', v_cleanup_id,
    'published_ref_id', v_published_ref_id
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.finalize_certificate_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_certificate_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  to service_role;


-- ============================================================
-- I. unpublish_certificate — mark 'published' ref deleted
-- ============================================================
-- Replaces the version in 20260725190000. Signature unchanged:
--   (uuid, timestamptz, uuid, text, text) returns jsonb
-- ============================================================
create or replace function public.unpublish_certificate(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.certificates%rowtype;
  v_cleanup_id uuid;
  v_old_published_path text;
  v_old_published_bucket text;
  v_refs_deleted integer;
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required' using errcode = '22004';
  end if;

  select * into v_row
    from public.certificates
    where id = p_id
    for update;

  if not found then
    raise exception 'certificate not found' using errcode = 'P0002';
  end if;

  if v_row.updated_at <> p_expected_updated_at then
    raise exception 'stale updated_at' using errcode = '40P01';
  end if;

  if v_row.publish_status <> 'published' then
    return jsonb_build_object(
      'status', 'already_unpublished',
      'id', p_id,
      'updated_at', v_row.updated_at
    );
  end if;

  v_old_published_bucket := v_row.published_bucket;
  v_old_published_path := v_row.published_object_path;

  update public.certificates set
    is_published = false,
    publish_status = 'draft',
    published_bucket = null,
    published_object_path = null,
    publish_token = null,
    publish_started_at = null,
    publish_error_code = null
  where id = p_id;

  v_refs_deleted := public.mark_storage_object_refs_deleted(
    p_owner_type := 'certificate',
    p_owner_id := p_id,
    p_role := 'published'
  );

  if v_old_published_bucket is not null
     and v_old_published_path is not null
     and btrim(v_old_published_path) <> '' then
    v_cleanup_id := public.enqueue_storage_cleanup(
      p_bucket := v_old_published_bucket,
      p_object_path := v_old_published_path,
      p_reason := 'unpublished',
      p_source_type := 'certificate',
      p_source_id := p_id
    );
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'certificate.unpublish',
    'certificate', p_id,
    jsonb_build_object(
      'old_published_bucket', v_old_published_bucket,
      'old_published_path', v_old_published_path,
      'cleanup_id', v_cleanup_id,
      'refs_deleted', v_refs_deleted
    )
  );

  return jsonb_build_object(
    'status', 'unpublished',
    'id', p_id,
    'cleanup_id', v_cleanup_id,
    'refs_deleted', v_refs_deleted,
    'updated_at', (select updated_at from public.certificates where id = p_id)
  );
end;
$$;

revoke all on function public.unpublish_certificate(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.unpublish_certificate(uuid, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- J. delete_certificate_with_cleanup — mark all refs deleted
-- ============================================================
-- Replaces the version in 20260725190000. Signature unchanged.
-- ============================================================
create or replace function public.delete_certificate_with_cleanup(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.certificates%rowtype;
  v_cleanup_id_published uuid;
  v_cleanup_id_source uuid;
  v_refs_deleted integer;
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required' using errcode = '22004';
  end if;

  select * into v_row
    from public.certificates
    where id = p_id
    for update;

  if not found then
    raise exception 'certificate not found' using errcode = 'P0002';
  end if;

  if v_row.updated_at <> p_expected_updated_at then
    raise exception 'stale updated_at' using errcode = '40P01';
  end if;

  v_refs_deleted := public.mark_storage_object_refs_deleted(
    p_owner_type := 'certificate',
    p_owner_id := p_id,
    p_role := null
  );

  if v_row.published_bucket is not null
     and v_row.published_object_path is not null
     and btrim(v_row.published_object_path) <> '' then
    v_cleanup_id_published := public.enqueue_storage_cleanup(
      p_bucket := v_row.published_bucket,
      p_object_path := v_row.published_object_path,
      p_reason := 'row_deleted',
      p_source_type := 'certificate',
      p_source_id := v_row.id
    );
  end if;

  if v_row.source_bucket is not null
     and v_row.source_object_path is not null
     and btrim(v_row.source_object_path) <> '' then
    v_cleanup_id_source := public.enqueue_storage_cleanup(
      p_bucket := v_row.source_bucket,
      p_object_path := v_row.source_object_path,
      p_reason := 'row_deleted',
      p_source_type := 'certificate',
      p_source_id := v_row.id
    );
  end if;

  delete from public.certificates where id = p_id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'certificate.delete',
    'certificate', p_id,
    jsonb_build_object(
      'cleanup_id_published', v_cleanup_id_published,
      'cleanup_id_source', v_cleanup_id_source,
      'refs_deleted', v_refs_deleted
    )
  );

  return jsonb_build_object(
    'status', 'deleted',
    'id', p_id,
    'cleanup_id_published', v_cleanup_id_published,
    'cleanup_id_source', v_cleanup_id_source,
    'refs_deleted', v_refs_deleted
  );
end;
$$;

revoke all on function public.delete_certificate_with_cleanup(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.delete_certificate_with_cleanup(uuid, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- K. complete_storage_cleanup — mark matching refs deleted on success
-- ============================================================
-- Replaces the version in 20260725240000. Signature unchanged:
--   (uuid, uuid, boolean, text, uuid, text) returns text
--
-- NEW behavior: when p_success=true and the effective final_status is
-- 'deleted' (either explicitly passed or defaulted because the storage
-- object was actually removed), all storage_object_refs rows whose
-- (bucket, object_path) match the cleanup queue row AND status='active'
-- are atomically transitioned to status='deleted'.
--
-- This closes the loop: cleanup completion must not leave active
-- registry refs pointing at objects that no longer exist.
--
-- The signature and existing retry / dead-letter / operation-link
-- semantics are preserved unchanged.
-- ============================================================
drop function if exists public.complete_storage_cleanup(
  uuid, uuid, boolean, text, uuid, text
);

create function public.complete_storage_cleanup(
  p_cleanup_id uuid,
  p_lock_token uuid,
  p_success boolean,
  p_error_code text default null,
  p_storage_operation_id uuid default null,
  p_final_status text default null
) returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
  v_final_status text := p_final_status;
  v_row public.storage_cleanup_queue%rowtype;
begin
  if p_cleanup_id is null or p_lock_token is null then
    return 'INVALID_PARAMS';
  end if;

  if v_final_status is not null and v_final_status not in (
    'deleted',
    'blocked_referenced',
    'reference_check_failed',
    'storage_delete_failed',
    'audit_start_failed'
  ) then
    return 'INVALID_PARAMS';
  end if;

  select * into v_row
    from public.storage_cleanup_queue
    where id = p_cleanup_id
      and status = 'claimed'
      and lock_token = p_lock_token
    for update;

  if not found then
    return 'NOT_FOUND_OR_TOKEN_MISMATCH';
  end if;

  v_attempts := v_row.attempts;
  v_max_attempts := v_row.max_attempts;

  if p_success then
    update public.storage_cleanup_queue
      set status = 'completed',
          completed_at = now(),
          lock_token = null,
          locked_at = null,
          last_error_code = null,
          storage_operation_id = coalesce(p_storage_operation_id, storage_operation_id),
          final_status = coalesce(v_final_status, final_status),
          updated_at = now()
      where id = p_cleanup_id;

    -- Mark matching active storage_object_refs rows as 'deleted'.
    -- Only applies when the storage object was actually removed
    -- (final_status='deleted' or NULL treated as deleted on success).
    if coalesce(v_final_status, 'deleted') = 'deleted' then
      update public.storage_object_refs
        set status = 'deleted', updated_at = now()
        where bucket = v_row.bucket
          and object_path = v_row.object_path
          and status = 'active';
    end if;

    return 'completed';
  end if;

  v_attempts := v_attempts + 1;
  if v_attempts >= v_max_attempts then
    update public.storage_cleanup_queue
      set status = 'dead_letter',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          lock_token = null,
          locked_at = null,
          storage_operation_id = coalesce(p_storage_operation_id, storage_operation_id),
          final_status = coalesce(v_final_status, final_status),
          updated_at = now()
      where id = p_cleanup_id;
    return 'dead_letter';
  else
    update public.storage_cleanup_queue
      set status = 'retry',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          next_retry_at = now() + least(
            make_interval(secs => 60) * power(2, v_attempts - 1),
            interval '30 minutes'
          ),
          lock_token = null,
          locked_at = null,
          storage_operation_id = coalesce(p_storage_operation_id, storage_operation_id),
          final_status = coalesce(v_final_status, final_status),
          updated_at = now()
      where id = p_cleanup_id;
    return 'retry';
  end if;
end;
$$;

revoke all on function public.complete_storage_cleanup(
  uuid, uuid, boolean, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.complete_storage_cleanup(
  uuid, uuid, boolean, text, uuid, text
) to service_role;


-- ============================================================
-- L. Assert contract invariants at migration time
-- ============================================================
do $$
declare
  v_cleanup_count integer;
  v_helper_count integer;
begin
  -- complete_storage_cleanup must still be a single overload.
  select count(*)
    into v_cleanup_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'complete_storage_cleanup';
  if v_cleanup_count <> 1 then
    raise exception
      'complete_storage_cleanup overload count must be 1, got %',
      v_cleanup_count
      using errcode = 'P0001';
  end if;

  -- register_storage_object_ref and mark_storage_object_refs_deleted
  -- must both exist.
  select count(*)
    into v_helper_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'register_storage_object_ref',
        'mark_storage_object_refs_deleted'
      );
  if v_helper_count <> 2 then
    raise exception
      'expected 2 storage_object_refs helper RPCs, found %',
      v_helper_count
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
