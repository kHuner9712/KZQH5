-- ============================================================
-- 20260725190000_catalog_certificate_publish_close_loop.sql
-- ------------------------------------------------------------
-- Section 4 / 5 / 6: Close the catalog + certificate publish loop.
--
-- This migration is FORWARD-ONLY. It only:
--   * adds new columns (candidate_public_* for stale recovery);
--   * adds new RPCs (authorize_product_asset, certificate
--     claim/finalize/authorize/unpublish, stale recovery);
--   * tightens finalize_catalog_asset_publish to make audit atomic
--     (no more `exception when others then null`).
--
-- It does NOT drop or modify existing table data, and does NOT
-- change historical migrations.
-- ============================================================

-- ============================================================
-- A. Add candidate_public_* columns to product_assets
-- ============================================================
-- Section 5 (stale publish recovery) requires persisting the
-- candidate public ref so that recovery can distinguish:
--   - public object never created;
--   - public object created but finalize failed;
--   - finalize succeeded but response lost;
--   - compensate delete failed.
--
-- Without these fields, stale recovery cannot tell whether the
-- public object exists and must not unconditionally reset to 'draft'.
alter table public.product_assets
  add column if not exists candidate_public_bucket text check (
    candidate_public_bucket is null
      or candidate_public_bucket in ('public-assets', 'private-assets')
  ),
  add column if not exists candidate_public_path text,
  add column if not exists candidate_sha256 text,
  add column if not exists last_publish_error_code text;

-- Same columns on certificates so the certificate publish flow can
-- support the same stale-recovery contract.
alter table public.certificates
  add column if not exists candidate_public_bucket text check (
    candidate_public_bucket is null
      or candidate_public_bucket in ('public-assets', 'private-assets')
  ),
  add column if not exists candidate_public_path text,
  add column if not exists candidate_sha256 text,
  add column if not exists last_publish_error_code text;

-- ============================================================
-- B. authorize_product_asset — record explicit admin authorize
-- ============================================================
-- Section 4: authorization_status='confirmed' MUST be written by a
-- dedicated admin command with audit, NOT by a generic PATCH or by
-- ticking a UI checkbox that maps directly to the column.
--
-- This RPC:
--   1. SELECT ... FOR UPDATE the row.
--   2. Validate access_level='public' (only public assets can be
--      marked authorized for public release).
--   3. Validate source_type is non-null (provenance required).
--   4. Validate source_bucket/source_object_path exist (draft must
--      be uploaded first).
--   5. Update authorization_status='confirmed'.
--   6. Insert admin_audit_log row in the SAME transaction.
--   7. Return the new updated_at.
--
-- On any precondition violation raises 22004. On stale updated_at
-- raises 40P01.
-- ============================================================
create or replace function public.authorize_product_asset(
  p_asset_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.product_assets%rowtype;
begin
  if p_asset_id is null then
    raise exception 'asset_id is required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required' using errcode = '22004';
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

  if coalesce(v_row.access_level, 'private') <> 'public' then
    raise exception 'access_level must be public to authorize'
      using errcode = '22004';
  end if;

  if v_row.source_type is null then
    raise exception 'source_type is required to authorize'
      using errcode = '22004';
  end if;

  if v_row.source_bucket is null
     or v_row.source_object_path is null
     or btrim(v_row.source_object_path) = '' then
    raise exception 'source ref must be uploaded before authorization'
      using errcode = '22004';
  end if;

  update public.product_assets set
    authorization_status = 'confirmed'
  where id = v_row.id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'catalog_asset.authorization_confirm',
    'product_asset', v_row.id,
    jsonb_build_object('previous_status', v_row.authorization_status)
  );

  return (select updated_at from public.product_assets where id = v_row.id);
end;
$$;

revoke all on function public.authorize_product_asset(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.authorize_product_asset(uuid, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- C. Replace finalize_catalog_asset_publish — atomic audit,
--    no `exception when others then null`
-- ============================================================
-- Section 5: Finalize MUST be atomic. The previous version swallowed
-- audit insert failures with `exception when others then null`, which
-- violated "audit failure rolls back business write".
--
-- The new version removes the exception swallow so any audit failure
-- aborts the whole transaction (rolling back the publish update +
-- cleanup enqueue).
--
-- Signature is unchanged so existing callers continue to work.
-- ============================================================
drop function if exists public.finalize_catalog_asset_publish(
  uuid, uuid, text, text, text, text, bigint, text, uuid, text, text
);

create function public.finalize_catalog_asset_publish(
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

  -- Update the asset row to the new public ref + persist candidate
  -- fields so stale recovery can see what was attempted.
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

  -- Enqueue old private source for cleanup. Any failure here aborts
  -- the whole transaction (rolling back the UPDATE above) so the
  -- caller can retry finalize with the same token.
  if v_old_source_path is not null and v_row.source_bucket = 'private-assets' then
    v_cleanup_id := public.enqueue_storage_cleanup(
      p_bucket := 'private-assets',
      p_object_path := v_old_source_path,
      p_reason := 'replaced',
      p_source_type := 'catalog_asset',
      p_source_id := v_row.id
    );
  end if;

  -- Atomic audit: NO `exception when others then null`. Any audit
  -- insert failure rolls back the publish + cleanup enqueue above.
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
      'sha256', p_sha256
    )
  );

  select jsonb_build_object(
    'status', 'published',
    'asset_id', v_row.id,
    'published_bucket', p_public_bucket,
    'published_object_path', p_public_object_path,
    'file_url', p_public_url,
    'cleanup_id', v_cleanup_id
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.finalize_catalog_asset_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_catalog_asset_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  to service_role;

-- ============================================================
-- D. save_product_asset_draft — structured private draft save
-- ============================================================
-- Section 4 (Draft 保存): new drafts MUST save the structured ref
-- (source_bucket=private-assets, source_object_path, mime_type,
-- file_size, sha256) and must NOT save private-assets:// pseudo URLs
-- or signed preview URLs into file_url.
--
-- This RPC inserts or updates a product_assets row in 'draft' state:
--   * On insert: sets publish_status='draft', access_level='private'
--     by default, authorization_status='pending'.
--   * On update: validates publish_status='draft' (cannot save draft
--     over a published row), preserves existing file_url when the new
--     source ref is private (file_url stays null or the previous
--     public URL).
--
-- Optimistic lock via p_expected_updated_at (NULL allowed only on
-- insert).
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
begin
  -- Extract validated fields from payload (caller is responsible
  -- for allowlist; we only read known keys here).
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

  -- Validate source_bucket.
  if p_source_bucket is null or p_source_bucket <> 'private-assets' then
    raise exception 'source_bucket must be private-assets for draft'
      using errcode = '22004';
  end if;
  if p_source_object_path is null or btrim(p_source_object_path) = '' then
    raise exception 'source_object_path is required for draft'
      using errcode = '22004';
  end if;

  if p_id is not null then
    -- UPDATE path: optimistic lock required.
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

    -- Cannot save a draft over a row that is currently publishing or
    -- published. Caller must unpublish first.
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
      published_at = nullif(v_published_at, ''),
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

    insert into public.admin_audit_log (
      actor_id, actor_email, actor_role, action, target_type, target_id,
      metadata
    ) values (
      p_actor_id, p_actor_email, p_actor_role,
      'catalog_asset.draft_save',
      'product_asset', p_id,
      jsonb_build_object('source_bucket', p_source_bucket, 'source_object_path', p_source_object_path)
    );

    return jsonb_build_object(
      'status', 'updated',
      'id', p_id,
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
    null,  -- file_url: NULL on new draft (no published public URL yet)
    nullif(v_cover_image_url, ''),
    p_file_size,
    p_mime_type,
    v_is_published,
    v_sort_order,
    nullif(v_published_at, ''),
    nullif(v_content_hash, ''),
    v_access_level,
    nullif(v_source_type, ''),
    v_authorization_status,
    p_source_bucket,
    p_source_object_path,
    'draft'
  )
  returning id into v_id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'catalog_asset.draft_create',
    'product_asset', v_id,
    jsonb_build_object('source_bucket', p_source_bucket, 'source_object_path', p_source_object_path)
  );

  return jsonb_build_object(
    'status', 'created',
    'id', v_id,
    'updated_at', (select updated_at from public.product_assets where id = v_id)
  );
end;
$$;

revoke all on function public.save_product_asset_draft(uuid, jsonb, text, text, text, bigint, text, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_product_asset_draft(uuid, jsonb, text, text, text, bigint, text, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- E. update_product_asset_metadata — non-draft field updates
-- ============================================================
-- Updates non-storage fields (title, description, sort_order, etc.)
-- on an existing product_assets row. Cannot change source_bucket /
-- source_object_path (use save_product_asset_draft for that) or
-- publish_status (use publish/unpublish).
--
-- Optimistic lock via p_expected_updated_at (required).
-- Atomic audit row in the same transaction.
-- ============================================================
create or replace function public.update_product_asset_metadata(
  p_id uuid,
  p_payload jsonb,
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
  v_existing public.product_assets%rowtype;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required' using errcode = '22004';
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

  update public.product_assets set
    product_id = nullif(v_payload->>'product_id', '')::uuid,
    asset_type = v_payload->>'asset_type',
    catalog_topic_id = nullif(v_payload->>'catalog_topic_id', ''),
    title_cn = v_payload->>'title_cn',
    title_en = nullif(v_payload->>'title_en', ''),
    description_cn = nullif(v_payload->>'description_cn', ''),
    description_en = nullif(v_payload->>'description_en', ''),
    cover_image_url = nullif(v_payload->>'cover_image_url', ''),
    published_at = nullif(v_payload->>'published_at', ''),
    content_hash = nullif(v_payload->>'content_hash', ''),
    sort_order = coalesce((v_payload->>'sort_order')::integer, 0),
    is_published = coalesce((v_payload->>'is_published')::boolean, false),
    access_level = coalesce(v_payload->>'access_level', access_level),
    source_type = nullif(v_payload->>'source_type', '')
  where id = p_id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'catalog_asset.update_metadata',
    'product_asset', p_id,
    jsonb_build_object('updated_fields', (select jsonb_object_keys(v_payload)))
  );

  return jsonb_build_object(
    'status', 'updated',
    'id', p_id,
    'updated_at', (select updated_at from public.product_assets where id = p_id)
  );
end;
$$;

revoke all on function public.update_product_asset_metadata(uuid, jsonb, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.update_product_asset_metadata(uuid, jsonb, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- F. delete_product_asset_with_cleanup — atomic delete + enqueue
-- ============================================================
-- Section 4 / 6: deleting a product_assets row MUST atomically:
--   1. SELECT ... FOR UPDATE the row.
--   2. Validate optimistic lock.
--   3. Capture old published_bucket/path + source_bucket/path.
--   4. DELETE the row.
--   5. Enqueue both the published and source objects for cleanup
--      (so Storage dispatcher deletes them later after reference
--      re-check). Failure to enqueue aborts the whole transaction.
--   6. Atomic audit row.
--
-- Caller still has to verify admin role / origin at the app layer.
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

  -- Enqueue published object for cleanup BEFORE delete (so we still
  -- have the path). Failure aborts the transaction.
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

  -- Enqueue private source for cleanup.
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
      'cleanup_id_source', v_cleanup_id_source
    )
  );

  return jsonb_build_object(
    'status', 'deleted',
    'id', p_id,
    'cleanup_id_published', v_cleanup_id_published,
    'cleanup_id_source', v_cleanup_id_source
  );
end;
$$;

revoke all on function public.delete_product_asset_with_cleanup(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.delete_product_asset_with_cleanup(uuid, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- G. unpublish_catalog_asset — atomic publish→draft transition
-- ============================================================
-- Section 13 (发布和下架语义): cannot just toggle is_published=false.
-- Unpublish MUST:
--   1. SELECT ... FOR UPDATE.
--   2. Validate optimistic lock.
--   3. Capture old published_bucket/path.
--   4. Set is_published=false, publish_status='draft',
--      published_bucket=null, published_object_path=null.
--      NOTE: file_url is preserved (set to null only if no other
--      public URL is available) so the row remains valid.
--   5. Enqueue old public object for cleanup (retention policy:
--      unpublish deletes the public copy — private source remains).
--   6. Atomic audit row.
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
    -- Idempotent: already not published. Return success without
    -- writing a new audit row.
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

  -- Enqueue old public object for cleanup. Failure aborts the
  -- transaction (rolls back the UPDATE above).
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
      'cleanup_id', v_cleanup_id
    )
  );

  return jsonb_build_object(
    'status', 'unpublished',
    'id', p_id,
    'updated_at', (select updated_at from public.product_assets where id = p_id),
    'cleanup_id', v_cleanup_id
  );
end;
$$;

revoke all on function public.unpublish_catalog_asset(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.unpublish_catalog_asset(uuid, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- H. recover_stale_catalog_publish (replace) — candidate-aware
-- ============================================================
-- Section 5: stale recovery must NOT unconditionally reset to 'draft'.
-- It must account for the candidate public object:
--   - If candidate_public_bucket/path is set, the public object may
--     exist. Recovery sets publish_status='publish_failed' (NOT
--     'draft') and records last_publish_error_code so an operator
--     can decide whether to delete the candidate or resume finalize.
--   - If no candidate is set, the public object was never created;
--     safe to reset to 'draft'.
--
-- The previous version (20260725170000) unconditionally reset to
-- 'draft', which lost the candidate and made it impossible to
-- reconcile. This replacement preserves the candidate fields.
-- ============================================================
drop function if exists public.recover_stale_catalog_publish(integer, uuid, text, text);

create function public.recover_stale_catalog_publish(
  p_timeout_seconds integer default 600,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_ids uuid[];
  v_failed_ids uuid[];
begin
  if p_timeout_seconds is null or p_timeout_seconds < 60 then
    p_timeout_seconds := 600;
  end if;

  -- Rows with NO candidate public ref: safe to reset to 'draft'.
  with updated as (
    update public.product_assets set
      publish_status = 'draft',
      publish_token = null,
      publish_started_at = null,
      publish_error_code = 'stale_recovered'
    where publish_status = 'publishing'
      and publish_started_at is not null
      and publish_started_at < (now() - (p_timeout_seconds || ' seconds')::interval)
      and (candidate_public_bucket is null or candidate_public_path is null)
    returning id
  )
  select array_agg(id) into v_ids from updated;

  -- Rows WITH a candidate public ref: set to 'publish_failed' so an
  -- operator can decide. The candidate fields are preserved.
  with updated as (
    update public.product_assets set
      publish_status = 'publish_failed',
      publish_token = null,
      publish_started_at = null,
      last_publish_error_code = 'stale_with_candidate'
    where publish_status = 'publishing'
      and publish_started_at is not null
      and publish_started_at < (now() - (p_timeout_seconds || ' seconds')::interval)
      and candidate_public_bucket is not null
      and candidate_public_path is not null
    returning id
  )
  select array_agg(id) into v_failed_ids from updated;

  v_count := coalesce(array_length(v_ids, 1), 0)
           + coalesce(array_length(v_failed_ids, 1), 0);

  if v_count > 0 then
    insert into public.admin_audit_log (
      actor_id, actor_email, actor_role, action, target_type, target_id,
      metadata
    ) values (
      p_actor_id, p_actor_email, p_actor_role,
      'catalog_asset.publish_stale_recovered',
      'product_asset', null,
      jsonb_build_object(
        'count', v_count,
        'reset_to_draft_ids', v_ids,
        'failed_with_candidate_ids', v_failed_ids
      )
    );
  end if;

  return v_count;
end;
$$;

revoke all on function public.recover_stale_catalog_publish(integer, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.recover_stale_catalog_publish(integer, uuid, text, text)
  to service_role;

-- ============================================================
-- I. save_certificate_draft — structured private draft save
-- ============================================================
-- Section 6: Certificate draft saves must use the same structured
-- ref model as catalog assets. The certificate's source_bucket /
-- source_object_path point to the private-assets object; image_url
-- stays null until publish.
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

    insert into public.admin_audit_log (
      actor_id, actor_email, actor_role, action, target_type, target_id,
      metadata
    ) values (
      p_actor_id, p_actor_email, p_actor_role,
      'certificate.draft_save',
      'certificate', p_id,
      jsonb_build_object('source_object_path', p_source_object_path)
    );

    return jsonb_build_object(
      'status', 'updated',
      'id', p_id,
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
    null,  -- image_url: NULL on new draft
    p_file_size,
    p_mime_type,
    v_is_published,
    v_sort_order,
    p_source_bucket,
    p_source_object_path,
    'draft'
  )
  returning id into v_id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'certificate.draft_create',
    'certificate', v_id,
    jsonb_build_object('source_object_path', p_source_object_path)
  );

  return jsonb_build_object(
    'status', 'created',
    'id', v_id,
    'updated_at', (select updated_at from public.certificates where id = v_id)
  );
end;
$$;

revoke all on function public.save_certificate_draft(uuid, jsonb, text, text, text, bigint, text, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_certificate_draft(uuid, jsonb, text, text, text, bigint, text, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- J. update_certificate_metadata
-- ============================================================
create or replace function public.update_certificate_metadata(
  p_id uuid,
  p_payload jsonb,
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
  v_existing public.certificates%rowtype;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required' using errcode = '22004';
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

  update public.certificates set
    name_cn = v_payload->>'name_cn',
    name_en = nullif(v_payload->>'name_en', ''),
    description_cn = nullif(v_payload->>'description_cn', ''),
    description_en = nullif(v_payload->>'description_en', ''),
    applicable_scope_cn = nullif(v_payload->>'applicable_scope_cn', ''),
    applicable_scope_en = nullif(v_payload->>'applicable_scope_en', ''),
    sort_order = coalesce((v_payload->>'sort_order')::integer, 0),
    is_published = coalesce((v_payload->>'is_published')::boolean, false)
  where id = p_id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'certificate.update_metadata',
    'certificate', p_id,
    jsonb_build_object('updated_fields', (select jsonb_object_keys(v_payload)))
  );

  return jsonb_build_object(
    'status', 'updated',
    'id', p_id,
    'updated_at', (select updated_at from public.certificates where id = p_id)
  );
end;
$$;

revoke all on function public.update_certificate_metadata(uuid, jsonb, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.update_certificate_metadata(uuid, jsonb, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- K. authorize_certificate — explicit admin authorize
-- ============================================================
-- Same model as authorize_product_asset but for certificates.
-- Sets authorization_status='confirmed' only after validating:
--   * source_type / source provenance provided
--   * source ref uploaded
--   * access_level='public' (only public certs can be authorized)
-- ============================================================
-- NOTE: certificates table does not yet have access_level /
-- source_type / authorization_status / file_size / mime_type columns.
-- Add them here so the certificate publish contract matches the
-- catalog contract.
alter table public.certificates
  add column if not exists access_level text not null default 'private'
    check (access_level in ('public', 'private')),
  add column if not exists source_type text
    check (source_type is null or source_type in
      ('official', 'self-produced', 'licensed', 'public-domain')),
  add column if not exists authorization_status text not null default 'pending'
    check (authorization_status in ('confirmed', 'pending', 'restricted')),
  add column if not exists file_size bigint,
  add column if not exists mime_type text;

create or replace function public.authorize_certificate(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.certificates%rowtype;
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

  if coalesce(v_row.access_level, 'private') <> 'public' then
    raise exception 'access_level must be public to authorize'
      using errcode = '22004';
  end if;
  if v_row.source_type is null then
    raise exception 'source_type is required to authorize'
      using errcode = '22004';
  end if;
  if v_row.source_bucket is null
     or v_row.source_object_path is null
     or btrim(v_row.source_object_path) = '' then
    raise exception 'source ref must be uploaded before authorization'
      using errcode = '22004';
  end if;

  update public.certificates set
    authorization_status = 'confirmed'
  where id = v_row.id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'certificate.authorization_confirm',
    'certificate', v_row.id,
    jsonb_build_object('previous_status', v_row.authorization_status)
  );

  return (select updated_at from public.certificates where id = v_row.id);
end;
$$;

revoke all on function public.authorize_certificate(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.authorize_certificate(uuid, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- L. claim_certificate_publish — two-phase publish, phase 1
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

  select * into v_row
    from public.certificates
    where id = p_id
    for update;

  if not found then
    raise exception 'certificate not found' using errcode = 'P0002';
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at <> p_expected_updated_at then
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

-- ============================================================
-- M. finalize_certificate_publish — two-phase publish, phase 2
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

  if v_old_source_path is not null and v_row.source_bucket = 'private-assets' then
    v_cleanup_id := public.enqueue_storage_cleanup(
      p_bucket := 'private-assets',
      p_object_path := v_old_source_path,
      p_reason := 'replaced',
      p_source_type := 'certificate',
      p_source_id := v_row.id
    );
  end if;

  -- Atomic audit: NO exception swallow.
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
      'sha256', p_sha256
    )
  );

  select jsonb_build_object(
    'status', 'published',
    'id', v_row.id,
    'published_bucket', p_public_bucket,
    'published_object_path', p_public_object_path,
    'image_url', p_public_url,
    'cleanup_id', v_cleanup_id
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.finalize_certificate_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_certificate_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  to service_role;

-- ============================================================
-- N. unpublish_certificate
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
      'cleanup_id', v_cleanup_id
    )
  );

  return jsonb_build_object(
    'status', 'unpublished',
    'id', p_id,
    'updated_at', (select updated_at from public.certificates where id = p_id),
    'cleanup_id', v_cleanup_id
  );
end;
$$;

revoke all on function public.unpublish_certificate(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.unpublish_certificate(uuid, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- O. delete_certificate_with_cleanup
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
      'cleanup_id_source', v_cleanup_id_source
    )
  );

  return jsonb_build_object(
    'status', 'deleted',
    'id', p_id,
    'cleanup_id_published', v_cleanup_id_published,
    'cleanup_id_source', v_cleanup_id_source
  );
end;
$$;

revoke all on function public.delete_certificate_with_cleanup(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.delete_certificate_with_cleanup(uuid, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- P. recover_stale_certificate_publish
-- ============================================================
create or replace function public.recover_stale_certificate_publish(
  p_timeout_seconds integer default 600,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_ids uuid[];
  v_failed_ids uuid[];
begin
  if p_timeout_seconds is null or p_timeout_seconds < 60 then
    p_timeout_seconds := 600;
  end if;

  with updated as (
    update public.certificates set
      publish_status = 'draft',
      publish_token = null,
      publish_started_at = null,
      publish_error_code = 'stale_recovered'
    where publish_status = 'publishing'
      and publish_started_at is not null
      and publish_started_at < (now() - (p_timeout_seconds || ' seconds')::interval)
      and (candidate_public_bucket is null or candidate_public_path is null)
    returning id
  )
  select array_agg(id) into v_ids from updated;

  with updated as (
    update public.certificates set
      publish_status = 'publish_failed',
      publish_token = null,
      publish_started_at = null,
      last_publish_error_code = 'stale_with_candidate'
    where publish_status = 'publishing'
      and publish_started_at is not null
      and publish_started_at < (now() - (p_timeout_seconds || ' seconds')::interval)
      and candidate_public_bucket is not null
      and candidate_public_path is not null
    returning id
  )
  select array_agg(id) into v_failed_ids from updated;

  v_count := coalesce(array_length(v_ids, 1), 0)
           + coalesce(array_length(v_failed_ids, 1), 0);

  if v_count > 0 then
    insert into public.admin_audit_log (
      actor_id, actor_email, actor_role, action, target_type, target_id,
      metadata
    ) values (
      p_actor_id, p_actor_email, p_actor_role,
      'certificate.publish_stale_recovered',
      'certificate', null,
      jsonb_build_object(
        'count', v_count,
        'reset_to_draft_ids', v_ids,
        'failed_with_candidate_ids', v_failed_ids
      )
    );
  end if;

  return v_count;
end;
$$;

revoke all on function public.recover_stale_certificate_publish(integer, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.recover_stale_certificate_publish(integer, uuid, text, text)
  to service_role;

-- ============================================================
-- Q. Update verify_required_schema
-- ============================================================
-- Tell verify_required_schema about the new RPCs so fresh-install
-- and incremental-upgrade tests can detect missing functions.
create or replace function public.verify_required_schema()
returns table(object_name text, object_kind text)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Tables (existing + new columns)
  return query select 'product_assets', 'table'::text;
  return query select 'certificates', 'table'::text;
  return query select 'storage_cleanup_queue', 'table'::text;
  return query select 'admin_storage_operations', 'table'::text';
  return query select 'admin_audit_log', 'table'::text;
  return query select 'storage_object_refs', 'table'::text;

  -- Required RPCs (existing + new)
  return query select 'enqueue_storage_cleanup', 'function'::text;
  return query select 'claim_storage_cleanup', 'function'::text;
  return query select 'complete_storage_cleanup', 'function'::text;
  return query select 'check_storage_object_referenced', 'function'::text;
  return query select 'extract_managed_storage_path', 'function'::text;
  return query select 'enqueue_managed_storage_cleanup', 'function'::text;
  return query select 'record_storage_operation_started', 'function'::text;
  return query select 'complete_storage_operation', 'function'::text;
  return query select 'claim_storage_audit_reconcile', 'function'::text;
  return query select 'complete_storage_audit_reconcile', 'function'::text;
  return query select 'extract_managed_storage_path_strict', 'function'::text;

  -- Catalog asset publish RPCs
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

  -- Transactional business RPCs (existing)
  return query select 'save_product_with_images_and_audit', 'function'::text;
  return query select 'save_project_with_relations_and_audit', 'function'::text;
end;
$$;

revoke all on function public.verify_required_schema()
  from public, anon, authenticated;
grant execute on function public.verify_required_schema()
  to service_role;
