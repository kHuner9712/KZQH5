-- ============================================================
-- Phase 18 (Section 6): Unify Catalog/Certificate Source retention.
--
-- Background
-- ----------
-- The version frozen by 20260725261000 implemented this policy on
-- finalize_*_publish:
--
--   * published ref -> active
--   * source    ref -> pending_delete
--   * old private source object -> enqueued for physical cleanup
--     (storage_cleanup_queue, reason='replaced')
--
-- That policy deletes the Private Source object the moment the
-- asset is published. It is wrong for two reasons:
--
--   1. Republishing after Unpublish requires re-reading the private
--      source to regenerate the public derivative. If the source
--      has been physically deleted, republish fails with a 404 and
--      the only recovery is to re-upload the original — which the
--      CMS does not support from the published state.
--
--   2. Audit / reconciliation needs the original bytes to verify
--      the published derivative has not been tampered with. Once
--      the source is deleted, the sha256 in product_assets is the
--      only ground truth, and there is no way to re-derive it.
--
-- The unified policy across Catalog (product_assets) and
-- Certificate is:
--
--   * Publish    -> KEEP Private Source.
--                   source_bucket / source_object_path untouched.
--                   source ref STAYS active.
--                   NO enqueue_storage_cleanup for the source path.
--                   Only the published ref is registered (active).
--
--   * Unpublish  -> clean up the PUBLIC object only.
--                   published_bucket / published_object_path -> NULL.
--                   published ref -> pending_delete + enqueue cleanup.
--                   source ref STAYS active (already correct today).
--
--   * Draft replace -> clean up the OLD Private Source.
--                       source ref -> pending_delete + enqueue cleanup.
--                       Register a new active source ref.
--                       (Already correct today, unchanged.)
--
--   * Row delete  -> clean up BOTH source + published objects.
--                    (Already correct today, unchanged.)
--
-- This migration is forward-only. It uses CREATE OR REPLACE on the
-- two finalize_*_publish functions whose return types were already
-- frozen by 20260725170000, so the contract signatures do NOT change:
--   * finalize_catalog_asset_publish(uuid, uuid, text, text, text,
--                                     text, bigint, text, uuid, text, text)
--     -> jsonb
--   * finalize_certificate_publish(uuid, uuid, text, text, text,
--                                   text, bigint, text, uuid, text, text)
--     -> jsonb
--
-- Safety contract (per function, unchanged):
--   * language plpgsql
--   * security invoker
--   * set search_path = ''
--   * revoke from public/anon/authenticated
--   * grant execute to service_role only
-- ============================================================


-- ============================================================
-- A. finalize_catalog_asset_publish — KEEP source ref active
-- ============================================================
-- Same signature. The ONLY behavioral change vs the version in
-- 20260725261000 is:
--
--   * REMOVED: mark_storage_object_refs_pending_delete(p_role='source')
--   * REMOVED: enqueue_storage_cleanup for old private source path
--
-- Everything else is byte-identical: published ref registration,
-- the product_assets UPDATE, the audit log insert, and the return
-- jsonb shape (cleanup_id is now always NULL on the publish path —
-- kept in the result object for API backwards compatibility).
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
  v_result jsonb;
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

  -- Source retention policy: Publish does NOT touch source_bucket /
  -- source_object_path. The private source object is preserved so
  -- that republish (after Unpublish) can re-derive the public
  -- derivative, and so that audit reconciliation can re-verify the
  -- published sha256 against the original bytes.

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

  -- Intentionally NOT calling mark_storage_object_refs_pending_delete
  -- for p_role='source' and NOT enqueuing storage_cleanup for the
  -- old private source path. Source is retained for republish/audit.

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
      'source_retained', true,
      'source_bucket', v_row.source_bucket,
      'source_object_path', v_row.source_object_path,
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
    'cleanup_id', null,
    'source_retained', true,
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
-- B. finalize_certificate_publish — KEEP source ref active
-- ============================================================
-- Same signature. Same behavioral change as A: source ref stays
-- active, no enqueue_storage_cleanup for old private source.
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
  v_result jsonb;
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

  -- Source retention policy: Publish does NOT touch source_bucket /
  -- source_object_path. See policy rationale in section A above.

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

  -- Intentionally NOT calling mark_storage_object_refs_pending_delete
  -- for p_role='source' and NOT enqueuing storage_cleanup for the
  -- old private source path. Source is retained for republish/audit.

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
      'source_retained', true,
      'source_bucket', v_row.source_bucket,
      'source_object_path', v_row.source_object_path,
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
    'cleanup_id', null,
    'source_retained', true,
    'published_ref_id', v_published_ref_id
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.finalize_certificate_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_certificate_publish(uuid, uuid, text, text, text, text, bigint, text, uuid, text, text)
  to service_role;
