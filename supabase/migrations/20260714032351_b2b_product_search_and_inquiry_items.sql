-- ============================================================
-- KZQ B2B 产品搜索与多产品询盘
-- 仅追加搜索辅助列/函数、inquiry_items 表和原子询盘写入函数。
-- ============================================================

create extension if not exists pg_trgm;

-- 搜索规范化：忽略大小写、空白和常见中英文标点；尺寸中的 × / * 统一为 x。
create or replace function public.normalize_product_search(input text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
    replace(replace(replace(lower(coalesce(input, '')), '×', 'x'), '*', 'x'), '＊', 'x'),
    '[[:space:][:punct:]，。；：、！？（）【】《》“”‘’·—–]+',
    '',
    'g'
  );
$$;

alter table public.products
  add column if not exists search_document text not null default '';

create or replace function public.refresh_product_search_document()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.search_document := public.normalize_product_search(
    coalesce(new.name_cn, '') || ' ' ||
    coalesce(new.name_en, '') || ' ' ||
    coalesce(new.slug, '') || ' ' ||
    coalesce(new.summary_cn, '') || ' ' ||
    coalesce(new.summary_en, '') || ' ' ||
    coalesce(new.material_cn, '') || ' ' ||
    coalesce(new.material_en, '') || ' ' ||
    coalesce(new.size, '') || ' ' ||
    coalesce(new.application_cn, '') || ' ' ||
    coalesce(new.application_en, '') || ' ' ||
    coalesce(array_to_string(new.search_aliases, ' '), '') || ' ' ||
    coalesce(array_to_string(new.keywords_cn, ' '), '') || ' ' ||
    coalesce(array_to_string(new.keywords_en, ' '), '')
  );
  return new;
end;
$$;

drop trigger if exists trg_products_search_document on public.products;
create trigger trg_products_search_document
  before insert or update of
    name_cn, name_en, slug, summary_cn, summary_en,
    material_cn, material_en, size, application_cn, application_en,
    search_aliases, keywords_cn, keywords_en
  on public.products
  for each row execute function public.refresh_product_search_document();

update public.products
set search_document = public.normalize_product_search(
  coalesce(name_cn, '') || ' ' || coalesce(name_en, '') || ' ' ||
  coalesce(slug, '') || ' ' || coalesce(summary_cn, '') || ' ' ||
  coalesce(summary_en, '') || ' ' || coalesce(material_cn, '') || ' ' ||
  coalesce(material_en, '') || ' ' || coalesce(size, '') || ' ' ||
  coalesce(application_cn, '') || ' ' || coalesce(application_en, '') || ' ' ||
  coalesce(array_to_string(search_aliases, ' '), '') || ' ' ||
  coalesce(array_to_string(keywords_cn, ' '), '') || ' ' ||
  coalesce(array_to_string(keywords_en, ' '), '')
);

create index if not exists idx_products_search_document_trgm
  on public.products using gin (search_document gin_trgm_ops);

-- 参数化公开搜索。函数使用调用者权限，products 的 RLS 继续生效。
create or replace function public.search_published_products(
  p_query text default null,
  p_category_id uuid default null,
  p_subcategory_id uuid default null,
  p_offset integer default 0,
  p_limit integer default 24
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with options as (
    select
      public.normalize_product_search(p_query) as normalized_query,
      greatest(coalesce(p_offset, 0), 0) as safe_offset,
      least(greatest(coalesce(p_limit, 24), 1), 100) as safe_limit
  ),
  matched as (
    select
      product.*,
      case
        when options.normalized_query <> '' and (
          public.normalize_product_search(product.slug) = options.normalized_query
          or public.normalize_product_search(product.size) = options.normalized_query
          or exists (
            select 1 from unnest(coalesce(product.search_aliases, array[]::text[])) alias
            where public.normalize_product_search(alias) = options.normalized_query
          )
        ) then 0
        when options.normalized_query = '' then 1
        else 2
      end as search_priority
    from public.products product
    cross join options
    where product.is_published = true
      and (p_category_id is null or product.category_id = p_category_id)
      and (p_subcategory_id is null or product.subcategory_id = p_subcategory_id)
      and (
        options.normalized_query = ''
        or product.search_document like '%' || options.normalized_query || '%'
      )
  ),
  page_rows as (
    select
      to_jsonb(matched) - 'search_document' - 'search_priority' as item,
      row_number() over (
        order by search_priority, is_featured desc, sort_order, name_cn, id
      ) as ordinal
    from matched
    order by search_priority, is_featured desc, sort_order, name_cn, id
    limit (select safe_limit from options)
    offset (select safe_offset from options)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by ordinal) from page_rows), '[]'::jsonb),
    'total', (select count(*) from matched)
  );
$$;

revoke all on function public.search_published_products(text, uuid, uuid, integer, integer) from public;
grant execute on function public.search_published_products(text, uuid, uuid, integer, integer)
  to anon, authenticated, service_role;

create table if not exists public.inquiry_items (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.inquiries(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_slug text,
  product_name_cn text,
  product_name_en text,
  quantity text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_inquiry_items_inquiry_id
  on public.inquiry_items(inquiry_id, sort_order);
create index if not exists idx_inquiry_items_product_id
  on public.inquiry_items(product_id);

alter table public.inquiry_items enable row level security;

drop policy if exists "inquiry_items_admin_all" on public.inquiry_items;
create policy "inquiry_items_admin_all"
  on public.inquiry_items for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on table public.inquiry_items to authenticated;
grant all on table public.inquiry_items to service_role;

-- service_role 专用：一次数据库函数调用中写入主询盘和全部商品项。
-- PostgreSQL 函数执行失败会回滚整个调用，不产生半成品询盘。
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
begin
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'p_items must be a JSON array';
  end if;

  insert into public.inquiries (
    name, company, country, phone, wechat, email, whatsapp,
    interested_product, quantity, message, status, language,
    source, channel, page_url, referrer, product_id, product_slug,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    is_read, read_at, notes, assignee
  ) values (
    p_inquiry->>'name', nullif(p_inquiry->>'company', ''), nullif(p_inquiry->>'country', ''),
    nullif(p_inquiry->>'phone', ''), nullif(p_inquiry->>'wechat', ''),
    nullif(p_inquiry->>'email', ''), nullif(p_inquiry->>'whatsapp', ''),
    nullif(p_inquiry->>'interested_product', ''), nullif(p_inquiry->>'quantity', ''),
    nullif(p_inquiry->>'message', ''), 'new',
    case when p_inquiry->>'language' = 'en' then 'en' else 'zh' end,
    nullif(p_inquiry->>'source', ''), nullif(p_inquiry->>'channel', ''),
    nullif(p_inquiry->>'page_url', ''), nullif(p_inquiry->>'referrer', ''),
    nullif(p_inquiry->>'product_id', '')::uuid, nullif(p_inquiry->>'product_slug', ''),
    nullif(p_inquiry->>'utm_source', ''), nullif(p_inquiry->>'utm_medium', ''),
    nullif(p_inquiry->>'utm_campaign', ''), nullif(p_inquiry->>'utm_content', ''),
    nullif(p_inquiry->>'utm_term', ''), false, null, null, null
  )
  returning * into created;

  insert into public.inquiry_items (
    inquiry_id, product_id, product_slug, product_name_cn,
    product_name_en, quantity, sort_order
  )
  select
    created.id,
    nullif(item.value->>'product_id', '')::uuid,
    nullif(item.value->>'product_slug', ''),
    nullif(item.value->>'product_name_cn', ''),
    nullif(item.value->>'product_name_en', ''),
    nullif(item.value->>'quantity', ''),
    (item.ordinality - 1)::integer
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as item(value, ordinality);

  return to_jsonb(created);
end;
$$;

revoke all on function public.create_inquiry_with_items(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_inquiry_with_items(jsonb, jsonb) to service_role;

