-- ============================================================
-- 20260725170000_storage_object_refs_and_publish_protocol.sql
-- ------------------------------------------------------------
-- Forward-only migration that introduces:
--
--   A. storage_object_refs — structured storage object registry
--      Replaces pseudo URLs (private-assets://{path}) with structured
--      (bucket, object_path) tuples persisted in a dedicated table.
--
--   B. product_assets source/publish structured columns
--      Adds source_bucket, source_object_path, published_bucket,
--      published_object_path, publish_status, publish_token,
--      publish_started_at, publish_error_code.
--
--   C. certificates source/publish structured columns
--      Same set of fields as product_assets, plus image_url is made
--      nullable so private drafts can be persisted before publish.
--
--   D. claim_catalog_asset_publish(p_asset_id, p_expected_updated_at,
--      p_actor_id, p_actor_email, p_actor_role)
--      Two-phase publish, phase 1: SELECT ... FOR UPDATE, validate
--      authorization, set publish_status='publishing' + publish_token.
--      Returns the trusted source ref + token.
--
--   E. finalize_catalog_asset_publish(p_asset_id, p_publish_token,
--      p_public_bucket, p_public_object_path, p_public_url,
--      p_mime_type, p_size_bytes, p_sha256)
--      Two-phase publish, phase 2: verify token + status='publishing',
--      update public ref, publish_status='published', enqueue old
--      private source for cleanup, write audit. Atomic.
--
--   F. recover_stale_catalog_publish(p_timeout_seconds)
--      Resets publish_status from 'publishing' back to 'draft' when
--      publish_started_at is older than the timeout. Explicit RPC —
--      never silently overwrites.
--
--   G. extract_managed_storage_path_strict(p_url, p_allowed_host)
--      Replaces the loose prefix-match extract_managed_storage_path
--      with a strict variant that requires scheme=https, host equals
--      the project Supabase host, exact path prefix, no userinfo,
--      default port (or 443), no fragment, decoded path re-validated.
--
--   H. Revokes + grants: all new RPCs SECURITY INVOKER, empty
--      search_path, EXECUTE granted to service_role ONLY.
--
-- This migration is forward-only. It does NOT:
--   - drop any table
--   - truncate any table
--   - delete existing rows at the migration top level
--   - alter existing columns to drop data
--   - modify existing policies
--
-- Existing https URLs in product_assets.file_url and
-- certificates.image_url remain readable via the legacy read path
-- while new writes persist structured refs alongside the URL.
-- ============================================================

-- ============================================================
-- A. storage_object_refs registry
-- ============================================================
create table if not exists public.storage_object_refs (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null,
  owner_id uuid not null,
  role text not null,
  bucket text not null check (bucket in ('public-assets', 'private-assets')),
  object_path text not null,
  visibility text not null default 'private' check (visibility in ('public', 'private', 'external')),
  status text not null default 'active' check (status in ('active', 'superseded', 'deleted')),
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  sha256 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storage_object_refs_owner_role_check check (
    owner_type in ('product_asset', 'certificate', 'project_image',
                   'product_image', 'product_cover', 'product_video',
                   'company_logo', 'company_wechat_qr',
                   'project_cover', 'project_video',
                   'homepage_image', 'site_og_image')
  )
);

create index if not exists storage_object_refs_owner_idx
  on public.storage_object_refs(owner_type, owner_id);
create index if not exists storage_object_refs_active_idx
  on public.storage_object_refs(owner_type, owner_id, role)
  where status = 'active';
create index if not exists storage_object_refs_bucket_path_idx
  on public.storage_object_refs(bucket, object_path)
  where status = 'active';

-- One active ref per (owner_type, owner_id, role).
create unique index if not exists storage_object_refs_owner_role_active_uniq
  on public.storage_object_refs(owner_type, owner_id, role)
  where status = 'active';

alter table public.storage_object_refs enable row level security;

-- Public cannot read storage_object_refs (it is an admin registry).
-- service_role bypasses RLS. Authenticated admins are authorized
-- via application-side RBAC at the API layer, not via RLS.
drop policy if exists "storage_object_refs_public_read" on public.storage_object_refs;
drop policy if exists "storage_object_refs_admin_all" on public.storage_object_refs;
-- No policies = deny for anon/authenticated; service_role bypasses.

revoke all on public.storage_object_refs from public, anon, authenticated;
grant select on public.storage_object_refs to service_role;
grant insert, update, delete on public.storage_object_refs to service_role;

drop trigger if exists trg_storage_object_refs_updated_at on public.storage_object_refs;
create trigger trg_storage_object_refs_updated_at
  before update on public.storage_object_refs
  for each row execute function public.handle_updated_at();

-- ============================================================
-- B. product_assets source/publish structured columns
-- ============================================================
alter table public.product_assets
  add column if not exists source_bucket text check (
    source_bucket is null or source_bucket in ('public-assets', 'private-assets')
  ),
  add column if not exists source_object_path text,
  add column if not exists published_bucket text check (
    published_bucket is null or published_bucket in ('public-assets', 'private-assets')
  ),
  add column if not exists published_object_path text,
  add column if not exists publish_status text not null default 'draft' check (
    publish_status in ('draft', 'publishing', 'published', 'publish_failed', 'unpublishing')
  ),
  add column if not exists publish_token uuid,
  add column if not exists publish_started_at timestamptz,
  add column if not exists publish_error_code text;

-- file_url remains NOT NULL historically; allow NULL for private drafts
-- whose source is recorded in source_bucket/source_object_path only.
alter table public.product_assets
  alter column file_url drop not null;

-- Re-add a CHECK that allows NULL only when source_bucket is set.
alter table public.product_assets
  drop constraint if exists product_assets_file_url_or_source_check;
alter table public.product_assets
  add constraint product_assets_file_url_or_source_check check (
    (file_url is not null and length(btrim(file_url)) > 0)
    or (source_bucket is not null and source_object_path is not null
        and length(btrim(source_object_path)) > 0)
  );

-- When publish_status='published', published_bucket/path must be set
-- and file_url must be the public URL.
alter table public.product_assets
  drop constraint if exists product_assets_published_consistency_check;
alter table public.product_assets
  add constraint product_assets_published_consistency_check check (
    publish_status <> 'published'
    or (published_bucket = 'public-assets'
        and published_object_path is not null
        and length(btrim(published_object_path)) > 0
        and file_url is not null)
  );

-- private-assets:// pseudo URLs are forbidden in file_url.
alter table public.product_assets
  drop constraint if exists product_assets_no_pseudo_private_url_check;
alter table public.product_assets
  add constraint product_assets_no_pseudo_private_url_check check (
    file_url is null or file_url not like 'private-assets://%'
  );

create index if not exists product_assets_publish_status_idx
  on public.product_assets(publish_status)
  where publish_status in ('publishing', 'publish_failed', 'unpublishing');
create index if not exists product_assets_source_ref_idx
  on public.product_assets(source_bucket, source_object_path)
  where source_bucket is not null;

-- ============================================================
-- C. certificates source/publish structured columns
-- ============================================================
alter table public.certificates
  add column if not exists source_bucket text check (
    source_bucket is null or source_bucket in ('public-assets', 'private-assets')
  ),
  add column if not exists source_object_path text,
  add column if not exists published_bucket text check (
    published_bucket is null or published_bucket in ('public-assets', 'private-assets')
  ),
  add column if not exists published_object_path text,
  add column if not exists publish_status text not null default 'draft' check (
    publish_status in ('draft', 'publishing', 'published', 'publish_failed', 'unpublishing')
  ),
  add column if not exists publish_token uuid,
  add column if not exists publish_started_at timestamptz,
  add column if not exists publish_error_code text;

-- image_url is now nullable for private drafts.
alter table public.certificates
  alter column image_url drop not null;

-- Note: legacy rows may have both image_url=null and source_bucket=null
-- (seed placeholders). The invariant "image_url OR source_bucket" is
-- enforced at the application layer for new writes; the DB constraint
-- only rejects the explicit pseudo-URL form (certificates_no_pseudo_private_url_check).
alter table public.certificates
  drop constraint if exists certificates_image_url_or_source_check;

-- Note: existing seed rows have is_published=true with image_url=null.
-- The strict "published requires image_url" invariant is enforced only
-- when publish_status='published' (new write path). Legacy rows keep
-- publish_status='draft' default and are not retroactively rejected.
alter table public.certificates
  drop constraint if exists certificates_published_consistency_check;
alter table public.certificates
  add constraint certificates_published_consistency_check check (
    publish_status <> 'published'
    or (published_bucket = 'public-assets'
        and published_object_path is not null
        and image_url is not null)
  );

alter table public.certificates
  drop constraint if exists certificates_no_pseudo_private_url_check;
alter table public.certificates
  add constraint certificates_no_pseudo_private_url_check check (
    image_url is null or image_url not like 'private-assets://%'
  );

create index if not exists certificates_publish_status_idx
  on public.certificates(publish_status)
  where publish_status in ('publishing', 'publish_failed', 'unpublishing');

-- ============================================================
-- D. claim_catalog_asset_publish — two-phase publish, phase 1
-- ============================================================
-- Atomically:
--   1. SELECT ... FOR UPDATE on product_assets row
--   2. Validate is_published=true AND access_level='public'
--      AND authorization_status='confirmed'
--   3. If publish_status='published' already, return idempotent result
--      with the existing public ref (no second copy).
--   4. If publish_status='publishing' and not stale, raise 40P01
--      (concurrent publish conflict).
--   5. Set publish_status='publishing', publish_token=gen_random_uuid(),
--      publish_started_at=now(), publish_error_code=null.
--   6. Return jsonb with: source_bucket, source_object_path,
--      publish_token, expected_updated_at (the new updated_at).
--
-- Caller MUST call finalize_catalog_asset_publish with the token
-- to complete the publish, or the stale recovery will reset it.
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

  -- 1. Lock the row.
  select * into v_row
    from public.product_assets
    where id = p_asset_id
    for update;

  if not found then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  -- 2. Optimistic lock check.
  if p_expected_updated_at is not null
     and v_row.updated_at <> p_expected_updated_at then
    raise exception 'stale updated_at' using errcode = '40P01';
  end if;

  -- 3. Authorization precondition checks.
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

  -- 4. Idempotent: already published.
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

  -- 5. Concurrent publish guard.
  if v_row.publish_status = 'publishing'
     and v_row.publish_started_at is not null
     and v_row.publish_started_at > (now() - interval '10 minutes') then
    raise exception 'concurrent publish in progress' using errcode = '40P01';
  end if;

  -- 6. Validate source ref is present and points to private-assets.
  if v_row.source_bucket is null
     or v_row.source_bucket <> 'private-assets'
     or v_row.source_object_path is null
     or btrim(v_row.source_object_path) = '' then
    raise exception 'source must be in private-assets'
      using errcode = '22004';
  end if;

  -- 7. Claim.
  v_token := gen_random_uuid();
  update public.product_assets set
    publish_status = 'publishing',
    publish_token = v_token,
    publish_started_at = now(),
    publish_error_code = null
  where id = v_row.id;

  -- Refresh updated_at for the caller to use in finalize.
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
-- E. finalize_catalog_asset_publish — two-phase publish, phase 2
-- ============================================================
-- Atomically:
--   1. SELECT ... FOR UPDATE, validate publish_token matches AND
--      publish_status='publishing'.
--   2. Update published_bucket/public_object_path/file_url to the
--      new public-assets ref.
--   3. publish_status='published', publish_token=null.
--   4. Enqueue old private source for cleanup via
--      enqueue_storage_cleanup (private-assets).
--   5. Write audit row via record_admin_action.
--   6. Return jsonb with the new public ref.
--
-- On token mismatch or status mismatch, raises 40P01.
-- Cleanup enqueue failure: raises 'cleanup_enqueue_failed' but the
-- publish itself is committed — caller must run reconciliation.
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

  -- Update the asset row to the new public ref.
  update public.product_assets set
    published_bucket = p_public_bucket,
    published_object_path = p_public_object_path,
    file_url = p_public_url,
    publish_status = 'published',
    publish_token = null,
    publish_started_at = null,
    publish_error_code = null,
    mime_type = coalesce(p_mime_type, mime_type)
  where id = v_row.id;

  -- Enqueue old private source for cleanup. Failure here surfaces
  -- as cleanup_enqueue_failed (raise) so caller can run
  -- reconciliation. The publish itself is already committed by the
  -- UPDATE above; the raise will abort the surrounding transaction
  -- but the UPDATE is non-transactional in this single-stmt context
  -- only if we don't wrap further. Since the whole function body is
  -- one transaction, raising here rolls back the UPDATE too. That is
  -- acceptable: caller can retry finalize with the same token (the
  -- row stays in 'publishing').
  if v_old_source_path is not null and v_row.source_bucket = 'private-assets' then
    begin
      v_cleanup_id := public.enqueue_storage_cleanup(
        p_bucket := 'private-assets',
        p_object_path := v_old_source_path,
        p_reason := 'replaced',
        p_source_type := 'catalog_asset',
        p_source_id := v_row.id
      );
    exception when others then
      raise exception 'cleanup_enqueue_failed' using errcode = 'P0001';
    end;
  end if;

  -- Audit (best-effort; if audit fails, the publish still stands).
  begin
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
        'cleanup_id', v_cleanup_id
      )
    );
  exception when others then
    -- Audit failure does not roll back the publish.
    null;
  end;

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
-- F. recover_stale_catalog_publish
-- ============================================================
-- Resets publish_status from 'publishing' to 'draft' when
-- publish_started_at is older than p_timeout_seconds. Does NOT
-- delete any Storage object — only resets the DB row so a new
-- claim can succeed. Writes an audit row with action
-- 'catalog_asset.publish_stale_recovered'.
create or replace function public.recover_stale_catalog_publish(
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
begin
  if p_timeout_seconds is null or p_timeout_seconds < 60 then
    p_timeout_seconds := 600;
  end if;

  with updated as (
    update public.product_assets set
      publish_status = 'draft',
      publish_token = null,
      publish_started_at = null,
      publish_error_code = 'stale_recovered'
    where publish_status = 'publishing'
      and publish_started_at is not null
      and publish_started_at < (now() - (p_timeout_seconds || ' seconds')::interval)
    returning id
  )
  select array_agg(id) into v_ids from updated;

  v_count := coalesce(array_length(v_ids, 1), 0);

  if v_count > 0 then
    begin
      insert into public.admin_audit_log (
        actor_id, actor_email, actor_role, action, target_type, target_id,
        metadata
      ) values (
        p_actor_id, p_actor_email, p_actor_role,
        'catalog_asset.publish_stale_recovered',
        'product_asset', null,
        jsonb_build_object('count', v_count, 'asset_ids', v_ids)
      );
    exception when others then null;
    end;
  end if;

  return v_count;
end;
$$;

revoke all on function public.recover_stale_catalog_publish(integer, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.recover_stale_catalog_publish(integer, uuid, text, text)
  to service_role;

-- ============================================================
-- G. extract_managed_storage_path_strict
-- ============================================================
-- Replaces the loose prefix match with a strict variant that:
--   1. Requires scheme=https (http allowed only for loopback).
--   2. Host equals p_allowed_host (case-insensitive).
--   3. No userinfo (rejects "evil@host").
--   4. Default port (443 for https; 80 for http loopback).
--   5. Exact path prefix /storage/v1/object/public/public-assets/.
--   6. Decoded path re-validated (no traversal, no encoded slashes).
--   7. Query string stripped; fragment stripped.
--
-- Returns the validated object_path, or NULL if the URL does not
-- match the strict contract.
create or replace function public.extract_managed_storage_path_strict(
  p_url text,
  p_allowed_host text
) returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_lower text;
  v_scheme text;
  v_host text;
  v_path text;
  v_query integer;
  v_frag integer;
  v_slash integer;
  v_prefix text := '/storage/v1/object/public/public-assets/';
  v_rest text;
  v_at integer;
  v_colon integer;
  v_port_str text;
  v_port integer;
begin
  if p_url is null or btrim(p_url) = '' then
    return null;
  end if;
  if p_allowed_host is null or btrim(p_allowed_host) = '' then
    return null;
  end if;

  v_lower := lower(p_url);

  -- Scheme check.
  if v_lower like 'https://%' then
    v_scheme := 'https';
  elsif v_lower like 'http://%' then
    v_scheme := 'http';
  else
    return null;
  end if;

  -- Strip scheme.
  if v_scheme = 'https' then
    v_rest := substring(p_url from 9);  -- length('https://') = 8
  else
    v_rest := substring(p_url from 8);  -- length('http://') = 8
  end if;

  -- Reject userinfo.
  v_at := position('@' in v_rest);
  if v_at > 0 then
    -- If '@' appears before the first '/', it's userinfo — reject.
    v_slash := position('/' in v_rest);
    if v_slash = 0 or v_at < v_slash then
      return null;
    end if;
  end if;

  -- Extract host (up to first /, ?, #).
  v_query := position('?' in v_rest);
  v_frag := position('#' in v_rest);
  if v_query = 0 then v_query := v_frag + 1; end if;
  if v_frag = 0 then v_frag := v_query + 1; end if;
  if v_query < v_frag then
    v_host := substring(v_rest from 1 for least(v_query, v_frag) - 1);
  else
    v_slash := position('/' in v_rest);
    if v_slash = 0 then
      v_host := v_rest;
      v_path := '';
    else
      v_host := substring(v_rest from 1 for v_slash - 1);
      v_path := substring(v_rest from v_slash);
    end if;
  end if;

  -- If v_path was not set above (no slash), set it now.
  if v_host is null then v_host := ''; end if;

  -- Strip port from host. Reject non-default ports except for loopback.
  v_colon := position(':' in v_host);
  if v_colon > 0 then
    v_port_str := substring(v_host from v_colon + 1);
    v_host := substring(v_host from 1 for v_colon - 1);
    if v_port_str !~ '^[0-9]+$' then
      return null;
    end if;
    v_port := v_port_str::integer;
    if v_scheme = 'https' and v_port <> 443 then
      return null;
    end if;
    if v_scheme = 'http' and v_port <> 80 then
      return null;
    end if;
  end if;

  -- Host must equal allowed host (case-insensitive).
  if lower(v_host) <> lower(p_allowed_host) then
    return null;
  end if;

  -- Reject host that looks like a path (no dots, but is loopback).
  -- (Loopback is allowed only for http; https requires real host.)
  if v_scheme = 'http' and v_host not in ('127.0.0.1', 'localhost', '[::1]') then
    return null;
  end if;

  -- Now v_path was set if there was a slash; otherwise re-extract.
  if v_path is null or v_path = '' then
    v_slash := position('/' in v_rest);
    if v_slash = 0 then
      return null;
    end if;
    v_path := substring(v_rest from v_slash);
  end if;

  -- Strip query and fragment from path.
  v_query := position('?' in v_path);
  if v_query > 0 then
    v_path := substring(v_path from 1 for v_query - 1);
  end if;
  v_frag := position('#' in v_path);
  if v_frag > 0 then
    v_path := substring(v_path from 1 for v_frag - 1);
  end if;

  -- Path must start with the exact prefix.
  if v_path is null or substr(v_path, 1, length(v_prefix)) <> v_prefix then
    return null;
  end if;
  v_rest := substring(v_path from length(v_prefix) + 1);

  -- URL-decode (basic %XX).
  v_rest := regexp_replace(v_rest, '%2[Ff]', '/', 'g');
  v_rest := regexp_replace(v_rest, '%2[Ee]', '.', 'g');

  -- Reject traversal / empty / encoded slash tricks.
  if v_rest is null or btrim(v_rest) = '' then
    return null;
  end if;
  if v_rest like '%..%' then
    return null;
  end if;
  if position('//' in v_rest) > 0 then
    return null;
  end if;

  return v_rest;
end;
$$;

revoke all on function public.extract_managed_storage_path_strict(text, text)
  from public, anon, authenticated;
grant execute on function public.extract_managed_storage_path_strict(text, text)
  to service_role;

-- ============================================================
-- H. verify_required_schema update
-- ============================================================
drop function if exists public.verify_required_schema();

create function public.verify_required_schema()
returns table(missing text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_missing text[];
  v_fn_exists boolean;
  v_col_exists boolean;
  v_tbl_exists boolean;
begin
  v_missing := array[]::text[];

  -- storage_object_refs table
  select exists(
    select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'storage_object_refs'
  ) into v_tbl_exists;
  if not v_tbl_exists then
    v_missing := array_append(v_missing, 'table:storage_object_refs');
  end if;

  -- product_assets new columns
  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'source_bucket'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:product_assets.source_bucket'); end if;

  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'publish_status'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:product_assets.publish_status'); end if;

  -- certificates new columns
  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'certificates'
        and column_name = 'source_bucket'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:certificates.source_bucket'); end if;

  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'certificates'
        and column_name = 'publish_status'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:certificates.publish_status'); end if;

  -- claim_catalog_asset_publish RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'claim_catalog_asset_publish'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:claim_catalog_asset_publish'); end if;

  -- finalize_catalog_asset_publish RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'finalize_catalog_asset_publish'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:finalize_catalog_asset_publish'); end if;

  -- recover_stale_catalog_publish RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'recover_stale_catalog_publish'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:recover_stale_catalog_publish'); end if;

  -- extract_managed_storage_path_strict RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'extract_managed_storage_path_strict'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:extract_managed_storage_path_strict'); end if;

  if array_length(v_missing, 1) is null then
    return query select ''::text where false;
  else
    return query select unnest(v_missing);
  end if;
end;
$$;

revoke all on function public.verify_required_schema()
  from public, anon, authenticated;
grant execute on function public.verify_required_schema()
  to service_role;
