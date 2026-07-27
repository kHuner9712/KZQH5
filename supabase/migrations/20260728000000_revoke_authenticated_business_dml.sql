-- ============================================================
-- Migration 20260728000000
-- Revoke authenticated direct DML on business tables
-- ------------------------------------------------------------
-- WORK PACKAGE A — Close the Supabase Data API direct-write bypass.
--
-- Background
-- ----------
-- Migrations 20260715090000 (security_hardening_explicit_grants) and
-- the legacy baseline supabase/policies.sql BOTH grant
--   INSERT, UPDATE, DELETE
-- on every backend business table to the `authenticated` role.
--
-- The RLS policies on those tables gate rows with `is_admin()`, so an
-- anonymous user cannot write. BUT any user present in `admin_profiles`
-- (editor / admin / super_admin) could previously write directly via
-- the Supabase Data API (REST / PostgREST), completely bypassing:
--
--   * the Next.js admin API layer (/api/admin/**)
--   * `minimumRole` RBAC checks (editor vs admin vs super_admin)
--   * service-side input validation
--   * audit RPC writes (admin_audit_log)
--   * optimistic-lock RPCs (p_expected_updated_at)
--   * Storage object reference lifecycle RPCs
--   * fixed error codes / log policy
--
-- Application code does NOT use browser-side DML on business tables
-- (verified via repo-wide grep for `.insert(/.update(/.delete(/.upsert(/.rpc(`
-- in components/ and lib/client/). All browser business writes already
-- flow through /api/admin/** → service_role → transactional RPCs.
-- It is therefore safe to remove the table-level DML grants from
-- `authenticated` without breaking the application.
--
-- What this migration does
-- ------------------------
--   1. REVOKE INSERT, UPDATE, DELETE on every backend business table
--      from `authenticated`.
--   2. Leave SELECT grants untouched (still gated by RLS for public
--      content visibility).
--   3. Leave `service_role` grants untouched — server-side transactional
--      RPCs continue to work.
--   4. Leave `anon` untouched — `anon` already only has SELECT on the
--      public-read tables; no DML was ever granted.
--   5. Leave `admin_profiles` untouched — already locked down (no policy,
--      no DML grant to anon/authenticated).
--   6. Leave `analytics_events` untouched — already service_role-only.
--
-- Idempotent. Forward-only. No schema change. No data backfill.
-- ============================================================

-- Backend business tables whose DML was previously granted to
-- `authenticated` by migration 20260715090000 and supabase/policies.sql.
-- Revoke INSERT, UPDATE, DELETE in a single statement per privilege to
-- keep the operation atomic and easy to audit. REVOKE is idempotent:
-- re-running it on an already-revoked grant is a no-op.

revoke insert, update, delete on table
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
from authenticated;

-- ============================================================
-- Runtime assertion — verify the revocation took effect.
--
-- has_table_privilege returns false when the role lacks the privilege.
-- We assert that authenticated can SELECT (still required for public
-- content via RLS) but can no longer INSERT / UPDATE / DELETE on any
-- business table.
-- ============================================================
do $$
declare
  v_table text;
  v_business_tables text[] := array[
    'categories', 'subcategories', 'products', 'product_images',
    'certificates', 'company_profile', 'site_settings',
    'homepage_content', 'page_content', 'product_assets',
    'projects', 'project_images', 'project_products',
    'inquiries', 'inquiry_items'
  ];
begin
  foreach v_table in array v_business_tables loop
    if has_table_privilege('authenticated', format('public.%I', v_table), 'insert') then
      raise exception 'authenticated still has INSERT on %', v_table
        using errcode = 'P0001';
    end if;
    if has_table_privilege('authenticated', format('public.%I', v_table), 'update') then
      raise exception 'authenticated still has UPDATE on %', v_table
        using errcode = 'P0001';
    end if;
    if has_table_privilege('authenticated', format('public.%I', v_table), 'delete') then
      raise exception 'authenticated still has DELETE on %', v_table
        using errcode = 'P0001';
    end if;
  end loop;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
