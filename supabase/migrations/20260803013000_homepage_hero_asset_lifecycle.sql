-- KZQ: close homepage Hero managed asset lifecycle.
-- 1. Treat homepage_content.hero_slides URLs as live Storage references.
-- 2. Allow the application to atomically claim the exact cleanup row created
--    by save_homepage_content_with_audit before deleting the obsolete object.

create or replace function public.check_storage_object_referenced(
  p_bucket text,
  p_object_path text
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_host text;
  v_count integer;
begin
  if p_object_path is null or length(p_object_path) = 0 then
    return true;
  end if;

  v_host := public.get_managed_storage_host();
  if v_host is null then
    return true;
  end if;

  select count(*) into v_count from public.products
    where public.extract_managed_storage_path_strict(cover_image_url, v_host) = p_object_path
       or public.extract_managed_storage_path_strict(video_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  select count(*) into v_count from public.product_images
    where public.extract_managed_storage_path_strict(image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  select count(*) into v_count from public.product_assets
    where public.extract_managed_storage_path_strict(file_url, v_host) = p_object_path
       or public.extract_managed_storage_path_strict(cover_image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  select count(*) into v_count from public.certificates
    where public.extract_managed_storage_path_strict(image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  select count(*) into v_count from public.projects
    where public.extract_managed_storage_path_strict(cover_image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  select count(*) into v_count from public.project_images
    where public.extract_managed_storage_path_strict(image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  select count(*) into v_count from public.company_profile
    where public.extract_managed_storage_path_strict(logo_url, v_host) = p_object_path
       or public.extract_managed_storage_path_strict(wechat_qr_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  select count(*) into v_count from public.site_settings
    where public.extract_managed_storage_path_strict(default_og_image_url, v_host) = p_object_path;
  if v_count > 0 then return true; end if;

  select count(*) into v_count
  from public.homepage_content h
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(h.hero_slides) = 'array' then h.hero_slides
      else '[]'::jsonb
    end
  ) as slide
  where public.extract_managed_storage_path_strict(
          nullif(slide->>'desktop_image_url', ''),
          v_host
        ) = p_object_path
     or public.extract_managed_storage_path_strict(
          nullif(slide->>'mobile_image_url', ''),
          v_host
        ) = p_object_path;
  if v_count > 0 then return true; end if;

  return false;
end;
$$;

revoke all on function public.check_storage_object_referenced(text, text)
  from public, anon, authenticated;
grant execute on function public.check_storage_object_referenced(text, text)
  to service_role;

create or replace function public.claim_storage_cleanup_object(
  p_bucket text,
  p_object_path text,
  p_stale_timeout_seconds integer default 300
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_safe_timeout integer := greatest(coalesce(p_stale_timeout_seconds, 300), 60);
  v_result jsonb;
begin
  if p_bucket not in ('public-assets', 'private-assets')
     or p_object_path is null
     or btrim(p_object_path) = '' then
    raise exception 'invalid cleanup object'
      using errcode = '22004';
  end if;

  with picked as (
    select id
    from public.storage_cleanup_queue
    where bucket = p_bucket
      and object_path = p_object_path
      and (
        (status in ('pending', 'retry') and next_retry_at <= now())
        or (
          status = 'claimed'
          and locked_at is not null
          and locked_at < now() - make_interval(secs => v_safe_timeout)
        )
      )
      and attempts < max_attempts
    order by next_retry_at, created_at
    limit 1
    for update skip locked
  ),
  marked as (
    update public.storage_cleanup_queue
    set status = 'claimed',
        lock_token = gen_random_uuid(),
        locked_at = now(),
        updated_at = now()
    where id in (select id from picked)
    returning id, bucket, object_path, lock_token
  )
  select to_jsonb(marked) into v_result
  from marked;

  return v_result;
end;
$$;

revoke all on function public.claim_storage_cleanup_object(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_storage_cleanup_object(text, text, integer)
  to service_role;
