-- KZQ production permission hardening for Supabase's 2026 explicit Data API grants.
-- Idempotent and safe to apply to existing projects.

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_profiles
    where id = (select auth.uid())
  );
$$;

revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated, service_role;

revoke all on table
  public.admin_profiles,
  public.categories,
  public.subcategories,
  public.products,
  public.product_images,
  public.certificates,
  public.company_profile,
  public.site_settings,
  public.homepage_content,
  public.page_content,
  public.product_assets,
  public.projects,
  public.project_images,
  public.project_products,
  public.inquiries,
  public.inquiry_items,
  public.analytics_events
from public, anon, authenticated;

grant select on table
  public.categories,
  public.subcategories,
  public.products,
  public.product_images,
  public.certificates,
  public.company_profile,
  public.site_settings,
  public.homepage_content,
  public.page_content,
  public.product_assets,
  public.projects,
  public.project_images,
  public.project_products
to anon, authenticated;

grant insert, update, delete on table
  public.categories,
  public.subcategories,
  public.products,
  public.product_images,
  public.certificates,
  public.company_profile,
  public.site_settings,
  public.homepage_content,
  public.page_content,
  public.product_assets,
  public.projects,
  public.project_images,
  public.project_products,
  public.inquiries,
  public.inquiry_items
to authenticated;

grant select on table public.inquiries, public.inquiry_items to authenticated;

grant all on table
  public.admin_profiles,
  public.categories,
  public.subcategories,
  public.products,
  public.product_images,
  public.certificates,
  public.company_profile,
  public.site_settings,
  public.homepage_content,
  public.page_content,
  public.product_assets,
  public.projects,
  public.project_images,
  public.project_products,
  public.inquiries,
  public.inquiry_items,
  public.analytics_events
to service_role;

-- Keep RPCs on explicit least-privilege grants as well.
revoke all on function public.normalize_product_search(text) from public;
grant execute on function public.normalize_product_search(text) to anon, authenticated, service_role;

revoke all on function public.search_published_products(text, uuid, uuid, integer, integer) from public;
grant execute on function public.search_published_products(text, uuid, uuid, integer, integer)
  to anon, authenticated, service_role;

revoke all on function public.create_inquiry_with_items(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_inquiry_with_items(jsonb, jsonb) to service_role;

revoke all on function public.get_analytics_summary(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_analytics_summary(timestamptz, timestamptz)
  to service_role;
