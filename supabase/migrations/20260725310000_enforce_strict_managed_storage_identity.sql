-- ============================================================
-- Migration 20260725310000
-- Enforce strict managed storage identity (kill loose URL parser)
-- ============================================================
-- Round-4 security hardening. The loose URL parser
-- `extract_managed_storage_path(p_url)` used `position(prefix in
-- p_url)` to detect managed URLs. That accepted ANY URL whose path
-- contained the storage prefix, regardless of host:
--
--   https://attacker.example/path/storage/v1/object/public/public-assets/company/logo.png
--
-- would be classified as a managed object. An attacker who could
-- inject that URL into a product's cover_image_url would cause the
-- cleanup dispatcher to DELETE the real `company/logo.png` from the
-- public-assets bucket when the attacker URL was later replaced.
--
-- This migration introduces a strict parser that validates scheme,
-- host, port, userinfo, and fragment before extracting the path, and
-- a trusted config column on site_settings that supplies the allowed
-- host. The loose parser is retained ONLY as a read-only inventory
-- helper; the write and delete paths now use the strict parser
-- exclusively.
--
-- New / replaced functions:
--   * extract_managed_storage_path_strict(p_url, p_allowed_host)
--       — strict URL validation + path extraction.
--   * get_managed_storage_host()
--       — reads the trusted host from site_settings.
--   * register_managed_storage_ref_structured(...)
--       — accepts bucket + object_path directly (no URL parsing).
--   * register_managed_storage_ref_from_url(...)  [REPLACED]
--       — now calls the strict parser with the trusted host.
--   * enqueue_managed_storage_cleanup(...)         [REPLACED]
--       — now calls the strict parser with the trusted host.
--   * check_storage_object_referenced(...)         [REPLACED]
--       — now extracts the path from each URL column via the strict
--         parser and compares it to p_object_path, so external URLs
--         with spoofed paths no longer block cleanup.
--
-- Forward-only. Signatures of replaced functions are unchanged.
-- ============================================================


-- ============================================================
-- A. Trusted config: managed_storage_host on site_settings
-- ============================================================
-- The allowed host (e.g. "<project-ref>.supabase.co") is stored here
-- and read by get_managed_storage_host(). It is writable only by
-- service_role (RLS on site_settings already enforces this). The
-- browser never sends this value — it is server-side config.
--
-- Default is empty (fail-closed): until an admin sets it, the strict
-- parser returns NULL for every URL and no managed objects are
-- recognized, so no cleanup runs and no refs are registered.
alter table public.site_settings
  add column if not exists managed_storage_host text default '';


-- ============================================================
-- B. get_managed_storage_host() helper
-- ============================================================
-- Returns the trusted host from the singleton site_settings row.
-- Returns NULL if the row does not exist or the column is empty.
create or replace function public.get_managed_storage_host()
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_host text;
begin
  select managed_storage_host into v_host
    from public.site_settings
    limit 1;
  if v_host is null or btrim(v_host) = '' then
    return null;
  end if;
  return btrim(v_host);
end;
$$;

revoke all on function public.get_managed_storage_host()
  from public, anon, authenticated;
grant execute on function public.get_managed_storage_host()
  to service_role;


-- ============================================================
-- C. extract_managed_storage_path_strict(p_url, p_allowed_host)
-- ============================================================
-- Strict URL validation. Returns the managed object path if ALL of
-- the following hold, otherwise NULL:
--
--   1. p_url starts with 'https://' (no http, no other schemes).
--   2. The authority contains NO userinfo (no '@').
--   3. The host portion EXACTLY equals p_allowed_host (no subdomain
--      spoofing, no case-insensitive match — DNS is case-insensitive
--      but we compare the literal string the operator configured).
--   4. The port is empty or exactly '443'.
--   5. There is NO fragment ('#...').
--   6. The path starts with '/storage/v1/object/public/public-assets/'.
--   7. The extracted path (after the prefix) is non-empty, does not
--      start with '/', does not contain '..' or backslash, and does
--      not contain control characters (0x00-0x1F, 0x7F).
--
-- The path is NOT URL-decoded. The storage layer accepts the raw
-- path component as-is. Decoding would risk introducing '..' or
-- other traversal sequences from double-encoded input.
--
-- p_allowed_host must come from trusted server config
-- (get_managed_storage_host()), never from the browser request body.
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
  v_after_scheme text;
  v_authority text;
  v_rest text;
  v_path text;
  v_host text;
  v_port text;
  v_prefix text := '/storage/v1/object/public/public-assets/';
  v_q integer;
  v_f integer;
  v_at integer;
  v_colon integer;
begin
  if p_url is null or btrim(p_url) = '' then
    return null;
  end if;
  if p_allowed_host is null or btrim(p_allowed_host) = '' then
    return null; -- fail-closed: no trusted host = no managed objects
  end if;

  -- 1. Scheme must be exactly 'https://'
  if not starts_with(p_url, 'https://') then
    return null;
  end if;
  v_after_scheme := substring(p_url from 9); -- skip 'https://'

  -- 2. Split authority and path/query/fragment.
  --    Authority ends at the first '/', '?', or '#'.
  v_authority := substring(v_after_scheme from '^([^/?#]*)');
  v_rest := substring(v_after_scheme from '^[^/?#]*([/?#].*)?$');

  -- 3. No userinfo allowed.
  v_at := position('@' in v_authority);
  if v_at > 0 then
    return null;
  end if;

  -- 4. Split host and port.
  v_colon := position(':' in v_authority);
  if v_colon > 0 then
    v_host := substring(v_authority from 1 for v_colon - 1);
    v_port := substring(v_authority from v_colon + 1);
    if v_port is null or v_port = '' then
      return null; -- stray colon
    end if;
    -- Port must be empty or '443'. We already have a non-empty port.
    if v_port <> '443' then
      return null;
    end if;
  else
    v_host := v_authority;
  end if;

  -- 5. Host must exactly equal the trusted host.
  if v_host <> p_allowed_host then
    return null;
  end if;

  -- 6. No fragment allowed.
  if v_rest is null or v_rest = '' then
    return null; -- no path at all
  end if;
  v_f := position('#' in v_rest);
  if v_f > 0 then
    return null; -- fragment present = reject
  end if;

  -- 7. Strip query string.
  v_path := v_rest;
  v_q := position('?' in v_path);
  if v_q > 0 then
    v_path := substring(v_path from 1 for v_q - 1);
  end if;

  -- 8. Path must start with the managed prefix.
  if not starts_with(v_path, v_prefix) then
    return null;
  end if;

  v_path := substring(v_path from length(v_prefix) + 1);

  -- 9. Validate the extracted path.
  if v_path is null or v_path = '' then
    return null;
  end if;
  if starts_with(v_path, '/') then
    return null; -- leading slash = absolute path = invalid
  end if;
  if position('..' in v_path) > 0 then
    return null; -- path traversal
  end if;
  if position('\' in v_path) > 0 then
    return null; -- backslash
  end if;
  -- Control characters (0x00-0x1F, 0x7F)
  if v_path ~ '[\x00-\x1f\x7f]' then
    return null;
  end if;

  return v_path;
end;
$$;

revoke all on function public.extract_managed_storage_path_strict(text, text)
  from public, anon, authenticated;
grant execute on function public.extract_managed_storage_path_strict(text, text)
  to service_role;


-- ============================================================
-- D. register_managed_storage_ref_structured (structured ref helper)
-- ============================================================
-- Accepts bucket + object_path directly, no URL parsing. Use this
-- when the caller already has the structured representation (e.g.
-- the upload API returned {bucket, objectPath, source: 'managed'}).
--
-- Validates:
--   * bucket is 'public-assets' or 'private-assets'
--   * object_path is non-empty, no leading '/', no '..', no backslash,
--     no control chars
--
-- Returns the storage_object_refs.id of the new active ref, or NULL.
create or replace function public.register_managed_storage_ref_structured(
  p_owner_type text,
  p_owner_id uuid,
  p_role text,
  p_bucket text,
  p_object_path text,
  p_visibility text default 'public',
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
  v_ref_id uuid;
begin
  if p_owner_type is null or p_owner_id is null or p_role is null
     or p_bucket is null or p_object_path is null then
    return null;
  end if;
  if btrim(p_object_path) = '' then
    return null;
  end if;
  -- Bucket whitelist
  if p_bucket not in ('public-assets', 'private-assets') then
    return null;
  end if;
  -- Path validation
  if starts_with(p_object_path, '/') then
    return null;
  end if;
  if position('..' in p_object_path) > 0 then
    return null;
  end if;
  if position('\' in p_object_path) > 0 then
    return null;
  end if;
  if p_object_path ~ '[\x00-\x1f\x7f]' then
    return null;
  end if;

  v_ref_id := public.register_storage_object_ref(
    p_owner_type := p_owner_type,
    p_owner_id := p_owner_id,
    p_role := p_role,
    p_bucket := p_bucket,
    p_object_path := p_object_path,
    p_visibility := p_visibility,
    p_mime_type := p_mime_type,
    p_size_bytes := p_size_bytes,
    p_sha256 := p_sha256
  );
  return v_ref_id;
end;
$$;

revoke all on function public.register_managed_storage_ref_structured(
  text, uuid, text, text, text, text, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.register_managed_storage_ref_structured(
  text, uuid, text, text, text, text, text, bigint, text
) to service_role;


-- ============================================================
-- E. register_managed_storage_ref_from_url [REPLACED — strict]
-- ============================================================
-- Same signature as the round-2 version. Behavioral change: now
-- calls extract_managed_storage_path_strict with the trusted host
-- from get_managed_storage_host(). External URLs, spoofed-host URLs,
-- non-https URLs, userinfo URLs, and non-443-port URLs all return
-- NULL and are NOT registered.
create or replace function public.register_managed_storage_ref_from_url(
  p_owner_type text,
  p_owner_id uuid,
  p_role text,
  p_url text,
  p_visibility text default 'public',
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
  v_host text;
  v_path text;
  v_ref_id uuid;
begin
  if p_owner_type is null or p_owner_id is null or p_role is null
     or p_url is null or btrim(p_url) = '' then
    return null;
  end if;

  v_host := public.get_managed_storage_host();
  if v_host is null then
    return null; -- fail-closed: no trusted host configured
  end if;

  v_path := public.extract_managed_storage_path_strict(p_url, v_host);
  if v_path is null or btrim(v_path) = '' then
    return null; -- external URL or spoofed host -> not managed
  end if;

  v_ref_id := public.register_storage_object_ref(
    p_owner_type := p_owner_type,
    p_owner_id := p_owner_id,
    p_role := p_role,
    p_bucket := 'public-assets',
    p_object_path := v_path,
    p_visibility := p_visibility,
    p_mime_type := p_mime_type,
    p_size_bytes := p_size_bytes,
    p_sha256 := p_sha256
  );
  return v_ref_id;
end;
$$;

revoke all on function public.register_managed_storage_ref_from_url(
  text, uuid, text, text, text, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.register_managed_storage_ref_from_url(
  text, uuid, text, text, text, text, bigint, text
) to service_role;


-- ============================================================
-- F. enqueue_managed_storage_cleanup [REPLACED — strict]
-- ============================================================
-- Same signature. Behavioral change: now calls
-- extract_managed_storage_path_strict with the trusted host. External
-- URLs and spoofed-host URLs are NOT enqueued for cleanup — this
-- closes the data-loss vector where an attacker injects a spoofed
-- URL and the dispatcher later deletes the real managed object.
create or replace function public.enqueue_managed_storage_cleanup(
  p_url text,
  p_reason text,
  p_source_type text default null,
  p_source_id uuid default null
) returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_host text;
  v_path text;
  v_id uuid;
begin
  if p_url is null or btrim(p_url) = '' then
    return null;
  end if;

  v_host := public.get_managed_storage_host();
  if v_host is null then
    return null; -- fail-closed: no trusted host = no cleanup
  end if;

  v_path := public.extract_managed_storage_path_strict(p_url, v_host);
  if v_path is null or btrim(v_path) = '' then
    return null; -- external URL or spoofed host -> no cleanup
  end if;

  v_id := public.enqueue_storage_cleanup(
    p_bucket := 'public-assets',
    p_object_path := v_path,
    p_reason := p_reason,
    p_source_type := p_source_type,
    p_source_id := p_source_id
  );
  return v_id;
end;
$$;

revoke all on function public.enqueue_managed_storage_cleanup(text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_managed_storage_cleanup(text, text, text, uuid)
  to service_role;


-- ============================================================
-- G. check_storage_object_referenced [REPLACED — strict]
-- ============================================================
-- Same signature (text, text) -> boolean. Behavioral change: instead
-- of LIKE-matching the raw URL columns (which let external URLs with
-- spoofed paths block cleanup), this version extracts the managed
-- path from each URL via the strict parser and compares it to
-- p_object_path. External URLs return NULL from the strict parser
-- and are ignored, so they can no longer block cleanup of real
-- managed objects.
--
-- If no trusted host is configured, the function returns TRUE
-- (fail-closed: refuse to delete) to prevent the dispatcher from
-- deleting objects when identity cannot be verified.
create or replace function public.check_storage_object_referenced(
  p_bucket text,
  p_object_path text
) returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_host text;
  v_count integer;
begin
  if p_object_path is null or length(p_object_path) = 0 then
    return true; -- refuse delete if path is invalid
  end if;

  v_host := public.get_managed_storage_host();
  if v_host is null then
    return true; -- fail-closed: no trusted host = refuse to delete
  end if;

  -- products.cover_image_url / video_url
  select count(*) into v_count from public.products
    where public.extract_managed_storage_path_strict(cover_image_url, v_host) = p_object_path
       or public.extract_managed_storage_path_strict(video_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  -- product_images.image_url
  select count(*) into v_count from public.product_images
    where public.extract_managed_storage_path_strict(image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  -- product_assets.file_url / cover_image_url
  select count(*) into v_count from public.product_assets
    where public.extract_managed_storage_path_strict(file_url, v_host) = p_object_path
       or public.extract_managed_storage_path_strict(cover_image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  -- certificates.image_url
  select count(*) into v_count from public.certificates
    where public.extract_managed_storage_path_strict(image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  -- projects.cover_image_url
  select count(*) into v_count from public.projects
    where public.extract_managed_storage_path_strict(cover_image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  -- project_images.image_url
  select count(*) into v_count from public.project_images
    where public.extract_managed_storage_path_strict(image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  -- company_profile.logo_url / wechat_qr_url
  select count(*) into v_count from public.company_profile
    where public.extract_managed_storage_path_strict(logo_url, v_host) = p_object_path
       or public.extract_managed_storage_path_strict(wechat_qr_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  -- site_settings.default_og_image_url
  select count(*) into v_count from public.site_settings
    where public.extract_managed_storage_path_strict(default_og_image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  return false;
end;
$$;

revoke all on function public.check_storage_object_referenced(text, text)
  from public, anon, authenticated;
grant execute on function public.check_storage_object_referenced(text, text)
  to service_role;
