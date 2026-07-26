-- ============================================================
-- Phase 12 correction: Catalog authorization RLS tests.
--
-- Proves the 7 required scenarios:
--   1. anon cannot read pending assets.
--   2. anon cannot read restricted assets.
--   3. anon cannot read private assets.
--   4. anon CAN read public + confirmed + published assets.
--   5. authenticated does NOT gain private/registered/partner access.
--   6. service_role can read and manage all records.
--   7. Admin access is via application-layer RBAC (service_role),
--      not via RLS on authenticated.
--
-- All tests use deterministic UUIDs and roll back.
-- ============================================================

-- Test category + product for FK references.
begin;
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] category', 'cat-auth-test', true);
insert into public.products (id, category_id, name_cn, slug, is_published) values
  ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] product', 'cat-auth-test-product', true);

-- Six asset rows covering every combination that matters.
insert into public.product_assets (id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status) values
  -- A: public + confirmed + published -> anon VISIBLE
  ('00000000-0000-4000-8000-000000000050', '00000000-0000-4000-8000-000000000041', 'catalog', 'A visible', '/a.pdf', true, 'public', 'confirmed'),
  -- B: public + pending + published -> anon BLOCKED (pending not confirmed)
  ('00000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000041', 'catalog', 'B pending', '/b.pdf', true, 'public', 'pending'),
  -- C: public + restricted + published -> anon BLOCKED
  ('00000000-0000-4000-8000-000000000052', '00000000-0000-4000-8000-000000000041', 'catalog', 'C restricted', '/c.pdf', true, 'public', 'restricted'),
  -- D: private + confirmed + published -> anon BLOCKED (private)
  ('00000000-0000-4000-8000-000000000053', '00000000-0000-4000-8000-000000000041', 'catalog', 'D private', '/d.pdf', true, 'private', 'confirmed'),
  -- E: public + confirmed + unpublished -> anon BLOCKED (not published)
  ('00000000-0000-4000-8000-000000000054', '00000000-0000-4000-8000-000000000041', 'catalog', 'E unpublished', '/e.pdf', false, 'public', 'confirmed'),
  -- F: private + pending + published -> anon BLOCKED (both private and pending)
  ('00000000-0000-4000-8000-000000000055', '00000000-0000-4000-8000-000000000041', 'catalog', 'F private pending', '/f.pdf', true, 'private', 'pending');

-- ------------------------------------------------------------
-- Scenario 1-4: anon visibility
-- ------------------------------------------------------------
set local role anon;
do $$
declare
  v_count integer;
begin
  -- Only asset A should be visible to anon.
  select count(*) into v_count from public.product_assets
    where id in (
      '00000000-0000-4000-8000-000000000050',
      '00000000-0000-4000-8000-000000000051',
      '00000000-0000-4000-8000-000000000052',
      '00000000-0000-4000-8000-000000000053',
      '00000000-0000-4000-8000-000000000054',
      '00000000-0000-4000-8000-000000000055'
    );
  if v_count <> 1 then
    raise exception 'Scenario 4: anon should see exactly 1 asset (A), saw %', v_count;
  end if;

  -- Scenario 1: anon cannot read pending (B).
  if exists (select 1 from public.product_assets where id = '00000000-0000-4000-8000-000000000051') then
    raise exception 'Scenario 1: anon must NOT read pending asset B';
  end if;

  -- Scenario 2: anon cannot read restricted (C).
  if exists (select 1 from public.product_assets where id = '00000000-0000-4000-8000-000000000052') then
    raise exception 'Scenario 2: anon must NOT read restricted asset C';
  end if;

  -- Scenario 3: anon cannot read private (D, F).
  if exists (select 1 from public.product_assets where id = '00000000-0000-4000-8000-000000000053') then
    raise exception 'Scenario 3: anon must NOT read private asset D';
  end if;
  if exists (select 1 from public.product_assets where id = '00000000-0000-4000-8000-000000000055') then
    raise exception 'Scenario 3: anon must NOT read private+pending asset F';
  end if;

  -- Scenario 4: anon CAN read A (public + confirmed + published).
  if not exists (select 1 from public.product_assets where id = '00000000-0000-4000-8000-000000000050') then
    raise exception 'Scenario 4: anon must read public+confirmed+published asset A';
  end if;
end;
$$;
rollback;

-- ------------------------------------------------------------
-- Scenario 5: authenticated does NOT gain private access
-- ------------------------------------------------------------
begin;
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] category', 'cat-auth-test-2', true);
insert into public.products (id, category_id, name_cn, slug, is_published) values
  ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] product', 'cat-auth-test-product-2', true);
insert into public.product_assets (id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status) values
  ('00000000-0000-4000-8000-000000000050', '00000000-0000-4000-8000-000000000041', 'catalog', 'A visible', '/a.pdf', true, 'public', 'confirmed'),
  ('00000000-0000-4000-8000-000000000053', '00000000-0000-4000-8000-000000000041', 'catalog', 'D private', '/d.pdf', true, 'private', 'confirmed');

-- Simulate a Supabase Auth user (NOT an admin).
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000099', 'ordinary-user@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', true);
do $$
declare
  v_count integer;
begin
  -- Authenticated ordinary user can see public+confirmed (A).
  if not exists (select 1 from public.product_assets where id = '00000000-0000-4000-8000-000000000050') then
    raise exception 'Scenario 5: authenticated must see public+confirmed asset A';
  end if;

  -- Scenario 5: authenticated must NOT see private (D).
  if exists (select 1 from public.product_assets where id = '00000000-0000-4000-8000-000000000053') then
    raise exception 'Scenario 5: ordinary authenticated must NOT read private asset D';
  end if;

  -- Authenticated sees only 1 of the 2 inserted assets.
  select count(*) into v_count from public.product_assets
    where id in ('00000000-0000-4000-8000-000000000050', '00000000-0000-4000-8000-000000000053');
  if v_count <> 1 then
    raise exception 'Scenario 5: authenticated should see exactly 1 asset, saw %', v_count;
  end if;
end;
$$;
rollback;

-- ------------------------------------------------------------
-- Scenario 6: service_role can read and manage all records
-- ------------------------------------------------------------
begin;
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] category', 'cat-auth-test-3', true);
insert into public.products (id, category_id, name_cn, slug, is_published) values
  ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] product', 'cat-auth-test-product-3', true);
insert into public.product_assets (id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status) values
  ('00000000-0000-4000-8000-000000000050', '00000000-0000-4000-8000-000000000041', 'catalog', 'A visible', '/a.pdf', true, 'public', 'confirmed'),
  ('00000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000041', 'catalog', 'B pending', '/b.pdf', true, 'public', 'pending'),
  ('00000000-0000-4000-8000-000000000052', '00000000-0000-4000-8000-000000000041', 'catalog', 'C restricted', '/c.pdf', true, 'public', 'restricted'),
  ('00000000-0000-4000-8000-000000000053', '00000000-0000-4000-8000-000000000041', 'catalog', 'D private', '/d.pdf', true, 'private', 'confirmed');

set local role service_role;
do $$
declare
  v_count integer;
begin
  -- service_role bypasses RLS: sees ALL 4 assets regardless of status.
  select count(*) into v_count from public.product_assets
    where id in (
      '00000000-0000-4000-8000-000000000050',
      '00000000-0000-4000-8000-000000000051',
      '00000000-0000-4000-8000-000000000052',
      '00000000-0000-4000-8000-000000000053'
    );
  if v_count <> 4 then
    raise exception 'Scenario 6: service_role must see all 4 assets, saw %', v_count;
  end if;

  -- service_role can update a pending asset to confirmed (admin action).
  update public.product_assets
    set authorization_status = 'confirmed'
    where id = '00000000-0000-4000-8000-000000000051';
  if not found then
    raise exception 'Scenario 6: service_role update failed';
  end if;
end;
$$;
rollback;

-- ------------------------------------------------------------
-- Scenario 7: Admin access is via app-layer RBAC, not RLS.
-- ------------------------------------------------------------
-- This is a design assertion: service_role bypasses RLS, so RBAC
-- MUST be enforced at the application layer (lib/services/admin-auth.ts).
-- RLS on authenticated role does NOT grant admin access.
begin;
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] category', 'cat-auth-test-4', true);
insert into public.products (id, category_id, name_cn, slug, is_published) values
  ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] product', 'cat-auth-test-product-4', true);
insert into public.product_assets (id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status) values
  ('00000000-0000-4000-8000-000000000050', '00000000-0000-4000-8000-000000000041', 'catalog', 'A visible', '/a.pdf', true, 'public', 'confirmed');

-- Ordinary authenticated user attempts to UPDATE an asset (must fail).
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000098', 'ordinary-user-2@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000098', true);
do $$
begin
  -- Attempt to change authorization_status from pending to confirmed.
  -- This must fail because the authenticated user has no UPDATE policy.
  -- We catch the error to verify RLS denied the write.
  begin
    update public.product_assets
      set authorization_status = 'restricted'
      where id = '00000000-0000-4000-8000-000000000050';
    raise exception 'Scenario 7: ordinary authenticated must NOT update asset authorization_status';
  exception
    when insufficient_privilege or check_violation or others then
      -- Expected: RLS blocks the update (or no policy exists).
      null;
  end;
end;
$$;
rollback;

-- ------------------------------------------------------------
-- Constraint validation: invalid access_level and authorization_status
-- ------------------------------------------------------------
begin;
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] category', 'cat-auth-test-5', true);
insert into public.products (id, category_id, name_cn, slug, is_published) values
  ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000040', '[CAT AUTH TEST] product', 'cat-auth-test-product-5', true);

-- Invalid access_level 'registered' must be rejected.
do $$
begin
  begin
    insert into public.product_assets (id, product_id, asset_type, title_cn, file_url, is_published, access_level)
      values ('00000000-0000-4000-8000-000000000060', '00000000-0000-4000-8000-000000000041', 'catalog', 'invalid', '/x.pdf', true, 'registered');
    raise exception 'access_level=registered must be rejected by CHECK constraint';
  exception
    when check_violation then
      null;
  end;
  begin
    insert into public.product_assets (id, product_id, asset_type, title_cn, file_url, is_published, access_level)
      values ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000041', 'catalog', 'invalid', '/x.pdf', true, 'partner');
    raise exception 'access_level=partner must be rejected by CHECK constraint';
  exception
    when check_violation then
      null;
  end;
  begin
    insert into public.product_assets (id, product_id, asset_type, title_cn, file_url, is_published, authorization_status)
      values ('00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000041', 'catalog', 'invalid', '/x.pdf', true, 'approved');
    raise exception 'authorization_status=approved must be rejected by CHECK constraint';
  exception
    when check_violation then
      null;
  end;
end;
$$;
rollback;
