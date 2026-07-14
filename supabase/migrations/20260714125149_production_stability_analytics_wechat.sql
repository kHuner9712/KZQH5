-- ============================================================
-- KZQ 第一方事件统计
-- 仅记录页面与交互事件；不记录 IP、指纹或询盘表单个人内容。
-- 匿名角色不能直接写入，所有事件必须经过服务端 API。
-- ============================================================

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  locale text not null default 'zh',
  page_path text not null,
  product_id uuid references public.products(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  source text,
  channel text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  created_at timestamptz not null default now(),
  constraint analytics_events_event_name_check check (event_name in (
    'page_view', 'product_view', 'product_search', 'category_click',
    'phone_click', 'wechat_copy', 'whatsapp_click', 'email_click',
    'add_to_inquiry', 'inquiry_start', 'inquiry_success',
    'catalog_download', 'certificate_view', 'project_view'
  )),
  constraint analytics_events_locale_check check (locale in ('zh', 'en')),
  constraint analytics_events_page_path_check check (
    length(page_path) between 1 and 1000 and left(page_path, 1) = '/'
  ),
  constraint analytics_events_source_length_check check (source is null or length(source) <= 200),
  constraint analytics_events_channel_length_check check (channel is null or length(channel) <= 200),
  constraint analytics_events_utm_source_length_check check (utm_source is null or length(utm_source) <= 200),
  constraint analytics_events_utm_medium_length_check check (utm_medium is null or length(utm_medium) <= 200),
  constraint analytics_events_utm_campaign_length_check check (utm_campaign is null or length(utm_campaign) <= 200),
  constraint analytics_events_referrer_length_check check (referrer is null or length(referrer) <= 1000)
);

create index analytics_events_created_at_idx
  on public.analytics_events(created_at desc);
create index analytics_events_name_created_at_idx
  on public.analytics_events(event_name, created_at desc);
create index analytics_events_product_created_at_idx
  on public.analytics_events(product_id, created_at desc)
  where product_id is not null;
create index analytics_events_project_created_at_idx
  on public.analytics_events(project_id, created_at desc)
  where project_id is not null;
create index analytics_events_source_created_at_idx
  on public.analytics_events(source, created_at desc)
  where source is not null;

alter table public.analytics_events enable row level security;

-- 不创建 anon/authenticated policy；即使 Data API 暴露 public schema 也无法直接读写。
revoke all on table public.analytics_events from public, anon, authenticated;
grant select, insert on table public.analytics_events to service_role;

-- 聚合在数据库内完成，避免后台下载大量原始事件。
-- 函数使用调用者权限，并且只向 service_role 开放。
create or replace function public.get_analytics_summary(
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with filtered as (
    select *
    from public.analytics_events
    where created_at >= p_start and created_at < p_end
  ),
  product_stats as (
    select
      event.product_id,
      coalesce(product.name_cn, product.name_en, event.product_id::text) as product_name,
      count(*)::bigint as event_count
    from filtered event
    left join public.products product on product.id = event.product_id
    where event.event_name = 'product_view' and event.product_id is not null
    group by event.product_id, product.name_cn, product.name_en
    order by event_count desc, product_name
    limit 10
  ),
  search_stats as (
    select
      substring(page_path from '[?&]q=([^&]+)') as search_term,
      count(*)::bigint as event_count
    from filtered
    where event_name = 'product_search'
      and substring(page_path from '[?&]q=([^&]+)') is not null
    group by search_term
    order by event_count desc, search_term
    limit 10
  ),
  source_stats as (
    select coalesce(nullif(source, ''), 'direct') as source_name, count(*)::bigint as event_count
    from filtered
    group by source_name
    order by event_count desc, source_name
    limit 20
  ),
  utm_stats as (
    select
      coalesce(nullif(utm_source, ''), '(none)') as utm_source,
      coalesce(nullif(utm_medium, ''), '(none)') as utm_medium,
      coalesce(nullif(utm_campaign, ''), '(none)') as utm_campaign,
      count(*)::bigint as event_count
    from filtered
    where utm_source is not null or utm_medium is not null or utm_campaign is not null
    group by 1, 2, 3
    order by event_count desc, utm_source, utm_medium, utm_campaign
    limit 20
  )
  select jsonb_build_object(
    'page_views', (select count(*) from filtered where event_name = 'page_view'),
    'product_views', (select count(*) from filtered where event_name = 'product_view'),
    'contact_clicks', (select count(*) from filtered where event_name in ('phone_click', 'wechat_copy', 'whatsapp_click', 'email_click')),
    'inquiry_successes', (select count(*) from filtered where event_name = 'inquiry_success'),
    'popular_products', coalesce((select jsonb_agg(jsonb_build_object('product_id', product_id, 'name', product_name, 'count', event_count) order by event_count desc) from product_stats), '[]'::jsonb),
    'popular_searches', coalesce((select jsonb_agg(jsonb_build_object('term', search_term, 'count', event_count) order by event_count desc) from search_stats), '[]'::jsonb),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('source', source_name, 'count', event_count) order by event_count desc) from source_stats), '[]'::jsonb),
    'utm', coalesce((select jsonb_agg(jsonb_build_object('source', utm_source, 'medium', utm_medium, 'campaign', utm_campaign, 'count', event_count) order by event_count desc) from utm_stats), '[]'::jsonb)
  );
$$;

revoke all on function public.get_analytics_summary(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_analytics_summary(timestamptz, timestamptz)
  to service_role;
