-- ============================================================
-- KZQ 询盘系统升级
-- 兼容国内微信公众号 H5 与海外 B2B 官网
-- 仅追加字段、外键、索引与触发器，不删除历史字段或数据
-- ============================================================

alter table public.inquiries
  add column if not exists phone text,
  add column if not exists wechat text,
  add column if not exists language text not null default 'zh',
  add column if not exists channel text,
  add column if not exists page_url text,
  add column if not exists referrer text,
  add column if not exists product_id uuid,
  add column if not exists product_slug text,
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists is_read boolean not null default false,
  add column if not exists read_at timestamptz,
  add column if not exists notes text,
  add column if not exists assignee text,
  add column if not exists updated_at timestamptz not null default now();

-- 旧版本 source 默认固定为 h5。升级后由入口参数或 direct 明确写入。
alter table public.inquiries alter column source drop default;

-- product_id 使用独立约束，方便幂等检查；删除产品后保留询盘。
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'inquiries_product_id_fkey'
      and conrelid = 'public.inquiries'::regclass
  ) then
    alter table public.inquiries
      add constraint inquiries_product_id_fkey
      foreign key (product_id)
      references public.products(id)
      on delete set null;
  end if;
end
$$;

-- 后台常用筛选与排序索引。
create index if not exists idx_inquiries_created_at
  on public.inquiries(created_at desc);
create index if not exists idx_inquiries_status
  on public.inquiries(status);
create index if not exists idx_inquiries_is_read
  on public.inquiries(is_read);
create index if not exists idx_inquiries_language
  on public.inquiries(language);
create index if not exists idx_inquiries_source
  on public.inquiries(source);
create index if not exists idx_inquiries_product_id
  on public.inquiries(product_id);

-- 复用 schema.sql 已存在的 updated_at 函数；独立补齐以兼容单独执行。
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_inquiries_updated_at on public.inquiries;
create trigger trg_inquiries_updated_at
  before update on public.inquiries
  for each row execute function public.handle_updated_at();

-- 公司微信号用于前台复制；二维码仍沿用 wechat_qr_url。
alter table public.company_profile
  add column if not exists wechat text;
