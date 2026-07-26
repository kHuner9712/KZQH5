-- ============================================================
-- Phase 13: Transactional audit, Outbox state machine, Storage
-- hardening.
--
-- This migration is ADDITIVE only (new columns, new/replaceable RPCs).
-- No existing migration file is modified.
--
-- A. Transactional audit RPCs:
--    Business write + audit log insert are atomic. If either fails,
--    the entire transaction rolls back. Actor info comes from the
--    server-verified admin session, NOT from the request body.
--
-- B. Outbox state machine:
--    Adds locked_at, lock_token, processing_started_at, sent_at,
--    provider_message_id. Claim RPC generates a unique lock_token
--    and matches it on mark-sent/fail to prevent stale Worker updates.
--    Stale processing recovery via lock timeout.
--
-- C. Storage bucket hardening:
--    Differentiated size limits (images 5MB, PDFs 20MB).
--    Removes authenticated direct upload capability.
--
-- This migration is NOT executed in this commit.
-- ============================================================

-- ============================================================
-- A. Transactional audit RPCs
-- ============================================================

-- A.1: save_product_with_images_and_audit
-- Replaces save_product_with_images. Inserts/updates the product +
-- images + audit log in a single transaction. If the audit insert
-- fails, the product save rolls back.
create or replace function public.save_product_with_images_and_audit(
  p_id uuid,
  p_product jsonb,
  p_images jsonb default '[]'::jsonb,
  p_expected_updated_at timestamptz default null,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_img jsonb;
  v_action text;
  v_name text;
begin
  if p_product is null
     or btrim(p_product->>'name_cn') is null
     or btrim(p_product->>'slug') is null then
    raise exception 'product name_cn and slug are required'
      using errcode = '23502';
  end if;

  v_img := coalesce(p_images, '[]'::jsonb);

  -- Insert or update
  if p_id is null then
    v_action := 'product.create';
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
      nullif(p_product->>'fire_rating', ''),
      nullif(p_product->>'eco_grade', ''),
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
      coalesce(nullif(p_product->>'sort_order', '')::integer, 0),
      nullif(p_product->>'seo_title_cn', ''),
      nullif(p_product->>'seo_title_en', ''),
      nullif(p_product->>'seo_description_cn', ''),
      nullif(p_product->>'seo_description_en', ''),
      nullif(p_product->>'geo_summary_cn', ''),
      nullif(p_product->>'geo_summary_en', ''),
      p_product->'keywords_cn',
      p_product->'keywords_en',
      p_product->'search_aliases',
      p_product->'schema_extra',
      p_product->'faq_cn',
      p_product->'faq_en'
    ) returning id into v_id;
  else
    v_action := 'product.update';
    -- Optimistic lock check
    if p_expected_updated_at is not null then
      perform 1 from public.products
        where id = p_id and updated_at = p_expected_updated_at
        for update;
      if not found then
        raise exception 'optimistic lock conflict'
          using errcode = '40P01';
      end if;
    end if;

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
      fire_rating = nullif(p_product->>'fire_rating', ''),
      eco_grade = nullif(p_product->>'eco_grade', ''),
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
      sort_order = coalesce(nullif(p_product->>'sort_order', '')::integer, 0),
      seo_title_cn = nullif(p_product->>'seo_title_cn', ''),
      seo_title_en = nullif(p_product->>'seo_title_en', ''),
      seo_description_cn = nullif(p_product->>'seo_description_cn', ''),
      seo_description_en = nullif(p_product->>'seo_description_en', ''),
      geo_summary_cn = nullif(p_product->>'geo_summary_cn', ''),
      geo_summary_en = nullif(p_product->>'geo_summary_en', ''),
      keywords_cn = p_product->'keywords_cn',
      keywords_en = p_product->'keywords_en',
      search_aliases = p_product->'search_aliases',
      schema_extra = p_product->'schema_extra',
      faq_cn = p_product->'faq_cn',
      faq_en = p_product->'faq_en',
      updated_at = now()
    where id = p_id
    returning id into v_id;

    if v_id is null then
      raise exception 'product not found' using errcode = 'P0002';
    end if;

    -- Replace images atomically
    delete from public.product_images where product_id = v_id;
  end if;

  -- Insert images
  if jsonb_typeof(v_img) = 'array' then
    for i in 0 .. jsonb_array_length(v_img) - 1 loop
      declare
        v_row jsonb := v_img->i;
      begin
        insert into public.product_images (product_id, image_url, alt_cn, alt_en, sort_order)
        values (
          v_id,
          v_row->>'image_url',
          nullif(v_row->>'alt_cn', ''),
          nullif(v_row->>'alt_en', ''),
          coalesce(nullif(v_row->>'sort_order', '')::integer, i)
        );
      end;
    end loop;
  end if;

  v_name := p_product->>'name_cn';

  -- Atomic audit log insert — fails the transaction if it errors
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id, p_actor_email, p_actor_role, v_action, 'product', v_id::text,
    case when v_action = 'product.create'
      then 'Created product "' || coalesce(v_name, v_id::text) || '"'
      else 'Updated product "' || coalesce(v_name, v_id::text) || '"'
    end
  );

  return v_id;
end;
$$;

revoke all on function public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_product_with_images_and_audit(uuid, jsonb, jsonb, timestamptz, uuid, text, text)
  to service_role;

-- A.2: bulk_update_products_with_audit
-- Bulk update products + single audit entry, atomically.
create or replace function public.bulk_update_products_with_audit(
  p_ids uuid[],
  p_patch jsonb,
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
  v_id text;
  v_fields text := '';
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    raise exception 'ids required' using errcode = '23502';
  end if;
  if array_length(p_ids, 1) > 500 then
    raise exception 'too many ids' using errcode = '22023';
  end if;

  -- Build dynamic update from whitelisted patch keys
  if p_patch ? 'is_published' then
    v_fields := v_fields || 'is_published = ' || quote_literal((p_patch->>'is_published')::boolean) || ', ';
  end if;
  if p_patch ? 'is_featured' then
    v_fields := v_fields || 'is_featured = ' || quote_literal((p_patch->>'is_featured')::boolean) || ', ';
  end if;
  if p_patch ? 'category_id' then
    v_fields := v_fields || 'category_id = ' || quote_nullable(p_patch->>'category_id') || '::uuid, ';
  end if;
  if p_patch ? 'subcategory_id' then
    v_fields := v_fields || 'subcategory_id = ' || quote_nullable(p_patch->>'subcategory_id') || '::uuid, ';
  end if;

  v_fields := rtrim(v_fields, ', ');
  if v_fields = '' then
    raise exception 'no valid fields' using errcode = '23502';
  end if;

  execute format(
    'update public.products set %s, updated_at = now() where id = any($1)',
    v_fields
  ) using p_ids;

  get diagnostics v_count = row_count;

  -- Atomic audit
  select array_to_string(p_ids, ',') into v_id;
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id, p_actor_email, p_actor_role, 'product.bulk_update', 'product', v_id,
    'Bulk updated ' || v_count || ' product(s)'
  );

  return v_count;
end;
$$;

revoke all on function public.bulk_update_products_with_audit(uuid[], jsonb, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.bulk_update_products_with_audit(uuid[], jsonb, uuid, text, text)
  to service_role;

-- A.3: bulk_delete_products_with_audit
create or replace function public.bulk_delete_products_with_audit(
  p_ids uuid[],
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
  v_id_list text;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    raise exception 'ids required' using errcode = '23502';
  end if;
  if array_length(p_ids, 1) > 500 then
    raise exception 'too many ids' using errcode = '22023';
  end if;

  delete from public.products where id = any(p_ids);
  get diagnostics v_count = row_count;

  select array_to_string(p_ids, ',') into v_id_list;
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id, p_actor_email, p_actor_role, 'product.delete', 'product', v_id_list,
    'Deleted ' || v_count || ' product(s)'
  );

  return v_count;
end;
$$;

revoke all on function public.bulk_delete_products_with_audit(uuid[], uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.bulk_delete_products_with_audit(uuid[], uuid, text, text)
  to service_role;

-- A.4: update_inquiry_with_audit
-- Updates an inquiry + audit log atomically. Enforces optimistic lock.
create or replace function public.update_inquiry_with_audit(
  p_id uuid,
  p_patch jsonb,
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
  v_row public.inquiries%rowtype;
  v_fields text := '';
  v_field_list text := '';
begin
  -- Optimistic lock
  perform 1 from public.inquiries
    where id = p_id and updated_at = p_expected_updated_at
    for update;
  if not found then
    -- Check if row exists to distinguish conflict from not-found
    perform 1 from public.inquiries where id = p_id;
    if found then
      raise exception 'optimistic lock conflict' using errcode = '40P01';
    else
      raise exception 'inquiry not found' using errcode = 'P0002';
    end if;
  end if;

  -- Build dynamic update from whitelisted patch keys
  if p_patch ? 'status' then
    v_fields := v_fields || 'status = ' || quote_literal(p_patch->>'status') || ', ';
    v_field_list := v_field_list || 'status, ';
  end if;
  if p_patch ? 'is_read' then
    v_fields := v_fields || 'is_read = ' || quote_literal((p_patch->>'is_read')::boolean) || ', ';
    v_field_list := v_field_list || 'is_read, ';
  end if;
  if p_patch ? 'read_at' then
    v_fields := v_fields || 'read_at = ' || quote_nullable(p_patch->>'read_at') || '::timestamptz, ';
    v_field_list := v_field_list || 'read_at, ';
  end if;
  if p_patch ? 'notes' then
    v_fields := v_fields || 'notes = ' || quote_nullable(p_patch->>'notes') || ', ';
    v_field_list := v_field_list || 'notes, ';
  end if;
  if p_patch ? 'assignee' then
    v_fields := v_fields || 'assignee = ' || quote_nullable(p_patch->>'assignee') || ', ';
    v_field_list := v_field_list || 'assignee, ';
  end if;

  v_fields := rtrim(v_fields, ', ');
  if v_fields = '' then
    raise exception 'no valid fields' using errcode = '23502';
  end if;

  execute format(
    'update public.inquiries set %s, updated_at = now() where id = $1 returning to_jsonb(t)',
    v_fields
  ) using p_id into v_row;

  -- Atomic audit — no PII (no message, email, phone)
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id, p_actor_email, p_actor_role, 'inquiry.update', 'inquiry', p_id::text,
    'Updated inquiry ' || p_id::text || ': ' || rtrim(v_field_list, ', ')
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.update_inquiry_with_audit(uuid, jsonb, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.update_inquiry_with_audit(uuid, jsonb, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- B. Outbox state machine enhancements
-- ============================================================

-- B.1: Add columns for robust locking and tracking
alter table public.inquiry_outbox
  add column if not exists locked_at timestamptz,
  add column if not exists lock_token uuid,
  add column if not exists processing_started_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists provider_message_id text;

-- B.2: Update claim RPC to generate lock_token and handle stale processing
create or replace function public.claim_inquiry_outbox_batch(
  p_limit integer default 10,
  p_stale_timeout_seconds integer default 300
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_safe_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_safe_timeout integer := greatest(coalesce(p_stale_timeout_seconds, 300), 60);
  v_ids uuid[];
  v_rows jsonb;
begin
  -- Claim pending, retry, or stale processing events
  -- Stale = processing for longer than p_stale_timeout_seconds (default 5 min)
  with picked as (
    select id
      from public.inquiry_outbox
      where (status in ('pending', 'retry') and next_retry_at <= now())
         or (status = 'processing'
             and processing_started_at is not null
             and processing_started_at < now() - (v_safe_timeout || ' seconds')::interval)
        and attempts < max_attempts
      order by
        case
          when status in ('pending', 'retry') then 0
          else 1
        end,
        next_retry_at
      limit v_safe_limit
      for update skip locked
  ),
  marked as (
    update public.inquiry_outbox
      set status = 'processing',
          lock_token = gen_random_uuid(),
          locked_at = now(),
          processing_started_at = now(),
          updated_at = now()
      where id in (select id from picked)
      returning id, inquiry_id, lock_token
  )
  select jsonb_agg(to_jsonb(marked)) into v_rows
    from marked;

  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

revoke all on function public.claim_inquiry_outbox_batch(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_inquiry_outbox_batch(integer, integer)
  to service_role;

-- B.3: mark_inquiry_outbox_sent with lock_token matching
-- Prevents stale Workers from marking events sent by newer Workers.
create or replace function public.mark_inquiry_outbox_sent(
  p_event_id uuid,
  p_lock_token uuid,
  p_provider_message_id text default null
) returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_event_id is null or p_lock_token is null then
    return false;
  end if;

  update public.inquiry_outbox
    set status = 'sent',
        sent_at = now(),
        last_error_code = null,
        provider_message_id = left(coalesce(p_provider_message_id, ''), 200),
        updated_at = now()
    where id = p_event_id
      and status = 'processing'
      and lock_token = p_lock_token;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.mark_inquiry_outbox_sent(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_inquiry_outbox_sent(uuid, uuid, text)
  to service_role;

-- B.4: fail_inquiry_outbox_event with lock_token matching
create or replace function public.fail_inquiry_outbox_event(
  p_event_id uuid,
  p_lock_token uuid,
  p_error_code text default null
) returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
  v_final_status text;
begin
  if p_event_id is null or p_lock_token is null then
    return 'INVALID_PARAMS';
  end if;

  -- Lock the row and verify ownership
  select attempts, max_attempts
    into v_attempts, v_max_attempts
    from public.inquiry_outbox
    where id = p_event_id
      and status = 'processing'
      and lock_token = p_lock_token
    for update;

  if not found then
    -- Event was re-claimed by another Worker or already completed
    return 'NOT_FOUND_OR_TOKEN_MISMATCH';
  end if;

  v_attempts := v_attempts + 1;

  if v_attempts >= v_max_attempts then
    update public.inquiry_outbox
      set status = 'dead_letter',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          next_retry_at = null,
          updated_at = now()
      where id = p_event_id;
    v_final_status := 'dead_letter';
  else
    update public.inquiry_outbox
      set status = 'retry',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          next_retry_at = now() + least(
            (interval '60 seconds') * power(2, v_attempts - 1),
            interval '30 minutes'
          ),
          updated_at = now()
      where id = p_event_id;
    v_final_status := 'retry';
  end if;

  return v_final_status;
end;
$$;

revoke all on function public.fail_inquiry_outbox_event(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_inquiry_outbox_event(uuid, uuid, text)
  to service_role;

-- B.5: get_inquiry_outbox_status — returns real final status counts
create or replace function public.get_inquiry_outbox_status()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'pending', count(*) filter (where status = 'pending'),
    'processing', count(*) filter (where status = 'processing'),
    'sent', count(*) filter (where status = 'sent'),
    'retry', count(*) filter (where status = 'retry'),
    'dead_letter', count(*) filter (where status = 'dead_letter'),
    'total', count(*)
  ) into v_result
  from public.inquiry_outbox;

  return v_result;
end;
$$;

revoke all on function public.get_inquiry_outbox_status()
  from public, anon, authenticated;
grant execute on function public.get_inquiry_outbox_status()
  to service_role;

-- ============================================================
-- C. Storage bucket hardening
-- ============================================================

-- C.1: Differentiate size limits — images 5MB, PDFs 20MB
-- The previous migration set both buckets to 50MB. We tighten this.
-- Note: Supabase bucket file_size_limit is a single value per bucket.
-- For per-MIME size limits, we enforce at the application layer
-- (server-side upload API). The bucket-level limit is set to the
-- maximum (20MB for PDFs).

update storage.buckets
set
  allowed_mime_types = array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ],
  file_size_limit = 20971520  -- 20 MB (max for PDFs; images enforced at 5MB app-layer)
where name = 'public-assets';

update storage.buckets
set
  allowed_mime_types = array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ],
  file_size_limit = 20971520  -- 20 MB
where name = 'private-assets';

-- C.2: Remove authenticated direct upload capability
-- Only service_role can upload/delete via the trusted server boundary.
-- Revoke any existing storage policies that allow authenticated uploads.
do $$
declare
  pol record;
begin
  for pol in
    select policyname, tablename
      from pg_policies
     where schemaname = 'storage'
       and tablename in ('objects')
       and policyname like '%authenticated%'
  loop
    execute format('drop policy if exists %I on storage.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- C.3: Create explicit policies for service_role only (storage.objects)
-- service_role bypasses RLS, so these are belt-and-suspenders.
-- anon and authenticated get NO policies on storage.objects — they
-- cannot read or write directly. All access goes through the server API.
create policy "service_role_all_storage" on storage.objects
  for all
  to service_role
  using (true)
  with check (true);

-- Public read for public-assets bucket (anon can SELECT, not INSERT/UPDATE/DELETE)
create policy "anon_read_public_assets" on storage.objects
  for select
  to anon
  using (bucket_id = 'public-assets');

-- ============================================================
-- End of migration
-- ============================================================
