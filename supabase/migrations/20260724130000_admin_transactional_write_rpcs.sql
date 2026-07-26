-- Phase 2: Transactional admin write RPCs for multi-table atomic operations.
--
-- These RPCs exist so the admin CMS can save a product together with its
-- images, and a project together with its images + product associations,
-- in a single atomic database call. Partial failure rolls everything back.
--
-- Safety contract (per RPC):
--   * language plpgsql        -> procedural, but only performs the documented
--                                 insert/update/delete on public.<table>
--   * security invoker        -> runs with caller privileges (service_role)
--   * set search_path = ''    -> every table qualified as public.<table>
--   * revoke from public/anon/authenticated
--   * grant execute to service_role only
--   * explicit column lists (no SELECT * on business tables / no unsafe
--     record population with attacker-controlled keys) so only whitelisted
--     columns are writable
--   * updated_at set explicitly in addition to the trigger
--
-- The application layer performs full field validation (length, enum, URL,
-- UUID) BEFORE calling these RPCs. The RPCs add a defense-in-depth check on
-- the few NOT NULL / required fields and rely on DB constraints (unique slug,
-- FKs, checks) for integrity.
--
-- This migration is additive. It does not alter existing tables, policies,
-- or data. It is NOT executed in this commit.

-- ============================================================
-- save_product_with_images(p_id, p_product, p_images)
--   p_id      : existing product id to update, or null to create
--   p_product : jsonb of whitelisted product columns
--   p_images  : jsonb array of { image_url, alt_cn, alt_en, sort_order }
-- Returns the product id.
-- On update of a non-existent p_id, raises P0002 (not found).
-- ============================================================
create or replace function public.save_product_with_images(
  p_id uuid,
  p_product jsonb,
  p_images jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_img jsonb;
  v_url text;
begin
  if p_product is null
     or btrim(p_product->>'name_cn') is null
     or btrim(p_product->>'slug') is null then
    raise exception 'product name_cn and slug are required'
      using errcode = '23502';
  end if;

  if p_id is null then
    insert into public.products (
      category_id, subcategory_id, name_cn, name_en, slug,
      summary_cn, summary_en, description_cn, description_en,
      material_cn, material_en, size, fire_rating, eco_grade,
      price_display_cn, price_display_en, moq,
      packaging_cn, packaging_en, logistics_cn, logistics_en,
      application_cn, application_en, video_url, cover_image_url,
      is_featured, is_published, sort_order,
      seo_title_cn, seo_title_en, seo_description_cn, seo_description_en,
      geo_summary_cn, geo_summary_en,
      keywords_cn, keywords_en, search_aliases,
      schema_extra, faq_cn, faq_en
    ) values (
      nullif(p_product->>'category_id', '')::uuid,
      nullif(p_product->>'subcategory_id', '')::uuid,
      p_product->>'name_cn',
      nullif(p_product->>'name_en', ''),
      p_product->>'slug',
      nullif(p_product->>'summary_cn', ''),
      nullif(p_product->>'summary_en', ''),
      nullif(p_product->>'description_cn', ''),
      nullif(p_product->>'description_en', ''),
      nullif(p_product->>'material_cn', ''),
      nullif(p_product->>'material_en', ''),
      nullif(p_product->>'size', ''),
      coalesce(nullif(p_product->>'fire_rating', ''), 'B级'),
      coalesce(nullif(p_product->>'eco_grade', ''), 'E0级'),
      nullif(p_product->>'price_display_cn', ''),
      nullif(p_product->>'price_display_en', ''),
      nullif(p_product->>'moq', ''),
      nullif(p_product->>'packaging_cn', ''),
      nullif(p_product->>'packaging_en', ''),
      nullif(p_product->>'logistics_cn', ''),
      nullif(p_product->>'logistics_en', ''),
      nullif(p_product->>'application_cn', ''),
      nullif(p_product->>'application_en', ''),
      nullif(p_product->>'video_url', ''),
      nullif(p_product->>'cover_image_url', ''),
      coalesce((p_product->>'is_featured')::boolean, false),
      coalesce((p_product->>'is_published')::boolean, false),
      coalesce((p_product->>'sort_order')::int, 0),
      nullif(p_product->>'seo_title_cn', ''),
      nullif(p_product->>'seo_title_en', ''),
      nullif(p_product->>'seo_description_cn', ''),
      nullif(p_product->>'seo_description_en', ''),
      nullif(p_product->>'geo_summary_cn', ''),
      nullif(p_product->>'geo_summary_en', ''),
      (p_product->'keywords_cn'),
      (p_product->'keywords_en'),
      (p_product->'search_aliases'),
      nullif(p_product->'schema_extra', 'null'::jsonb),
      nullif(p_product->'faq_cn', 'null'::jsonb),
      nullif(p_product->'faq_en', 'null'::jsonb)
    )
    returning id into v_id;
  else
    v_id := p_id;
    update public.products set
      category_id = nullif(p_product->>'category_id', '')::uuid,
      subcategory_id = nullif(p_product->>'subcategory_id', '')::uuid,
      name_cn = p_product->>'name_cn',
      name_en = nullif(p_product->>'name_en', ''),
      slug = p_product->>'slug',
      summary_cn = nullif(p_product->>'summary_cn', ''),
      summary_en = nullif(p_product->>'summary_en', ''),
      description_cn = nullif(p_product->>'description_cn', ''),
      description_en = nullif(p_product->>'description_en', ''),
      material_cn = nullif(p_product->>'material_cn', ''),
      material_en = nullif(p_product->>'material_en', ''),
      size = nullif(p_product->>'size', ''),
      fire_rating = coalesce(nullif(p_product->>'fire_rating', ''), 'B级'),
      eco_grade = coalesce(nullif(p_product->>'eco_grade', ''), 'E0级'),
      price_display_cn = nullif(p_product->>'price_display_cn', ''),
      price_display_en = nullif(p_product->>'price_display_en', ''),
      moq = nullif(p_product->>'moq', ''),
      packaging_cn = nullif(p_product->>'packaging_cn', ''),
      packaging_en = nullif(p_product->>'packaging_en', ''),
      logistics_cn = nullif(p_product->>'logistics_cn', ''),
      logistics_en = nullif(p_product->>'logistics_en', ''),
      application_cn = nullif(p_product->>'application_cn', ''),
      application_en = nullif(p_product->>'application_en', ''),
      video_url = nullif(p_product->>'video_url', ''),
      cover_image_url = nullif(p_product->>'cover_image_url', ''),
      is_featured = coalesce((p_product->>'is_featured')::boolean, false),
      is_published = coalesce((p_product->>'is_published')::boolean, false),
      sort_order = coalesce((p_product->>'sort_order')::int, 0),
      seo_title_cn = nullif(p_product->>'seo_title_cn', ''),
      seo_title_en = nullif(p_product->>'seo_title_en', ''),
      seo_description_cn = nullif(p_product->>'seo_description_cn', ''),
      seo_description_en = nullif(p_product->>'seo_description_en', ''),
      geo_summary_cn = nullif(p_product->>'geo_summary_cn', ''),
      geo_summary_en = nullif(p_product->>'geo_summary_en', ''),
      keywords_cn = (p_product->'keywords_cn'),
      keywords_en = (p_product->'keywords_en'),
      search_aliases = (p_product->'search_aliases'),
      schema_extra = nullif(p_product->'schema_extra', 'null'::jsonb),
      faq_cn = nullif(p_product->'faq_cn', 'null'::jsonb),
      faq_en = nullif(p_product->'faq_en', 'null'::jsonb),
      updated_at = now()
    where id = v_id;
    if not found then
      raise exception 'product not found' using errcode = 'P0002';
    end if;
  end if;

  -- Replace images atomically within the same transaction.
  delete from public.product_images where product_id = v_id;
  if p_images is not null and jsonb_typeof(p_images) = 'array' then
    for v_img in select * from jsonb_array_elements(p_images) loop
      v_url := v_img->>'image_url';
      if v_url is null or btrim(v_url) = '' then
        raise exception 'product image_url is required' using errcode = '23502';
      end if;
      insert into public.product_images (product_id, image_url, alt_cn, alt_en, sort_order)
      values (
        v_id,
        v_url,
        nullif(v_img->>'alt_cn', ''),
        nullif(v_img->>'alt_en', ''),
        coalesce((v_img->>'sort_order')::int, 0)
      );
    end loop;
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_product_with_images(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_product_with_images(uuid, jsonb, jsonb)
  to service_role;

-- ============================================================
-- save_project_with_relations(p_id, p_project, p_images, p_products)
--   p_id       : existing project id to update, or null to create
--   p_project  : jsonb of whitelisted project columns
--   p_images   : jsonb array of { image_url, alt_cn, alt_en, sort_order }
--   p_products : jsonb array of { product_id, sort_order }
-- Returns the project id.
-- ============================================================
create or replace function public.save_project_with_relations(
  p_id uuid,
  p_project jsonb,
  p_images jsonb default '[]'::jsonb,
  p_products jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_img jsonb;
  v_url text;
  v_link jsonb;
begin
  if p_project is null
     or btrim(p_project->>'title_cn') is null
     or btrim(p_project->>'slug') is null then
    raise exception 'project title_cn and slug are required'
      using errcode = '23502';
  end if;

  if p_id is null then
    insert into public.projects (
      slug, title_cn, title_en, summary_cn, summary_en,
      description_cn, description_en, country_cn, country_en,
      project_type_cn, project_type_en, cover_image_url,
      is_published, is_featured, sort_order,
      seo_title_cn, seo_title_en, seo_description_cn, seo_description_en
    ) values (
      p_project->>'slug',
      p_project->>'title_cn',
      nullif(p_project->>'title_en', ''),
      nullif(p_project->>'summary_cn', ''),
      nullif(p_project->>'summary_en', ''),
      nullif(p_project->>'description_cn', ''),
      nullif(p_project->>'description_en', ''),
      nullif(p_project->>'country_cn', ''),
      nullif(p_project->>'country_en', ''),
      nullif(p_project->>'project_type_cn', ''),
      nullif(p_project->>'project_type_en', ''),
      nullif(p_project->>'cover_image_url', ''),
      coalesce((p_project->>'is_published')::boolean, false),
      coalesce((p_project->>'is_featured')::boolean, false),
      coalesce((p_project->>'sort_order')::int, 0),
      nullif(p_project->>'seo_title_cn', ''),
      nullif(p_project->>'seo_title_en', ''),
      nullif(p_project->>'seo_description_cn', ''),
      nullif(p_project->>'seo_description_en', '')
    )
    returning id into v_id;
  else
    v_id := p_id;
    update public.projects set
      slug = p_project->>'slug',
      title_cn = p_project->>'title_cn',
      title_en = nullif(p_project->>'title_en', ''),
      summary_cn = nullif(p_project->>'summary_cn', ''),
      summary_en = nullif(p_project->>'summary_en', ''),
      description_cn = nullif(p_project->>'description_cn', ''),
      description_en = nullif(p_project->>'description_en', ''),
      country_cn = nullif(p_project->>'country_cn', ''),
      country_en = nullif(p_project->>'country_en', ''),
      project_type_cn = nullif(p_project->>'project_type_cn', ''),
      project_type_en = nullif(p_project->>'project_type_en', ''),
      cover_image_url = nullif(p_project->>'cover_image_url', ''),
      is_published = coalesce((p_project->>'is_published')::boolean, false),
      is_featured = coalesce((p_project->>'is_featured')::boolean, false),
      sort_order = coalesce((p_project->>'sort_order')::int, 0),
      seo_title_cn = nullif(p_project->>'seo_title_cn', ''),
      seo_title_en = nullif(p_project->>'seo_title_en', ''),
      seo_description_cn = nullif(p_project->>'seo_description_cn', ''),
      seo_description_en = nullif(p_project->>'seo_description_en', ''),
      updated_at = now()
    where id = v_id;
    if not found then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
  end if;

  -- Replace images atomically.
  delete from public.project_images where project_id = v_id;
  if p_images is not null and jsonb_typeof(p_images) = 'array' then
    for v_img in select * from jsonb_array_elements(p_images) loop
      v_url := v_img->>'image_url';
      if v_url is null or btrim(v_url) = '' then
        raise exception 'project image_url is required' using errcode = '23502';
      end if;
      insert into public.project_images (project_id, image_url, alt_cn, alt_en, sort_order)
      values (
        v_id,
        v_url,
        nullif(v_img->>'alt_cn', ''),
        nullif(v_img->>'alt_en', ''),
        coalesce((v_img->>'sort_order')::int, 0)
      );
    end loop;
  end if;

  -- Replace product associations atomically.
  delete from public.project_products where project_id = v_id;
  if p_products is not null and jsonb_typeof(p_products) = 'array' then
    for v_link in select * from jsonb_array_elements(p_products) loop
      if v_link->>'product_id' is null then
        raise exception 'project_products.product_id is required' using errcode = '23502';
      end if;
      insert into public.project_products (project_id, product_id, sort_order)
      values (
        v_id,
        (v_link->>'product_id')::uuid,
        coalesce((v_link->>'sort_order')::int, 0)
      );
    end loop;
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_project_with_relations(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_project_with_relations(uuid, jsonb, jsonb, jsonb)
  to service_role;
