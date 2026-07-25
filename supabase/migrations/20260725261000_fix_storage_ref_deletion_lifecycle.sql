-- ============================================================
-- Phase 18 (Section 4): Introduce a pending_delete ref lifecycle.
--
-- The version wired by 20260725250000 had two defects:
--   1. status CHECK only allowed ('active','superseded','deleted').
--      Replaced/deleted refs were written straight to 'deleted'
--      BEFORE the Storage object was physically removed. If cleanup
--      later failed, the registry had no surviving ref pointing at
--      the orphan object.
--   2. Draft replacement never compared old vs new path, so the
--      helper superseded + inserted a new ref even on a no-op
--      path update, inflating the registry and enqueuing redundant
--      cleanup rows.
--
-- This migration is forward-only. All RPC signatures unchanged.
-- ============================================================


-- ============================================================
-- A. Widen storage_object_refs.status CHECK to include pending_delete
-- ============================================================
-- The prior migration (20260725170000) defined status with an inline
-- CHECK:  status text ... check (status in ('active', 'superseded', 'deleted'))
-- PostgreSQL auto-names inline CHECKs as <table>_<column>_check, so
-- the constraint is named storage_object_refs_status_check.
--
-- The DO block below tries to drop any status CHECK by regex match
-- on pg_get_constraintdef. But pg_get_constraintdef may render the
-- predicate as  ((status)::text = ANY ((ARRAY[...])::text[]))  which
-- does NOT match the 'status\s+in\s*\(' regex, so the DO block can
-- miss it. We therefore ALSO drop by the explicit auto-generated name
-- before ADD CONSTRAINT, guaranteeing no duplicate-name collision.
do $$
declare
  v_constraint_name text;
begin
  for v_constraint_name in
    select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = c.connamespace
      where n.nspname = 'public'
        and t.relname = 'storage_object_refs'
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) ~* 'status'
  loop
    execute format('alter table public.storage_object_refs drop constraint if exists %I', v_constraint_name);
  end loop;
end;
$$;

-- Explicit name-based drop as a belt-and-suspenders guarantee:
-- the auto-generated inline CHECK name is deterministic, so drop it
-- directly to avoid 'constraint already exists' on ADD CONSTRAINT.
alter table public.storage_object_refs
  drop constraint if exists storage_object_refs_status_check;

alter table public.storage_object_refs
  add constraint storage_object_refs_status_check
  check (status in ('active', 'superseded', 'pending_delete', 'deleted'));

create index if not exists storage_object_refs_pending_delete_idx
  on public.storage_object_refs(bucket, object_path)
  where status = 'pending_delete';


-- ============================================================
-- B. mark_storage_object_refs_pending_delete helper
-- ============================================================
-- Transitions all 'active' refs for (owner_type, owner_id) [and role]
-- to 'pending_delete'. Does NOT touch 'superseded' or 'deleted' rows.
create or replace function public.mark_storage_object_refs_pending_delete(
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
    raise exception 'mark_storage_object_refs_pending_delete: required arg is null'
      using errcode = '22004';
  end if;
  if p_role is not null then
    update public.storage_object_refs
      set status = 'pending_delete', updated_at = now()
      where owner_type = p_owner_type
        and owner_id = p_owner_id
        and role = p_role
        and status = 'active';
  else
    update public.storage_object_refs
      set status = 'pending_delete', updated_at = now()
      where owner_type = p_owner_type
        and owner_id = p_owner_id
        and status = 'active';
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_storage_object_refs_pending_delete(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_storage_object_refs_pending_delete(text, uuid, text)
  to service_role;


-- ============================================================
-- C. register_storage_object_ref — supersede-only, no enqueue
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged.
-- Helper ONLY supersedes any existing active ref and inserts a new
-- active ref. It does NOT enqueue cleanup — the caller is
-- responsible for enqueuing cleanup for the superseded ref's object
-- when applicable, in the same transaction.
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
-- D. save_product_asset_draft — pending_delete on path change
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged.
-- UPDATE path: compares old vs new source_object_path.
--   * If changed: pending_delete old 'source' ref, enqueue old
--     private object, register new 'source' ref as active.
--   * If unchanged: leave existing ref alone, refresh metadata.
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
  v_cleanup_id uuid;
  v_path_changed boolean;
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

    v_path_changed := coalesce(v_existing.source_object_path, '') <> p_source_object_path;

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
      publish_status = 'draft',
      publish_error_code = null
    where id = p_id;

    if v_path_changed then
      perform public.mark_storage_object_refs_pending_delete(
        p_owner_type := 'product_asset',
        p_owner_id := p_id,
        p_role := 'source'
      );

      if v_existing.source_bucket = 'private-assets'
         and v_existing.source_object_path is not null
         and btrim(v_existing.source_object_path) <> '' then
        v_cleanup_id := public.enqueue_storage_cleanup(
          p_bucket := 'private-assets',
          p_object_path := v_existing.source_object_path,
          p_reason := 'replaced',
          p_source_type := 'catalog_asset',
          p_source_id := p_id
        );
      end if;

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
    else
      update public.storage_object_refs
        set mime_type = coalesce(p_mime_type, mime_type),
            size_bytes = coalesce(p_file_size, size_bytes),
            sha256 = coalesce(p_sha256, sha256),
            updated_at = now()
        where owner_type = 'product_asset'
          and owner_id = p_id
          and role = 'source'
          and status = 'active';
      select id into v_ref_id
        from public.storage_object_refs
        where owner_type = 'product_asset'
          and owner_id = p_id
          and role = 'source'
          and status = 'active'
        limit 1;
    end if;

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
        'old_source_object_path', v_existing.source_object_path,
        'path_changed', v_path_changed,
        'cleanup_id', v_cleanup_id,
        'storage_object_ref_id', v_ref_id
      )
    );

    return jsonb_build_object(
      'status', 'updated',
      'id', p_id,
      'storage_object_ref_id', v_ref_id,
      'cleanup_id', v_cleanup_id,
      'path_changed', v_path_changed,
      'updated_at', (select updated_at from public.product_assets where id = p_id)
    );
  end if;

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
-- END Part 1 placeholder replaced — continue in next sections via appends


-- ============================================================
-- E. save_certificate_draft — pending_delete on path change
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged.
-- UPDATE path mirrors save_product_asset_draft:
--   * path changed: pending_delete old 'source' ref, enqueue old
--     private object, register new 'source' ref as active.
--   * path unchanged: refresh metadata on the existing active ref.
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
  v_cleanup_id uuid;
  v_path_changed boolean;
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

    v_path_changed := coalesce(v_existing.source_object_path, '') <> p_source_object_path;

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

    if v_path_changed then
      perform public.mark_storage_object_refs_pending_delete(
        p_owner_type := 'certificate',
        p_owner_id := p_id,
        p_role := 'source'
      );

      if v_existing.source_bucket = 'private-assets'
         and v_existing.source_object_path is not null
         and btrim(v_existing.source_object_path) <> '' then
        v_cleanup_id := public.enqueue_storage_cleanup(
          p_bucket := 'private-assets',
          p_object_path := v_existing.source_object_path,
          p_reason := 'replaced',
          p_source_type := 'certificate',
          p_source_id := p_id
        );
      end if;

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
    else
      update public.storage_object_refs
        set mime_type = coalesce(p_mime_type, mime_type),
            size_bytes = coalesce(p_file_size, size_bytes),
            sha256 = coalesce(p_sha256, sha256),
            updated_at = now()
        where owner_type = 'certificate'
          and owner_id = p_id
          and role = 'source'
          and status = 'active';
      select id into v_ref_id
        from public.storage_object_refs
        where owner_type = 'certificate'
          and owner_id = p_id
          and role = 'source'
          and status = 'active'
        limit 1;
    end if;

    insert into public.admin_audit_log (
      actor_id, actor_email, actor_role, action, target_type, target_id,
      metadata
    ) values (
      p_actor_id, p_actor_email, p_actor_role,
      'certificate.draft_save',
      'certificate', p_id,
      jsonb_build_object(
        'source_bucket', p_source_bucket,
        'source_object_path', p_source_object_path,
        'old_source_object_path', v_existing.source_object_path,
        'path_changed', v_path_changed,
        'cleanup_id', v_cleanup_id,
        'storage_object_ref_id', v_ref_id
      )
    );

    return jsonb_build_object(
      'status', 'updated',
      'id', p_id,
      'storage_object_ref_id', v_ref_id,
      'cleanup_id', v_cleanup_id,
      'path_changed', v_path_changed,
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
      'source_bucket', p_source_bucket,
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
-- F. finalize_catalog_asset_publish — pending_delete source ref
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged.
-- The 'source' ref is now transitioned to 'pending_delete' (NOT
-- 'superseded') and the old private object is enqueued for cleanup.
-- The 'published' ref is registered as 'active'. If enqueue fails
-- the entire finalize + audit rolls back.
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

  -- Transition the 'source' ref to 'pending_delete' (the private draft
  -- object is about to be physically removed). Cleanup enqueue must
  -- succeed for the finalize to commit.
  perform public.mark_storage_object_refs_pending_delete(
    p_owner_type := 'product_asset',
    p_owner_id := v_row.id,
    p_role := 'source'
  );

  if v_old_source_path is not null
     and v_row.source_bucket = 'private-assets'
     and btrim(v_old_source_path) <> '' then
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
      'published_ref_id', v_published_ref_id,
      'old_source_path', v_old_source_path
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
-- G. finalize_certificate_publish — pending_delete source ref
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged.
-- Mirrors finalize_catalog_asset_publish: published ref active,
-- source ref pending_delete, source object enqueued for cleanup.
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

  perform public.mark_storage_object_refs_pending_delete(
    p_owner_type := 'certificate',
    p_owner_id := v_row.id,
    p_role := 'source'
  );

  if v_old_source_path is not null
     and v_row.source_bucket = 'private-assets'
     and btrim(v_old_source_path) <> '' then
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
      'published_ref_id', v_published_ref_id,
      'old_source_path', v_old_source_path
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
-- H. unpublish_catalog_asset — pending_delete published ref
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged.
-- The 'published' ref is transitioned to 'pending_delete' (NOT
-- 'deleted'); the public object is enqueued for cleanup. The ref
-- only becomes 'deleted' when complete_storage_cleanup succeeds.
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
  v_refs_pending integer;
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

  -- Transition the 'published' ref to 'pending_delete'. The 'source'
  -- ref stays in its current state so a future draft can re-publish.
  v_refs_pending := public.mark_storage_object_refs_pending_delete(
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
      'refs_pending_delete', v_refs_pending
    )
  );

  return jsonb_build_object(
    'status', 'unpublished',
    'id', p_id,
    'cleanup_id', v_cleanup_id,
    'refs_pending_delete', v_refs_pending,
    'updated_at', (select updated_at from public.product_assets where id = p_id)
  );
end;
$$;

revoke all on function public.unpublish_catalog_asset(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.unpublish_catalog_asset(uuid, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- I. unpublish_certificate — pending_delete published ref
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged.
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
  v_refs_pending integer;
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

  v_refs_pending := public.mark_storage_object_refs_pending_delete(
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
      'refs_pending_delete', v_refs_pending
    )
  );

  return jsonb_build_object(
    'status', 'unpublished',
    'id', p_id,
    'cleanup_id', v_cleanup_id,
    'refs_pending_delete', v_refs_pending,
    'updated_at', (select updated_at from public.certificates where id = p_id)
  );
end;
$$;

revoke all on function public.unpublish_certificate(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.unpublish_certificate(uuid, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- J. delete_product_asset_with_cleanup — pending_delete all refs
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged.
-- All active refs for the asset are transitioned to 'pending_delete'
-- BEFORE the business row is deleted, so the owner_id still joins.
-- The published + source objects are enqueued for cleanup. The refs
-- become 'deleted' only when complete_storage_cleanup succeeds.
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
  v_refs_pending integer;
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

  -- Mark ALL active refs (source + published) as 'pending_delete' so
  -- the cleanup dispatcher can transition them to 'deleted' once the
  -- underlying objects are physically removed.
  v_refs_pending := public.mark_storage_object_refs_pending_delete(
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
      'refs_pending_delete', v_refs_pending
    )
  );

  return jsonb_build_object(
    'status', 'deleted',
    'id', p_id,
    'cleanup_id_published', v_cleanup_id_published,
    'cleanup_id_source', v_cleanup_id_source,
    'refs_pending_delete', v_refs_pending
  );
end;
$$;

revoke all on function public.delete_product_asset_with_cleanup(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.delete_product_asset_with_cleanup(uuid, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- K. delete_certificate_with_cleanup — pending_delete all refs
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged.
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
  v_refs_pending integer;
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

  v_refs_pending := public.mark_storage_object_refs_pending_delete(
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
      'refs_pending_delete', v_refs_pending
    )
  );

  return jsonb_build_object(
    'status', 'deleted',
    'id', p_id,
    'cleanup_id_published', v_cleanup_id_published,
    'cleanup_id_source', v_cleanup_id_source,
    'refs_pending_delete', v_refs_pending
  );
end;
$$;

revoke all on function public.delete_certificate_with_cleanup(uuid, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.delete_certificate_with_cleanup(uuid, timestamptz, uuid, text, text)
  to service_role;


-- ============================================================
-- L. complete_storage_cleanup — pending_delete -> deleted on success
-- ============================================================
-- Replaces the version in 20260725250000. Signature unchanged:
--   (uuid, uuid, boolean, text, uuid, text) returns text
--
-- On p_success=true with effective final_status='deleted', all
-- storage_object_refs rows whose (bucket, object_path) match the
-- cleanup queue row AND status IN ('active','superseded',
-- 'pending_delete') are atomically transitioned to 'deleted'.
--
-- When the effective final_status is one of the failure codes
-- ('blocked_referenced','reference_check_failed',
-- 'storage_delete_failed','audit_start_failed','dead_letter'), no
-- ref is written to 'deleted'.
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

    -- Only when the storage object was actually removed (final_status
    -- resolves to 'deleted') do we transition refs to 'deleted'. All
    -- active / superseded / pending_delete refs for the same object
    -- are merged into 'deleted' in one atomic UPDATE.
    if coalesce(v_final_status, 'deleted') = 'deleted' then
      update public.storage_object_refs
        set status = 'deleted', updated_at = now()
        where bucket = v_row.bucket
          and object_path = v_row.object_path
          and status in ('active', 'superseded', 'pending_delete');
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
    -- dead_letter is a failure terminal state: refs must remain in
    -- their pending_delete / superseded state so they can be retried
    -- or investigated. Do NOT mark them 'deleted'.
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
-- M. Deprecate mark_storage_object_refs_deleted (no callers)
-- ============================================================
-- The 20260725250000 helper mark_storage_object_refs_deleted is no
-- longer called by any RPC after this migration. We keep the
-- function body intact (no DROP) so existing test scaffolding that
-- may reference it does not break, but new code MUST use
-- mark_storage_object_refs_pending_delete instead. The 'deleted'
-- transition is now exclusively owned by complete_storage_cleanup.
-- ============================================================


-- ============================================================
-- N. Migration-time assertions
-- ============================================================
do $$
declare
  v_cleanup_count integer;
  v_helper_count integer;
  v_pending_helper_count integer;
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
  -- must both still exist (we did not drop them).
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

  -- mark_storage_object_refs_pending_delete must exist with the
  -- expected 3-arg signature.
  select count(*)
    into v_pending_helper_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'mark_storage_object_refs_pending_delete';
  if v_pending_helper_count <> 1 then
    raise exception
      'mark_storage_object_refs_pending_delete must exist exactly once, found %',
      v_pending_helper_count
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
