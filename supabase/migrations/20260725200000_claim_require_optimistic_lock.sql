-- ============================================================
-- 20260725200000_claim_require_optimistic_lock.sql
-- ------------------------------------------------------------
-- Section 5 (Claim 强制乐观锁): p_expected_updated_at MUST NOT be
-- NULL in claim_catalog_asset_publish / claim_certificate_publish.
--
-- Previously claim_catalog_asset_publish allowed p_expected_updated_at
-- to be NULL, which let callers bypass optimistic-lock verification
-- by simply omitting the argument. Section 5 explicitly forbids
-- that: "缺失或 null: 22004 / ADMIN_WRITE_BAD_REQUEST".
--
-- This forward-only migration replaces both claim RPCs so the
-- parameter is non-optional. The function signatures are kept
-- compatible (the parameter still has a default of NULL for SQL
-- signature stability), but the function body now raises 22004
-- when NULL is passed. Existing callers that already pass a real
-- timestamp are unaffected; callers that relied on NULL to skip
-- the lock check will now receive a 22004 error.
--
-- This migration does NOT:
--   - drop or truncate any table
--   - delete existing rows
--   - modify existing column types
--   - alter historical migrations
-- ============================================================

-- ============================================================
-- A. claim_catalog_asset_publish — make optimistic lock mandatory
-- ============================================================
create or replace function public.claim_catalog_asset_publish(
  p_asset_id uuid,
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
  v_row public.product_assets%rowtype;
  v_token uuid;
  v_result jsonb;
begin
  if p_asset_id is null then
    raise exception 'asset_id is required' using errcode = '22004';
  end if;

  -- Section 5: optimistic lock is mandatory. NULL is rejected with
  -- 22004 so callers cannot bypass version verification by omitting
  -- the argument. This aligns claim with finalize, save_draft(update),
  -- authorize, unpublish, and delete, all of which require it.
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required for claim'
      using errcode = '22004';
  end if;

  select * into v_row
    from public.product_assets
    where id = p_asset_id
    for update;

  if not found then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  if v_row.updated_at <> p_expected_updated_at then
    raise exception 'stale updated_at' using errcode = '40P01';
  end if;

  if v_row.is_published is not true then
    raise exception 'asset is not marked for public publish'
      using errcode = '22004';
  end if;
  if coalesce(v_row.access_level, 'private') <> 'public' then
    raise exception 'access_level must be public' using errcode = '22004';
  end if;
  if coalesce(v_row.authorization_status, 'pending') <> 'confirmed' then
    raise exception 'authorization_status must be confirmed'
      using errcode = '22004';
  end if;

  if v_row.publish_status = 'published' then
    select jsonb_build_object(
      'status', 'already_published',
      'asset_id', v_row.id,
      'published_bucket', v_row.published_bucket,
      'published_object_path', v_row.published_object_path,
      'file_url', v_row.file_url,
      'publish_token', null,
      'updated_at', v_row.updated_at
    ) into v_result;
    return v_result;
  end if;

  if v_row.publish_status = 'publishing'
     and v_row.publish_started_at is not null
     and v_row.publish_started_at > (now() - interval '10 minutes') then
    raise exception 'concurrent publish in progress' using errcode = '40P01';
  end if;

  if v_row.source_bucket is null
     or v_row.source_bucket <> 'private-assets'
     or v_row.source_object_path is null
     or btrim(v_row.source_object_path) = '' then
    raise exception 'source must be in private-assets'
      using errcode = '22004';
  end if;

  v_token := gen_random_uuid();
  update public.product_assets set
    publish_status = 'publishing',
    publish_token = v_token,
    publish_started_at = now(),
    publish_error_code = null
  where id = v_row.id;

  select updated_at into v_row from public.product_assets where id = v_row.id;

  select jsonb_build_object(
    'status', 'claimed',
    'asset_id', v_row.id,
    'source_bucket', 'private-assets',
    'source_object_path', v_row.source_object_path,
    'mime_type', v_row.mime_type,
    'publish_token', v_token,
    'updated_at', v_row.updated_at
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.claim_catalog_asset_publish(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_catalog_asset_publish(uuid, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- B. claim_certificate_publish — make optimistic lock mandatory
-- ============================================================
create or replace function public.claim_certificate_publish(
  p_id uuid,
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
  v_row public.certificates%rowtype;
  v_token uuid;
  v_result jsonb;
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22004';
  end if;

  -- Section 5: optimistic lock is mandatory.
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required for claim'
      using errcode = '22004';
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

  if v_row.is_published is not true then
    raise exception 'certificate is not marked for public publish'
      using errcode = '22004';
  end if;
  if coalesce(v_row.access_level, 'private') <> 'public' then
    raise exception 'access_level must be public' using errcode = '22004';
  end if;
  if coalesce(v_row.authorization_status, 'pending') <> 'confirmed' then
    raise exception 'authorization_status must be confirmed'
      using errcode = '22004';
  end if;

  if v_row.publish_status = 'published' then
    select jsonb_build_object(
      'status', 'already_published',
      'id', v_row.id,
      'published_bucket', v_row.published_bucket,
      'published_object_path', v_row.published_object_path,
      'image_url', v_row.image_url,
      'publish_token', null,
      'updated_at', v_row.updated_at
    ) into v_result;
    return v_result;
  end if;

  if v_row.publish_status = 'publishing'
     and v_row.publish_started_at is not null
     and v_row.publish_started_at > (now() - interval '10 minutes') then
    raise exception 'concurrent publish in progress' using errcode = '40P01';
  end if;

  if v_row.source_bucket is null
     or v_row.source_bucket <> 'private-assets'
     or v_row.source_object_path is null
     or btrim(v_row.source_object_path) = '' then
    raise exception 'source must be in private-assets'
      using errcode = '22004';
  end if;

  v_token := gen_random_uuid();
  update public.certificates set
    publish_status = 'publishing',
    publish_token = v_token,
    publish_started_at = now(),
    publish_error_code = null
  where id = v_row.id;

  select updated_at into v_row from public.certificates where id = v_row.id;

  select jsonb_build_object(
    'status', 'claimed',
    'id', v_row.id,
    'source_bucket', 'private-assets',
    'source_object_path', v_row.source_object_path,
    'mime_type', v_row.mime_type,
    'publish_token', v_token,
    'updated_at', v_row.updated_at
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.claim_certificate_publish(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_certificate_publish(uuid, timestamptz, uuid, text, text)
  to service_role;
