-- ============================================================
-- Phase 5 correction: restore DB-owned product snapshot in
-- create_inquiry_with_items.
--
-- Migration 20260724150000 introduced idempotency and outbox
-- support but REGRESSED the server-owned product snapshot behavior
-- originally implemented in 20260714201851:
--
--   1. inquiry_items used client-supplied product_name_cn /
--      product_name_en / product_slug instead of DB-owned values.
--   2. No validation that referenced products exist and are
--      is_published = true.
--   3. No max-items (30) cap.
--   4. No duplicate product_id check.
--   5. inquiries.product_id / product_slug / interested_product
--      used client-supplied values instead of resolved DB values.
--
-- This migration replaces the function body to restore all of the
-- above while preserving the 3-arg signature (jsonb, jsonb, uuid),
-- the idempotency check, the outbox event write, and the jsonb
-- return shape { inquiry, idempotent, outbox_id }.
--
-- This migration ONLY replaces the function body and re-issues the
-- privilege grants. It does not alter tables or indexes.
-- ============================================================

drop function if exists public.create_inquiry_with_items(jsonb, jsonb, uuid);

create function public.create_inquiry_with_items(
  p_inquiry jsonb,
  p_items jsonb default '[]'::jsonb,
  p_client_submission_id uuid default null
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_existing public.inquiries%rowtype;
  v_created public.inquiries%rowtype;
  v_outbox_id uuid;
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_item_count integer;
  v_unique_item_count integer;
  v_resolved_item_count integer;
  v_resolved_product_names text;
  v_first_product_id uuid;
  v_first_product_slug text;
  v_first_quantity text;
begin
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'p_items must be a JSON array' using errcode = '22023';
  end if;

  v_item_count := jsonb_array_length(v_items);
  if v_item_count > 30 then
    raise exception 'p_items exceeds maximum of 30' using errcode = '22023';
  end if;

  if v_item_count = 0 and nullif(p_inquiry->>'product_id', '') is not null then
    raise exception 'product_id requires a matching item' using errcode = '22023';
  end if;

  -- Idempotency: same client_submission_id already exists -> return existing row.
  if p_client_submission_id is not null then
    select * into v_existing
      from public.inquiries
      where client_submission_id = p_client_submission_id
      limit 1;

    if found then
      return jsonb_build_object(
        'inquiry', to_jsonb(v_existing),
        'idempotent', true,
        'outbox_id', null
      );
    end if;
  end if;

  -- Validate items against the DB: products must exist and be published.
  -- Client-supplied product names/slugs are NEVER trusted.
  if v_item_count > 0 then
    select count(distinct (item.value->>'product_id')::uuid)
      into v_unique_item_count
      from jsonb_array_elements(v_items) as item(value);

    if v_unique_item_count <> v_item_count then
      raise exception 'p_items contains duplicate product ids' using errcode = '22023';
    end if;

    select count(*)
      into v_resolved_item_count
      from public.products product
      where product.is_published = true
        and product.id in (
          select (item.value->>'product_id')::uuid
          from jsonb_array_elements(v_items) as item(value)
        );

    if v_resolved_item_count <> v_item_count then
      raise exception 'one or more inquiry products are unavailable' using errcode = '22023';
    end if;

    -- Resolve DB-owned snapshot values for the inquiries row.
    select
      string_agg(product.name_cn, '；' order by item.ordinality),
      (array_agg(product.id order by item.ordinality))[1],
      (array_agg(product.slug order by item.ordinality))[1],
      case when v_item_count = 1
        then nullif((array_agg(item.value->>'quantity' order by item.ordinality))[1], '')
        else null
      end
    into v_resolved_product_names, v_first_product_id, v_first_product_slug, v_first_quantity
    from jsonb_array_elements(v_items) with ordinality as item(value, ordinality)
    join public.products product
      on product.id = (item.value->>'product_id')::uuid
     and product.is_published = true;
  end if;

  -- Insert the inquiry row (explicit columns, whitelist only).
  -- product_id / product_slug / interested_product use DB-resolved values.
  insert into public.inquiries (
    name, company, country, phone, wechat, email, whatsapp,
    interested_product, quantity, message, status, language,
    source, channel, page_url, referrer, product_id, product_slug,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    is_read, read_at, notes, assignee, client_submission_id
  ) values (
    p_inquiry->>'name',
    nullif(p_inquiry->>'company', ''),
    nullif(p_inquiry->>'country', ''),
    nullif(p_inquiry->>'phone', ''),
    nullif(p_inquiry->>'wechat', ''),
    nullif(p_inquiry->>'email', ''),
    nullif(p_inquiry->>'whatsapp', ''),
    coalesce(v_resolved_product_names, nullif(p_inquiry->>'interested_product', '')),
    coalesce(v_first_quantity, nullif(p_inquiry->>'quantity', '')),
    nullif(p_inquiry->>'message', ''),
    'new',
    case when p_inquiry->>'language' = 'en' then 'en' else 'zh' end,
    nullif(p_inquiry->>'source', ''),
    nullif(p_inquiry->>'channel', ''),
    nullif(p_inquiry->>'page_url', ''),
    nullif(p_inquiry->>'referrer', ''),
    v_first_product_id,
    v_first_product_slug,
    nullif(p_inquiry->>'utm_source', ''),
    nullif(p_inquiry->>'utm_medium', ''),
    nullif(p_inquiry->>'utm_campaign', ''),
    nullif(p_inquiry->>'utm_content', ''),
    nullif(p_inquiry->>'utm_term', ''),
    false, null, null, null,
    p_client_submission_id
  )
  returning * into v_created;

  -- Insert inquiry items using DB-OWNED product snapshot.
  -- Client-supplied product_name_cn / product_name_en / product_slug
  -- are intentionally ignored.
  insert into public.inquiry_items (
    inquiry_id, product_id, product_slug, product_name_cn,
    product_name_en, quantity, sort_order
  )
  select
    v_created.id,
    product.id,
    product.slug,
    product.name_cn,
    product.name_en,
    nullif(item.value->>'quantity', ''),
    (item.ordinality - 1)::integer
  from jsonb_array_elements(v_items) with ordinality as item(value, ordinality)
  join public.products product
    on product.id = (item.value->>'product_id')::uuid
   and product.is_published = true;

  -- Write outbox event (same transaction, at-least-once delivery).
  insert into public.inquiry_outbox (
    inquiry_id, event_type, status, attempts, max_attempts, next_retry_at
  ) values (
    v_created.id, 'inquiry_created', 'pending', 0, 5, now()
  )
  returning id into v_outbox_id;

  return jsonb_build_object(
    'inquiry', to_jsonb(v_created),
    'idempotent', false,
    'outbox_id', v_outbox_id
  );
end;
$$;

-- Privileges: only service_role may call (anon/authenticated denied).
revoke all on function public.create_inquiry_with_items(jsonb, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.create_inquiry_with_items(jsonb, jsonb, uuid)
  to service_role;
