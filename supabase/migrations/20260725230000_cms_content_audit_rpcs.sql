-- ============================================================
-- Phase 15 (Section 7): CMS content transactional audit RPCs
-- -------------------------------------------------------------
-- This migration ADDS new forward-only RPCs that wrap INSERT/UPDATE
-- on the CMS "settings" tables in a single transaction with audit:
--
--   1. save_company_profile_with_audit
--   2. save_site_settings_with_audit
--   3. save_homepage_content_with_audit
--   4. save_page_content_with_audit
--   5. save_category_with_audit
--   6. delete_category_with_audit
--   7. save_subcategory_with_audit
--   8. delete_subcategory_with_audit
--
-- Why:
--   The admin UI was previously calling repository functions
--   directly from the browser Supabase client, bypassing the
--   trusted server boundary. These RPCs let the admin UI go
--   through /api/admin/* routes that:
--     - enforce admin session + RBAC
--     - enforce same-origin + Content-Type + body size
--     - validate fields
--     - call these transactional RPCs that write audit + enqueue
--       replaced storage objects for cleanup atomically.
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
--   * optimistic lock via p_expected_updated_at (required on update,
--     ignored on insert)
--
-- Forward-only: this migration only ADDS functions. It does not modify
-- existing tables, policies, or data.
-- This migration is NOT executed in this commit.
-- ============================================================

-- ============================================================
-- A. save_company_profile_with_audit
-- ============================================================
-- Single-row settings table. On insert: creates a new row. On update:
-- enforces optimistic lock via expected_updated_at.
--
-- Captures old logo_url + wechat_qr_url BEFORE update and enqueues
-- them for cleanup if they have changed (replacement scenario).
-- ============================================================
create or replace function public.save_company_profile_with_audit(
  p_id uuid,
  p_payload jsonb,
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
  v_existing public.company_profile%rowtype;
  v_old_logo_url text;
  v_old_wechat_qr_url text;
  v_id uuid;
  v_action text;
begin
  if p_payload is null then
    raise exception 'payload is required' using errcode = '22004';
  end if;

  if p_id is not null then
    -- UPDATE: optimistic lock via SELECT ... FOR UPDATE
    select * into v_existing
      from public.company_profile
      where id = p_id
      for update;

    if not found then
      raise exception 'company_profile not found' using errcode = 'P0002';
    end if;

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for update'
        using errcode = '22004';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    v_old_logo_url := v_existing.logo_url;
    v_old_wechat_qr_url := v_existing.wechat_qr_url;

    update public.company_profile set
      title_cn = nullif(p_payload->>'title_cn', ''),
      title_en = nullif(p_payload->>'title_en', ''),
      description_cn = nullif(p_payload->>'description_cn', ''),
      description_en = nullif(p_payload->>'description_en', ''),
      advantages_cn = p_payload->'advantages_cn',
      advantages_en = p_payload->'advantages_en',
      phone = nullif(p_payload->>'phone', ''),
      wechat = nullif(p_payload->>'wechat', ''),
      email = nullif(p_payload->>'email', ''),
      whatsapp = nullif(p_payload->>'whatsapp', ''),
      address_cn = nullif(p_payload->>'address_cn', ''),
      address_en = nullif(p_payload->>'address_en', ''),
      wechat_qr_url = nullif(p_payload->>'wechat_qr_url', ''),
      logo_url = nullif(p_payload->>'logo_url', '')
    where id = p_id;

    v_id := p_id;
    v_action := 'company_profile.update';

    -- Enqueue old managed storage objects for cleanup if replaced.
    if v_old_logo_url is not null
       and btrim(v_old_logo_url) <> ''
       and (p_payload->>'logo_url' is null
            or p_payload->>'logo_url' <> v_old_logo_url) then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_old_logo_url,
        p_reason := 'replaced',
        p_source_type := 'company_logo',
        p_source_id := v_id
      );
    end if;

    if v_old_wechat_qr_url is not null
       and btrim(v_old_wechat_qr_url) <> ''
       and (p_payload->>'wechat_qr_url' is null
            or p_payload->>'wechat_qr_url' <> v_old_wechat_qr_url) then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_old_wechat_qr_url,
        p_reason := 'replaced',
        p_source_type := 'company_wechat_qr',
        p_source_id := v_id
      );
    end if;
  else
    -- INSERT
    insert into public.company_profile (
      title_cn, title_en, description_cn, description_en,
      advantages_cn, advantages_en,
      phone, wechat, email, whatsapp,
      address_cn, address_en, wechat_qr_url, logo_url
    ) values (
      nullif(p_payload->>'title_cn', ''),
      nullif(p_payload->>'title_en', ''),
      nullif(p_payload->>'description_cn', ''),
      nullif(p_payload->>'description_en', ''),
      p_payload->'advantages_cn',
      p_payload->'advantages_en',
      nullif(p_payload->>'phone', ''),
      nullif(p_payload->>'wechat', ''),
      nullif(p_payload->>'email', ''),
      nullif(p_payload->>'whatsapp', ''),
      nullif(p_payload->>'address_cn', ''),
      nullif(p_payload->>'address_en', ''),
      nullif(p_payload->>'wechat_qr_url', ''),
      nullif(p_payload->>'logo_url', '')
    ) returning id into v_id;

    v_action := 'company_profile.create';
  end if;

  -- Atomic audit insert — same transaction as the business write.
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'company_profile',
    v_id::text,
    coalesce(p_payload->>'title_cn', '')
  );

  return jsonb_build_object(
    'id', v_id,
    'updated_at', (select updated_at from public.company_profile where id = v_id)
  );
end;
$$;

revoke all on function public.save_company_profile_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_company_profile_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) to service_role;

-- ============================================================
-- B. save_site_settings_with_audit
-- ============================================================
-- Single-row settings table. Captures old default_og_image_url BEFORE
-- update and enqueues it for cleanup if replaced.
-- ============================================================
create or replace function public.save_site_settings_with_audit(
  p_id uuid,
  p_payload jsonb,
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
  v_existing public.site_settings%rowtype;
  v_old_og_image_url text;
  v_id uuid;
  v_action text;
  v_default_language text;
begin
  if p_payload is null then
    raise exception 'payload is required' using errcode = '22004';
  end if;

  -- Validate required field: site_name
  if btrim(p_payload->>'site_name') is null then
    raise exception 'site_name is required' using errcode = '23502';
  end if;

  -- Validate default_language
  v_default_language := coalesce(nullif(p_payload->>'default_language', ''), 'zh');
  if v_default_language not in ('zh', 'en') then
    raise exception 'default_language must be zh or en' using errcode = '22004';
  end if;

  if p_id is not null then
    -- UPDATE: optimistic lock
    select * into v_existing
      from public.site_settings
      where id = p_id
      for update;

    if not found then
      raise exception 'site_settings not found' using errcode = 'P0002';
    end if;

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for update'
        using errcode = '22004';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    v_old_og_image_url := v_existing.default_og_image_url;

    update public.site_settings set
      site_name = p_payload->>'site_name',
      site_name_cn = nullif(p_payload->>'site_name_cn', ''),
      site_name_en = nullif(p_payload->>'site_name_en', ''),
      brand_name = nullif(p_payload->>'brand_name', ''),
      default_language = v_default_language,
      global_meta_title_cn = nullif(p_payload->>'global_meta_title_cn', ''),
      global_meta_title_en = nullif(p_payload->>'global_meta_title_en', ''),
      global_meta_description_cn = nullif(p_payload->>'global_meta_description_cn', ''),
      global_meta_description_en = nullif(p_payload->>'global_meta_description_en', ''),
      default_og_image_url = nullif(p_payload->>'default_og_image_url', ''),
      footer_text_cn = nullif(p_payload->>'footer_text_cn', ''),
      footer_text_en = nullif(p_payload->>'footer_text_en', ''),
      navigation_json = coalesce(p_payload->'navigation_json', '[]'::jsonb)
    where id = p_id;

    v_id := p_id;
    v_action := 'site_settings.update';

    -- Enqueue old OG image for cleanup if replaced.
    if v_old_og_image_url is not null
       and btrim(v_old_og_image_url) <> ''
       and (p_payload->>'default_og_image_url' is null
            or p_payload->>'default_og_image_url' <> v_old_og_image_url) then
      perform public.enqueue_managed_storage_cleanup(
        p_url := v_old_og_image_url,
        p_reason := 'replaced',
        p_source_type := 'site_og_image',
        p_source_id := v_id
      );
    end if;
  else
    -- INSERT
    insert into public.site_settings (
      site_name, site_name_cn, site_name_en, brand_name,
      default_language,
      global_meta_title_cn, global_meta_title_en,
      global_meta_description_cn, global_meta_description_en,
      default_og_image_url,
      footer_text_cn, footer_text_en,
      navigation_json
    ) values (
      p_payload->>'site_name',
      nullif(p_payload->>'site_name_cn', ''),
      nullif(p_payload->>'site_name_en', ''),
      nullif(p_payload->>'brand_name', ''),
      v_default_language,
      nullif(p_payload->>'global_meta_title_cn', ''),
      nullif(p_payload->>'global_meta_title_en', ''),
      nullif(p_payload->>'global_meta_description_cn', ''),
      nullif(p_payload->>'global_meta_description_en', ''),
      nullif(p_payload->>'default_og_image_url', ''),
      nullif(p_payload->>'footer_text_cn', ''),
      nullif(p_payload->>'footer_text_en', ''),
      coalesce(p_payload->'navigation_json', '[]'::jsonb)
    ) returning id into v_id;

    v_action := 'site_settings.create';
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'site_settings',
    v_id::text,
    coalesce(p_payload->>'site_name', '')
  );

  return jsonb_build_object(
    'id', v_id,
    'updated_at', (select updated_at from public.site_settings where id = v_id)
  );
end;
$$;

revoke all on function public.save_site_settings_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_site_settings_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) to service_role;

-- ============================================================
-- C. save_homepage_content_with_audit
-- ============================================================
-- Single-row content table. Enforces optimistic lock on update.
-- ============================================================
create or replace function public.save_homepage_content_with_audit(
  p_id uuid,
  p_payload jsonb,
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
  v_existing public.homepage_content%rowtype;
  v_id uuid;
  v_action text;
  v_is_active boolean;
begin
  if p_payload is null then
    raise exception 'payload is required' using errcode = '22004';
  end if;

  v_is_active := coalesce((p_payload->>'is_active')::boolean, true);

  if p_id is not null then
    -- UPDATE: optimistic lock
    select * into v_existing
      from public.homepage_content
      where id = p_id
      for update;

    if not found then
      raise exception 'homepage_content not found' using errcode = 'P0002';
    end if;

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for update'
        using errcode = '22004';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    update public.homepage_content set
      hero_eyebrow_cn = nullif(p_payload->>'hero_eyebrow_cn', ''),
      hero_eyebrow_en = nullif(p_payload->>'hero_eyebrow_en', ''),
      hero_title_cn = nullif(p_payload->>'hero_title_cn', ''),
      hero_title_en = nullif(p_payload->>'hero_title_en', ''),
      hero_highlight_cn = nullif(p_payload->>'hero_highlight_cn', ''),
      hero_highlight_en = nullif(p_payload->>'hero_highlight_en', ''),
      hero_description_cn = nullif(p_payload->>'hero_description_cn', ''),
      hero_description_en = nullif(p_payload->>'hero_description_en', ''),
      primary_cta_text_cn = nullif(p_payload->>'primary_cta_text_cn', ''),
      primary_cta_text_en = nullif(p_payload->>'primary_cta_text_en', ''),
      secondary_cta_text_cn = nullif(p_payload->>'secondary_cta_text_cn', ''),
      secondary_cta_text_en = nullif(p_payload->>'secondary_cta_text_en', ''),
      feature_section_title_cn = nullif(p_payload->>'feature_section_title_cn', ''),
      feature_section_title_en = nullif(p_payload->>'feature_section_title_en', ''),
      feature_section_subtitle_cn = nullif(p_payload->>'feature_section_subtitle_cn', ''),
      feature_section_subtitle_en = nullif(p_payload->>'feature_section_subtitle_en', ''),
      features_cn = coalesce(p_payload->'features_cn', '[]'::jsonb),
      features_en = coalesce(p_payload->'features_en', '[]'::jsonb),
      category_section_title_cn = nullif(p_payload->>'category_section_title_cn', ''),
      category_section_subtitle_cn = nullif(p_payload->>'category_section_subtitle_cn', ''),
      featured_products_title_cn = nullif(p_payload->>'featured_products_title_cn', ''),
      featured_products_subtitle_cn = nullif(p_payload->>'featured_products_subtitle_cn', ''),
      bottom_cta_title_cn = nullif(p_payload->>'bottom_cta_title_cn', ''),
      bottom_cta_title_en = nullif(p_payload->>'bottom_cta_title_en', ''),
      bottom_cta_description_cn = nullif(p_payload->>'bottom_cta_description_cn', ''),
      bottom_cta_description_en = nullif(p_payload->>'bottom_cta_description_en', ''),
      is_active = v_is_active
    where id = p_id;

    v_id := p_id;
    v_action := 'homepage_content.update';
  else
    -- INSERT
    insert into public.homepage_content (
      hero_eyebrow_cn, hero_eyebrow_en,
      hero_title_cn, hero_title_en,
      hero_highlight_cn, hero_highlight_en,
      hero_description_cn, hero_description_en,
      primary_cta_text_cn, primary_cta_text_en,
      secondary_cta_text_cn, secondary_cta_text_en,
      feature_section_title_cn, feature_section_title_en,
      feature_section_subtitle_cn, feature_section_subtitle_en,
      features_cn, features_en,
      category_section_title_cn, category_section_subtitle_cn,
      featured_products_title_cn, featured_products_subtitle_cn,
      bottom_cta_title_cn, bottom_cta_title_en,
      bottom_cta_description_cn, bottom_cta_description_en,
      is_active
    ) values (
      nullif(p_payload->>'hero_eyebrow_cn', ''),
      nullif(p_payload->>'hero_eyebrow_en', ''),
      nullif(p_payload->>'hero_title_cn', ''),
      nullif(p_payload->>'hero_title_en', ''),
      nullif(p_payload->>'hero_highlight_cn', ''),
      nullif(p_payload->>'hero_highlight_en', ''),
      nullif(p_payload->>'hero_description_cn', ''),
      nullif(p_payload->>'hero_description_en', ''),
      nullif(p_payload->>'primary_cta_text_cn', ''),
      nullif(p_payload->>'primary_cta_text_en', ''),
      nullif(p_payload->>'secondary_cta_text_cn', ''),
      nullif(p_payload->>'secondary_cta_text_en', ''),
      nullif(p_payload->>'feature_section_title_cn', ''),
      nullif(p_payload->>'feature_section_title_en', ''),
      nullif(p_payload->>'feature_section_subtitle_cn', ''),
      nullif(p_payload->>'feature_section_subtitle_en', ''),
      coalesce(p_payload->'features_cn', '[]'::jsonb),
      coalesce(p_payload->'features_en', '[]'::jsonb),
      nullif(p_payload->>'category_section_title_cn', ''),
      nullif(p_payload->>'category_section_subtitle_cn', ''),
      nullif(p_payload->>'featured_products_title_cn', ''),
      nullif(p_payload->>'featured_products_subtitle_cn', ''),
      nullif(p_payload->>'bottom_cta_title_cn', ''),
      nullif(p_payload->>'bottom_cta_title_en', ''),
      nullif(p_payload->>'bottom_cta_description_cn', ''),
      nullif(p_payload->>'bottom_cta_description_en', ''),
      v_is_active
    ) returning id into v_id;

    v_action := 'homepage_content.create';
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'homepage_content',
    v_id::text,
    coalesce(p_payload->>'hero_title_cn', '')
  );

  return jsonb_build_object(
    'id', v_id,
    'updated_at', (select updated_at from public.homepage_content where id = v_id)
  );
end;
$$;

revoke all on function public.save_homepage_content_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_homepage_content_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) to service_role;

-- ============================================================
-- D. save_page_content_with_audit
-- ============================================================
-- Multi-row content table (one row per page_key). Enforces optimistic
-- lock on update.
-- ============================================================
create or replace function public.save_page_content_with_audit(
  p_id uuid,
  p_payload jsonb,
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
  v_existing public.page_content%rowtype;
  v_id uuid;
  v_action text;
  v_page_key text;
begin
  if p_payload is null then
    raise exception 'payload is required' using errcode = '22004';
  end if;

  if p_id is not null then
    -- UPDATE: optimistic lock
    select * into v_existing
      from public.page_content
      where id = p_id
      for update;

    if not found then
      raise exception 'page_content not found' using errcode = 'P0002';
    end if;

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for update'
        using errcode = '22004';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    v_page_key := v_existing.page_key;

    update public.page_content set
      title_cn = nullif(p_payload->>'title_cn', ''),
      title_en = nullif(p_payload->>'title_en', ''),
      subtitle_cn = nullif(p_payload->>'subtitle_cn', ''),
      subtitle_en = nullif(p_payload->>'subtitle_en', ''),
      description_cn = nullif(p_payload->>'description_cn', ''),
      description_en = nullif(p_payload->>'description_en', ''),
      sections_cn = coalesce(p_payload->'sections_cn', '[]'::jsonb),
      sections_en = coalesce(p_payload->'sections_en', '[]'::jsonb),
      seo_title_cn = nullif(p_payload->>'seo_title_cn', ''),
      seo_title_en = nullif(p_payload->>'seo_title_en', ''),
      seo_description_cn = nullif(p_payload->>'seo_description_cn', ''),
      seo_description_en = nullif(p_payload->>'seo_description_en', '')
    where id = p_id;

    v_id := p_id;
    v_action := 'page_content.update';
  else
    -- INSERT: page_key is required
    v_page_key := p_payload->>'page_key';
    if btrim(v_page_key) is null then
      raise exception 'page_key is required for insert' using errcode = '22004';
    end if;

    insert into public.page_content (
      page_key,
      title_cn, title_en,
      subtitle_cn, subtitle_en,
      description_cn, description_en,
      sections_cn, sections_en,
      seo_title_cn, seo_title_en,
      seo_description_cn, seo_description_en
    ) values (
      v_page_key,
      nullif(p_payload->>'title_cn', ''),
      nullif(p_payload->>'title_en', ''),
      nullif(p_payload->>'subtitle_cn', ''),
      nullif(p_payload->>'subtitle_en', ''),
      nullif(p_payload->>'description_cn', ''),
      nullif(p_payload->>'description_en', ''),
      coalesce(p_payload->'sections_cn', '[]'::jsonb),
      coalesce(p_payload->'sections_en', '[]'::jsonb),
      nullif(p_payload->>'seo_title_cn', ''),
      nullif(p_payload->>'seo_title_en', ''),
      nullif(p_payload->>'seo_description_cn', ''),
      nullif(p_payload->>'seo_description_en', '')
    ) returning id into v_id;

    v_action := 'page_content.create';
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'page_content',
    v_id::text,
    v_page_key
  );

  return jsonb_build_object(
    'id', v_id,
    'updated_at', (select updated_at from public.page_content where id = v_id)
  );
end;
$$;

revoke all on function public.save_page_content_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_page_content_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) to service_role;

-- ============================================================
-- E. save_category_with_audit
-- ============================================================
-- Categories CRUD. Enforces optimistic lock on update.
-- ============================================================
create or replace function public.save_category_with_audit(
  p_id uuid,
  p_payload jsonb,
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
  v_existing public.categories%rowtype;
  v_id uuid;
  v_action text;
  v_name_cn text;
  v_slug text;
  v_sort_order integer;
  v_is_active boolean;
begin
  if p_payload is null then
    raise exception 'payload is required' using errcode = '22004';
  end if;

  v_name_cn := p_payload->>'name_cn';
  if btrim(v_name_cn) is null then
    raise exception 'name_cn is required' using errcode = '23502';
  end if;

  v_slug := p_payload->>'slug';
  if btrim(v_slug) is null then
    raise exception 'slug is required' using errcode = '23502';
  end if;

  v_sort_order := coalesce((p_payload->>'sort_order')::integer, 0);
  v_is_active := coalesce((p_payload->>'is_active')::boolean, true);

  if p_id is not null then
    select * into v_existing
      from public.categories
      where id = p_id
      for update;

    if not found then
      raise exception 'category not found' using errcode = 'P0002';
    end if;

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for update'
        using errcode = '22004';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    update public.categories set
      name_cn = v_name_cn,
      name_en = nullif(p_payload->>'name_en', ''),
      slug = v_slug,
      description_cn = nullif(p_payload->>'description_cn', ''),
      description_en = nullif(p_payload->>'description_en', ''),
      sort_order = v_sort_order,
      is_active = v_is_active
    where id = p_id;

    v_id := p_id;
    v_action := 'category.update';
  else
    insert into public.categories (
      name_cn, name_en, slug,
      description_cn, description_en,
      sort_order, is_active
    ) values (
      v_name_cn,
      nullif(p_payload->>'name_en', ''),
      v_slug,
      nullif(p_payload->>'description_cn', ''),
      nullif(p_payload->>'description_en', ''),
      v_sort_order,
      v_is_active
    ) returning id into v_id;

    v_action := 'category.create';
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'category',
    v_id::text,
    v_name_cn
  );

  return jsonb_build_object(
    'id', v_id,
    'updated_at', (select updated_at from public.categories where id = v_id)
  );
end;
$$;

revoke all on function public.save_category_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_category_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) to service_role;

-- ============================================================
-- F. delete_category_with_audit
-- ============================================================
-- Deletes a category atomically. CASCADE removes subcategories.
-- Enforces optimistic lock.
-- ============================================================
create or replace function public.delete_category_with_audit(
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
  v_existing public.categories%rowtype;
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required' using errcode = '22004';
  end if;

  select * into v_existing
    from public.categories
    where id = p_id
    for update;

  if not found then
    raise exception 'category not found' using errcode = 'P0002';
  end if;

  if v_existing.updated_at <> p_expected_updated_at then
    raise exception 'stale updated_at' using errcode = '40P01';
  end if;

  delete from public.categories where id = p_id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    'category.delete',
    'category',
    p_id::text,
    coalesce(v_existing.name_cn, '')
  );

  return p_id;
end;
$$;

revoke all on function public.delete_category_with_audit(
  uuid, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.delete_category_with_audit(
  uuid, timestamptz, uuid, text, text
) to service_role;

-- ============================================================
-- G. save_subcategory_with_audit
-- ============================================================
-- Subcategories CRUD. Enforces optimistic lock on update.
-- ============================================================
create or replace function public.save_subcategory_with_audit(
  p_id uuid,
  p_payload jsonb,
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
  v_existing public.subcategories%rowtype;
  v_id uuid;
  v_action text;
  v_name_cn text;
  v_slug text;
  v_category_id uuid;
  v_sort_order integer;
  v_is_active boolean;
begin
  if p_payload is null then
    raise exception 'payload is required' using errcode = '22004';
  end if;

  v_name_cn := p_payload->>'name_cn';
  if btrim(v_name_cn) is null then
    raise exception 'name_cn is required' using errcode = '23502';
  end if;

  v_slug := p_payload->>'slug';
  if btrim(v_slug) is null then
    raise exception 'slug is required' using errcode = '23502';
  end if;

  v_category_id := nullif(p_payload->>'category_id', '')::uuid;
  if v_category_id is null then
    raise exception 'category_id is required' using errcode = '23502';
  end if;

  v_sort_order := coalesce((p_payload->>'sort_order')::integer, 0);
  v_is_active := coalesce((p_payload->>'is_active')::boolean, true);

  if p_id is not null then
    select * into v_existing
      from public.subcategories
      where id = p_id
      for update;

    if not found then
      raise exception 'subcategory not found' using errcode = 'P0002';
    end if;

    if p_expected_updated_at is null then
      raise exception 'expected_updated_at is required for update'
        using errcode = '22004';
    end if;

    if v_existing.updated_at <> p_expected_updated_at then
      raise exception 'stale updated_at' using errcode = '40P01';
    end if;

    update public.subcategories set
      category_id = v_category_id,
      name_cn = v_name_cn,
      name_en = nullif(p_payload->>'name_en', ''),
      slug = v_slug,
      description_cn = nullif(p_payload->>'description_cn', ''),
      description_en = nullif(p_payload->>'description_en', ''),
      sort_order = v_sort_order,
      is_active = v_is_active
    where id = p_id;

    v_id := p_id;
    v_action := 'subcategory.update';
  else
    insert into public.subcategories (
      category_id, name_cn, name_en, slug,
      description_cn, description_en,
      sort_order, is_active
    ) values (
      v_category_id,
      v_name_cn,
      nullif(p_payload->>'name_en', ''),
      v_slug,
      nullif(p_payload->>'description_cn', ''),
      nullif(p_payload->>'description_en', ''),
      v_sort_order,
      v_is_active
    ) returning id into v_id;

    v_action := 'subcategory.create';
  end if;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'subcategory',
    v_id::text,
    v_name_cn
  );

  return jsonb_build_object(
    'id', v_id,
    'updated_at', (select updated_at from public.subcategories where id = v_id)
  );
end;
$$;

revoke all on function public.save_subcategory_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_subcategory_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) to service_role;

-- ============================================================
-- H. delete_subcategory_with_audit
-- ============================================================
create or replace function public.delete_subcategory_with_audit(
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
  v_existing public.subcategories%rowtype;
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22004';
  end if;
  if p_expected_updated_at is null then
    raise exception 'expected_updated_at is required' using errcode = '22004';
  end if;

  select * into v_existing
    from public.subcategories
    where id = p_id
    for update;

  if not found then
    raise exception 'subcategory not found' using errcode = 'P0002';
  end if;

  if v_existing.updated_at <> p_expected_updated_at then
    raise exception 'stale updated_at' using errcode = '40P01';
  end if;

  delete from public.subcategories where id = p_id;

  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    'subcategory.delete',
    'subcategory',
    p_id::text,
    coalesce(v_existing.name_cn, '')
  );

  return p_id;
end;
$$;

revoke all on function public.delete_subcategory_with_audit(
  uuid, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.delete_subcategory_with_audit(
  uuid, timestamptz, uuid, text, text
) to service_role;

-- ============================================================
-- I. Update verify_required_schema to include new RPCs
-- ============================================================
-- DROP FUNCTION first because the prior migration (20260725220000)
-- declared this function with `returns table(object_name text,
-- object_type text)`. PostgreSQL's CREATE OR REPLACE FUNCTION does
-- not allow changing the return type, so we drop and recreate (same
-- pattern as 20260725170000 / 20260725180000 / 20260725220000).
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

  -- CMS content RPCs (this migration)
  return query select 'save_company_profile_with_audit', 'function'::text;
  return query select 'save_site_settings_with_audit', 'function'::text;
  return query select 'save_homepage_content_with_audit', 'function'::text;
  return query select 'save_page_content_with_audit', 'function'::text;
  return query select 'save_category_with_audit', 'function'::text;
  return query select 'delete_category_with_audit', 'function'::text;
  return query select 'save_subcategory_with_audit', 'function'::text;
  return query select 'delete_subcategory_with_audit', 'function'::text;

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
