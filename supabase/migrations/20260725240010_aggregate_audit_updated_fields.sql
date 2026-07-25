-- ============================================================
-- Phase 16 (Section 8): Fix jsonb_object_keys scalar subquery
--
-- Prior state (bug):
--   update_product_asset_metadata and update_certificate_metadata
--   both used:
--     jsonb_build_object('updated_fields',
--       (select jsonb_object_keys(v_payload)))
--
--   jsonb_object_keys returns a SETOF text. Used inside a scalar
--   subquery, PostgreSQL raises "more than one row returned by a
--   subquery used as an expression" whenever the payload has more
--   than one key. With 0 keys the result is NULL; with 1 key it
--   works by accident.
--
-- Fix:
--   Replace the scalar subquery with a sorted JSON array built via
--   jsonb_agg(key order by key). This produces stable, deterministic
--   audit metadata for any number of payload keys.
--
-- Safety contract (per function):
--   * language plpgsql
--   * security invoker
--   * set search_path = ''
--   * revoke from public/anon/authenticated
--   * grant execute to service_role only
--
-- Forward-only: this migration drops and recreates two functions
-- defined by 20260725190000. The signatures and behavior are
-- unchanged except for the audit metadata shape (which was broken
-- before). No table data is altered.
-- This migration is NOT executed in this commit.
-- ============================================================


-- ============================================================
-- A. Redefine update_product_asset_metadata with fixed audit metadata
-- ============================================================
drop function if exists public.update_product_asset_metadata(
  uuid, jsonb, timestamptz, uuid, text, text
);

create function public.update_product_asset_metadata(
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
  v_updated_fields jsonb;
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

  -- Build a stable, sorted JSON array of updated field names.
  -- jsonb_object_keys returns SETOF text; we aggregate into a JSON
  -- array ordered by key so the audit metadata is deterministic.
  select coalesce(
    (select jsonb_agg(key order by key)
       from jsonb_object_keys(v_payload) as key),
    '[]'::jsonb
  ) into v_updated_fields;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'catalog_asset.update_metadata',
    'product_asset', p_id,
    jsonb_build_object('updated_fields', v_updated_fields)
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
-- B. Redefine update_certificate_metadata with fixed audit metadata
-- ============================================================
drop function if exists public.update_certificate_metadata(
  uuid, jsonb, timestamptz, uuid, text, text
);

create function public.update_certificate_metadata(
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
  v_updated_fields jsonb;
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

  select coalesce(
    (select jsonb_agg(key order by key)
       from jsonb_object_keys(v_payload) as key),
    '[]'::jsonb
  ) into v_updated_fields;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id,
    metadata
  ) values (
    p_actor_id, p_actor_email, p_actor_role,
    'certificate.update_metadata',
    'certificate', p_id,
    jsonb_build_object('updated_fields', v_updated_fields)
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
-- C. Assert no remaining jsonb_object_keys scalar subquery patterns
-- ============================================================
-- This block scans pg_proc for any function body that still uses the
-- broken pattern. It only checks functions in the public schema.
-- (Best-effort: pg_get_functiondef text is checked with LIKE.)
do $$
declare
  v_fn text;
  v_def text;
  v_bad text;
begin
  for v_fn, v_def in
    select p.proname, pg_get_functiondef(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
  loop
    -- Detect the broken scalar subquery pattern.
    if v_def ~* '\(select\s+jsonb_object_keys\(' then
      raise exception
        'function % still uses jsonb_object_keys in a scalar subquery',
        v_fn
        using errcode = 'P0001';
    end if;
  end loop;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
