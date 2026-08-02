-- ============================================================
-- 20260802193000_homepage_hero_carousel_and_copy.sql
-- ------------------------------------------------------------
-- Add an editable homepage hero carousel and complete localized copy
-- fields for the key homepage marketing sections.
--
-- Forward-only migration:
--   * adds nullable text columns and one jsonb column
--   * replaces the existing transactional homepage write RPC
--   * preserves strict optimistic locking and atomic audit
--   * queues removed managed hero images for asynchronous cleanup
-- ============================================================

alter table public.homepage_content
  add column if not exists hero_slides jsonb not null default '[]'::jsonb,
  add column if not exists category_section_title_en text,
  add column if not exists category_section_subtitle_en text,
  add column if not exists featured_products_title_en text,
  add column if not exists featured_products_subtitle_en text,
  add column if not exists certificates_section_title_cn text,
  add column if not exists certificates_section_title_en text,
  add column if not exists certificates_note_cn text,
  add column if not exists certificates_note_en text,
  add column if not exists projects_section_title_cn text,
  add column if not exists projects_section_title_en text,
  add column if not exists projects_section_subtitle_cn text,
  add column if not exists projects_section_subtitle_en text,
  add column if not exists bottom_cta_eyebrow_cn text,
  add column if not exists bottom_cta_eyebrow_en text,
  add column if not exists bottom_cta_button_text_cn text,
  add column if not exists bottom_cta_button_text_en text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.homepage_content'::regclass
      and conname = 'homepage_content_hero_slides_shape_check'
  ) then
    alter table public.homepage_content
      add constraint homepage_content_hero_slides_shape_check
      check (
        jsonb_typeof(hero_slides) = 'array'
        and jsonb_array_length(hero_slides) <= 5
      );
  end if;
end;
$$;

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
  v_hero_slides jsonb;
  v_old_slide jsonb;
  v_old_url text;
begin
  if p_payload is null then
    raise exception 'payload is required' using errcode = '22004';
  end if;

  v_is_active := coalesce((p_payload->>'is_active')::boolean, true);
  v_hero_slides := coalesce(p_payload->'hero_slides', '[]'::jsonb);

  if jsonb_typeof(v_hero_slides) <> 'array' then
    raise exception 'hero_slides must be an array' using errcode = '22004';
  end if;
  if jsonb_array_length(v_hero_slides) > 5 then
    raise exception 'hero_slides exceeds limit' using errcode = '22004';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_hero_slides) as slide
    where coalesce((slide->>'enabled')::boolean, true)
      and coalesce(btrim(slide->>'desktop_image_url'), '') = ''
  ) then
    raise exception 'enabled hero slide requires desktop_image_url'
      using errcode = '22004';
  end if;

  if p_id is not null then
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

    -- Queue managed hero images that are no longer referenced by any slide.
    for v_old_slide in
      select value
      from jsonb_array_elements(coalesce(v_existing.hero_slides, '[]'::jsonb))
    loop
      foreach v_old_url in array array[
        nullif(v_old_slide->>'desktop_image_url', ''),
        nullif(v_old_slide->>'mobile_image_url', '')
      ] loop
        if v_old_url is not null
          and not exists (
            select 1
            from jsonb_array_elements(v_hero_slides) as next_slide
            where next_slide->>'desktop_image_url' = v_old_url
               or next_slide->>'mobile_image_url' = v_old_url
          ) then
          perform public.enqueue_managed_storage_cleanup(
            p_url := v_old_url,
            p_reason := 'replaced',
            p_source_type := 'homepage_hero',
            p_source_id := p_id
          );
        end if;
      end loop;
    end loop;

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
      hero_slides = v_hero_slides,
      feature_section_title_cn = nullif(p_payload->>'feature_section_title_cn', ''),
      feature_section_title_en = nullif(p_payload->>'feature_section_title_en', ''),
      feature_section_subtitle_cn = nullif(p_payload->>'feature_section_subtitle_cn', ''),
      feature_section_subtitle_en = nullif(p_payload->>'feature_section_subtitle_en', ''),
      features_cn = coalesce(p_payload->'features_cn', '[]'::jsonb),
      features_en = coalesce(p_payload->'features_en', '[]'::jsonb),
      category_section_title_cn = nullif(p_payload->>'category_section_title_cn', ''),
      category_section_title_en = nullif(p_payload->>'category_section_title_en', ''),
      category_section_subtitle_cn = nullif(p_payload->>'category_section_subtitle_cn', ''),
      category_section_subtitle_en = nullif(p_payload->>'category_section_subtitle_en', ''),
      featured_products_title_cn = nullif(p_payload->>'featured_products_title_cn', ''),
      featured_products_title_en = nullif(p_payload->>'featured_products_title_en', ''),
      featured_products_subtitle_cn = nullif(p_payload->>'featured_products_subtitle_cn', ''),
      featured_products_subtitle_en = nullif(p_payload->>'featured_products_subtitle_en', ''),
      certificates_section_title_cn = nullif(p_payload->>'certificates_section_title_cn', ''),
      certificates_section_title_en = nullif(p_payload->>'certificates_section_title_en', ''),
      certificates_note_cn = nullif(p_payload->>'certificates_note_cn', ''),
      certificates_note_en = nullif(p_payload->>'certificates_note_en', ''),
      projects_section_title_cn = nullif(p_payload->>'projects_section_title_cn', ''),
      projects_section_title_en = nullif(p_payload->>'projects_section_title_en', ''),
      projects_section_subtitle_cn = nullif(p_payload->>'projects_section_subtitle_cn', ''),
      projects_section_subtitle_en = nullif(p_payload->>'projects_section_subtitle_en', ''),
      bottom_cta_eyebrow_cn = nullif(p_payload->>'bottom_cta_eyebrow_cn', ''),
      bottom_cta_eyebrow_en = nullif(p_payload->>'bottom_cta_eyebrow_en', ''),
      bottom_cta_title_cn = nullif(p_payload->>'bottom_cta_title_cn', ''),
      bottom_cta_title_en = nullif(p_payload->>'bottom_cta_title_en', ''),
      bottom_cta_description_cn = nullif(p_payload->>'bottom_cta_description_cn', ''),
      bottom_cta_description_en = nullif(p_payload->>'bottom_cta_description_en', ''),
      bottom_cta_button_text_cn = nullif(p_payload->>'bottom_cta_button_text_cn', ''),
      bottom_cta_button_text_en = nullif(p_payload->>'bottom_cta_button_text_en', ''),
      is_active = v_is_active
    where id = p_id;

    v_id := p_id;
    v_action := 'homepage_content.update';
  else
    insert into public.homepage_content (
      hero_eyebrow_cn, hero_eyebrow_en,
      hero_title_cn, hero_title_en,
      hero_highlight_cn, hero_highlight_en,
      hero_description_cn, hero_description_en,
      primary_cta_text_cn, primary_cta_text_en,
      secondary_cta_text_cn, secondary_cta_text_en,
      hero_slides,
      feature_section_title_cn, feature_section_title_en,
      feature_section_subtitle_cn, feature_section_subtitle_en,
      features_cn, features_en,
      category_section_title_cn, category_section_title_en,
      category_section_subtitle_cn, category_section_subtitle_en,
      featured_products_title_cn, featured_products_title_en,
      featured_products_subtitle_cn, featured_products_subtitle_en,
      certificates_section_title_cn, certificates_section_title_en,
      certificates_note_cn, certificates_note_en,
      projects_section_title_cn, projects_section_title_en,
      projects_section_subtitle_cn, projects_section_subtitle_en,
      bottom_cta_eyebrow_cn, bottom_cta_eyebrow_en,
      bottom_cta_title_cn, bottom_cta_title_en,
      bottom_cta_description_cn, bottom_cta_description_en,
      bottom_cta_button_text_cn, bottom_cta_button_text_en,
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
      v_hero_slides,
      nullif(p_payload->>'feature_section_title_cn', ''),
      nullif(p_payload->>'feature_section_title_en', ''),
      nullif(p_payload->>'feature_section_subtitle_cn', ''),
      nullif(p_payload->>'feature_section_subtitle_en', ''),
      coalesce(p_payload->'features_cn', '[]'::jsonb),
      coalesce(p_payload->'features_en', '[]'::jsonb),
      nullif(p_payload->>'category_section_title_cn', ''),
      nullif(p_payload->>'category_section_title_en', ''),
      nullif(p_payload->>'category_section_subtitle_cn', ''),
      nullif(p_payload->>'category_section_subtitle_en', ''),
      nullif(p_payload->>'featured_products_title_cn', ''),
      nullif(p_payload->>'featured_products_title_en', ''),
      nullif(p_payload->>'featured_products_subtitle_cn', ''),
      nullif(p_payload->>'featured_products_subtitle_en', ''),
      nullif(p_payload->>'certificates_section_title_cn', ''),
      nullif(p_payload->>'certificates_section_title_en', ''),
      nullif(p_payload->>'certificates_note_cn', ''),
      nullif(p_payload->>'certificates_note_en', ''),
      nullif(p_payload->>'projects_section_title_cn', ''),
      nullif(p_payload->>'projects_section_title_en', ''),
      nullif(p_payload->>'projects_section_subtitle_cn', ''),
      nullif(p_payload->>'projects_section_subtitle_en', ''),
      nullif(p_payload->>'bottom_cta_eyebrow_cn', ''),
      nullif(p_payload->>'bottom_cta_eyebrow_en', ''),
      nullif(p_payload->>'bottom_cta_title_cn', ''),
      nullif(p_payload->>'bottom_cta_title_en', ''),
      nullif(p_payload->>'bottom_cta_description_cn', ''),
      nullif(p_payload->>'bottom_cta_description_en', ''),
      nullif(p_payload->>'bottom_cta_button_text_cn', ''),
      nullif(p_payload->>'bottom_cta_button_text_en', ''),
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
    'updated_at', (
      select updated_at
      from public.homepage_content
      where id = v_id
    )
  );
end;
$$;

revoke all on function public.save_homepage_content_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_homepage_content_with_audit(
  uuid, jsonb, timestamptz, uuid, text, text
) to service_role;

-- Preserve the existing strict optimistic-lock release gate after replacing
-- the function body.
do $$
declare
  v_enforces boolean;
begin
  select enforces_22004 into v_enforces
  from public.verify_optimistic_lock_enforcement()
  where function_name = 'save_homepage_content_with_audit';

  if v_enforces is not true then
    raise exception
      '20260802193000 FAILED: save_homepage_content_with_audit lost strict optimistic locking'
      using errcode = 'P0001';
  end if;
end;
$$;
