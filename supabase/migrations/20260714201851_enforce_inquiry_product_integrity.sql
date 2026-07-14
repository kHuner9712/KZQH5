-- Enforce server-owned inquiry product snapshots and atomic writes.
-- Historical inquiry snapshots remain unchanged; only new RPC calls are affected.

create or replace function public.create_inquiry_with_items(
  p_inquiry jsonb,
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  created public.inquiries;
  item_count integer;
  unique_item_count integer;
  resolved_item_count integer;
  resolved_product_names text;
  first_product_id uuid;
  first_product_slug text;
  first_quantity text;
begin
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'p_items must be a JSON array';
  end if;

  item_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if item_count > 30 then
    raise exception 'p_items exceeds maximum of 30';
  end if;

  if item_count = 0 and nullif(p_inquiry->>'product_id', '') is not null then
    raise exception 'product_id requires a matching item';
  end if;

  if item_count > 0 then
    select count(distinct (item.value->>'product_id')::uuid)
    into unique_item_count
    from jsonb_array_elements(p_items) as item(value);

    if unique_item_count <> item_count then
      raise exception 'p_items contains duplicate product ids';
    end if;

    select count(*)
    into resolved_item_count
    from public.products product
    where product.is_published = true
      and product.id in (
        select (item.value->>'product_id')::uuid
        from jsonb_array_elements(p_items) as item(value)
      );

    if resolved_item_count <> item_count then
      raise exception 'one or more inquiry products are unavailable';
    end if;

    select
      string_agg(product.name_cn, '；' order by item.ordinality),
      (array_agg(product.id order by item.ordinality))[1],
      (array_agg(product.slug order by item.ordinality))[1],
      case when item_count = 1
        then nullif((array_agg(item.value->>'quantity' order by item.ordinality))[1], '')
        else null
      end
    into resolved_product_names, first_product_id, first_product_slug, first_quantity
    from jsonb_array_elements(p_items) with ordinality as item(value, ordinality)
    join public.products product
      on product.id = (item.value->>'product_id')::uuid
     and product.is_published = true;
  end if;

  insert into public.inquiries (
    name, company, country, phone, wechat, email, whatsapp,
    interested_product, quantity, message, status, language,
    source, channel, page_url, referrer, product_id, product_slug,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    is_read, read_at, notes, assignee
  ) values (
    p_inquiry->>'name',
    nullif(p_inquiry->>'company', ''),
    nullif(p_inquiry->>'country', ''),
    nullif(p_inquiry->>'phone', ''),
    nullif(p_inquiry->>'wechat', ''),
    nullif(p_inquiry->>'email', ''),
    nullif(p_inquiry->>'whatsapp', ''),
    coalesce(resolved_product_names, nullif(p_inquiry->>'interested_product', '')),
    coalesce(first_quantity, nullif(p_inquiry->>'quantity', '')),
    nullif(p_inquiry->>'message', ''),
    'new',
    case when p_inquiry->>'language' = 'en' then 'en' else 'zh' end,
    nullif(p_inquiry->>'source', ''),
    nullif(p_inquiry->>'channel', ''),
    nullif(p_inquiry->>'page_url', ''),
    nullif(p_inquiry->>'referrer', ''),
    first_product_id,
    first_product_slug,
    nullif(p_inquiry->>'utm_source', ''),
    nullif(p_inquiry->>'utm_medium', ''),
    nullif(p_inquiry->>'utm_campaign', ''),
    nullif(p_inquiry->>'utm_content', ''),
    nullif(p_inquiry->>'utm_term', ''),
    false,
    null,
    null,
    null
  )
  returning * into created;

  insert into public.inquiry_items (
    inquiry_id, product_id, product_slug, product_name_cn,
    product_name_en, quantity, sort_order
  )
  select
    created.id,
    product.id,
    product.slug,
    product.name_cn,
    product.name_en,
    nullif(item.value->>'quantity', ''),
    (item.ordinality - 1)::integer
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
    with ordinality as item(value, ordinality)
  join public.products product
    on product.id = (item.value->>'product_id')::uuid
   and product.is_published = true;

  return to_jsonb(created);
end;
$$;

revoke all on function public.create_inquiry_with_items(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_inquiry_with_items(jsonb, jsonb)
  to service_role;

-- Trigger functions run with the function owner's privileges. They do not need
-- to remain callable by application roles, and an empty search_path prevents
-- object shadowing in SECURITY DEFINER execution.
alter function public.handle_new_user() set search_path = '';
revoke all on function public.handle_new_user()
  from public, anon, authenticated;
