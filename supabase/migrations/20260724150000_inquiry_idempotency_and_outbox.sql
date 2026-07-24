-- ============================================================
-- Phase 5: 询盘幂等 + Outbox 可靠通知
--
-- 目标：
--   1. 兼容网络重试：浏览器生成 client_submission_id，重试复用同一 ID，
--      服务端在 RPC 内对相同 submission_id 返回已有询盘而非重复插入。
--   2. Outbox 模式：询盘与 outbox 事件在同一事务中写入，通知处理可重试，
--      避免通知失败回滚已成功的询盘或反向导致重复通知。
--
-- 安全契约：
--   * 所有新增对象显式 public.<name> 限定
--   * RPC: language plpgsql, security invoker, set search_path = ''
--   * 显式 revoke public/anon/authenticated，仅 grant service_role
--   * 不修改任何历史 migration，不删除既有数据
--   * 本 migration 不在本次 commit 中执行
-- ============================================================

-- ------------------------------------------------------------
-- 1. inquiries.client_submission_id (nullable + 非空唯一)
-- ------------------------------------------------------------
-- 兼容历史询盘：列允许 NULL，唯一约束只对非 NULL 值生效。
-- 浏览器每次用户主动提交生成一个 UUID，网络重试复用同一 UUID。
alter table public.inquiries
  add column if not exists client_submission_id uuid;

-- 部分唯一索引：仅当 client_submission_id IS NOT NULL 时唯一。
-- 老数据 NULL 不受影响，新数据相同 submission_id 复用同一行。
create unique index if not exists inquiries_client_submission_id_unique
  on public.inquiries(client_submission_id)
  where client_submission_id is not null;

-- ------------------------------------------------------------
-- 2. inquiry_outbox 表 (Outbox 模式)
-- ------------------------------------------------------------
-- 与 inquiries 同事务写入，保证至少一次投递。
-- 通知处理器读取 status='pending'，调用外部 webhook/email，
-- 成功置 status='sent'，失败 attempts++ 并设置 next_retry_at。
-- attempts >= max_attempts 时置 status='dead_letter'，需人工处理。
create table if not exists public.inquiry_outbox (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.inquiries(id) on delete cascade,
  event_type text not null default 'inquiry_created',
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_retry_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_inquiry_outbox_status_retry
  on public.inquiry_outbox(status, next_retry_at)
  where status in ('pending', 'retry');
create index if not exists idx_inquiry_outbox_inquiry_id
  on public.inquiry_outbox(inquiry_id);

alter table public.inquiry_outbox enable row level security;

-- service_role 绕过 RLS；anon/authenticated 显式不授权。
-- 没有 policy => anon/authenticated 在 RLS 下完全不可见。
-- 此表不对外公开；通知处理器以 service_role 运行。
revoke all on table public.inquiry_outbox from public, anon, authenticated;
grant all on table public.inquiry_outbox to service_role;

-- ------------------------------------------------------------
-- 3. 替换 create_inquiry_with_items
-- ------------------------------------------------------------
-- 必须使用 DROP + CREATE 因为参数列表变化（新增 p_client_submission_id）。
-- 旧版本仅 service_role 可调用，因此重建不会破坏公开 API。
--
-- 幂等行为：
--   * p_client_submission_id IS NULL  -> 普通插入（兼容旧调用方）
--   * p_client_submission_id IS NOT NULL
--       - 若已存在相同 submission_id 的询盘，返回该行（不重复插入，不重复 outbox）
--       - 否则插入新行 + outbox 事件，全部在同一事务内
--
-- 返回 jsonb 结构：
--   {
--     "inquiry":   <inquiries row as jsonb>,
--     "idempotent": <true|false>,        -- true 表示命中已有行
--     "outbox_id":  <uuid|null>          -- 本次事务写入的 outbox 事件 id
--   }
-- 旧调用方仅看 "inquiry" 顶层字段；新调用方可读 idempotent/outbox_id。
drop function if exists public.create_inquiry_with_items(jsonb, jsonb);

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
begin
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'p_items must be a JSON array' using errcode = '22023';
  end if;

  -- 幂等：相同 client_submission_id 已存在 -> 返回已有行，不重复插入
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

  -- 插入询盘主行（显式列名，仅白名单字段）
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
    nullif(p_inquiry->>'interested_product', ''),
    nullif(p_inquiry->>'quantity', ''),
    nullif(p_inquiry->>'message', ''),
    'new',
    case when p_inquiry->>'language' = 'en' then 'en' else 'zh' end,
    nullif(p_inquiry->>'source', ''),
    nullif(p_inquiry->>'channel', ''),
    nullif(p_inquiry->>'page_url', ''),
    nullif(p_inquiry->>'referrer', ''),
    nullif(p_inquiry->>'product_id', '')::uuid,
    nullif(p_inquiry->>'product_slug', ''),
    nullif(p_inquiry->>'utm_source', ''),
    nullif(p_inquiry->>'utm_medium', ''),
    nullif(p_inquiry->>'utm_campaign', ''),
    nullif(p_inquiry->>'utm_content', ''),
    nullif(p_inquiry->>'utm_term', ''),
    false, null, null, null,
    p_client_submission_id
  )
  returning * into v_created;

  -- 插入询盘商品项（同事务）
  insert into public.inquiry_items (
    inquiry_id, product_id, product_slug, product_name_cn,
    product_name_en, quantity, sort_order
  )
  select
    v_created.id,
    nullif(item.value->>'product_id', '')::uuid,
    nullif(item.value->>'product_slug', ''),
    nullif(item.value->>'product_name_cn', ''),
    nullif(item.value->>'product_name_en', ''),
    nullif(item.value->>'quantity', ''),
    (item.ordinality - 1)::integer
  from jsonb_array_elements(v_items) with ordinality as item(value, ordinality);

  -- 写 Outbox 事件（同事务，保证至少一次投递）
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

-- 权限：仅 service_role 可调用（anon/authenticated 不授予）
revoke all on function public.create_inquiry_with_items(jsonb, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.create_inquiry_with_items(jsonb, jsonb, uuid)
  to service_role;

-- ------------------------------------------------------------
-- 4. claim_inquiry_outbox_batch(limit)
-- ------------------------------------------------------------
-- 通知处理器以 service_role 调用：原子取出待处理事件并标记 retry/sent。
-- 使用 FOR UPDATE SKIP LOCKED 避免多实例重复处理。
-- 失败时由处理器显式调用 fail_inquiry_outbox_event 推进 attempts。
create or replace function public.claim_inquiry_outbox_batch(
  p_limit integer default 10
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_safe_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_ids uuid[];
  v_rows jsonb;
begin
  -- 取一批 pending/retry 且到 next_retry_at 的事件 id
  with picked as (
    select id
      from public.inquiry_outbox
      where status in ('pending', 'retry')
        and next_retry_at <= now()
        and attempts < max_attempts
      order by next_retry_at
      limit v_safe_limit
      for update skip locked
  ),
  marked as (
    update public.inquiry_outbox
      set status = 'processing',
          updated_at = now()
      where id in (select id from picked)
      returning id, inquiry_id
  )
  select jsonb_agg(to_jsonb(marked)) into v_rows
    from marked;

  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

revoke all on function public.claim_inquiry_outbox_batch(integer)
  from public, anon, authenticated;
grant execute on function public.claim_inquiry_outbox_batch(integer)
  to service_role;

-- ------------------------------------------------------------
-- 5. mark_inquiry_outbox_sent(p_ids uuid[])
-- ------------------------------------------------------------
create or replace function public.mark_inquiry_outbox_sent(
  p_ids uuid[]
) returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_ids is null or jsonb_typeof(to_jsonb(p_ids)) = 'null' then
    return;
  end if;

  update public.inquiry_outbox
    set status = 'sent',
        last_error_code = null,
        updated_at = now()
    where id = any(p_ids);
end;
$$;

revoke all on function public.mark_inquiry_outbox_sent(uuid[])
  from public, anon, authenticated;
grant execute on function public.mark_inquiry_outbox_sent(uuid[])
  to service_role;

-- ------------------------------------------------------------
-- 6. fail_inquiry_outbox_event(p_id, p_error_code)
-- ------------------------------------------------------------
-- 推进 attempts；未达上限置 retry 并指数退避；达上限置 dead_letter。
create or replace function public.fail_inquiry_outbox_event(
  p_id uuid,
  p_error_code text default null
) returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
begin
  select attempts, max_attempts
    into v_attempts, v_max_attempts
    from public.inquiry_outbox
    where id = p_id
    for update;

  if not found then
    return;
  end if;

  v_attempts := v_attempts + 1;

  if v_attempts >= v_max_attempts then
    update public.inquiry_outbox
      set status = 'dead_letter',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          next_retry_at = null,
          updated_at = now()
      where id = p_id;
  else
    update public.inquiry_outbox
      set status = 'retry',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          -- 指数退避：60s, 120s, 240s, 480s, ... 上限 30 分钟
          next_retry_at = now() + least(
            (interval '60 seconds') * power(2, v_attempts - 1),
            interval '30 minutes'
          ),
          updated_at = now()
      where id = p_id;
  end if;
end;
$$;

revoke all on function public.fail_inquiry_outbox_event(uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_inquiry_outbox_event(uuid, text)
  to service_role;
