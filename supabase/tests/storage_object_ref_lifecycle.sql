-- ============================================================
-- Phase 18 (Section 4.6): storage_object_refs lifecycle tests.
--
-- Proves the pending_delete lifecycle wired by 20260725261000 and
-- the unified Source retention policy wired by 20260725270000:
--
--   A. Product Asset Draft creates an active 'source' ref.
--   B. Draft replacement produces a new active ref; old ref -> pending_delete.
--   C. Old private object is atomically enqueued in storage_cleanup_queue.
--   D. Same-path update does NOT re-enqueue or create a new ref.
--   E. Catalog Publish: public ref active, source ref STAYS active
--      (Source retention policy — no cleanup enqueued for source).
--   F. Cleanup success: matching refs -> deleted.
--   G. Cleanup failure: refs stay pending_delete (NOT deleted).
--   H. Unpublish: published ref -> pending_delete.
--   I. Delete business row: all active refs -> pending_delete.
--   J. Certificate equivalent flow (draft -> publish).
--   K. Registry write failure rolls back business write + audit.
--   L. At most one active ref per (owner_type, owner_id, role).
--   M. Publish -> Unpublish -> Republish: source retained throughout.
--
-- All tests use deterministic UUIDs and ROLLBACK.
-- ============================================================

-- ============================================================
-- Common seed: category + product for FK references.
-- ============================================================
begin;
set local role service_role;

insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000300', '[REF LIFECYCLE] category', 'ref-lifecycle-cat', true)
on conflict (id) do nothing;

insert into public.products (
  id, category_id, name_cn, slug, is_published, cover_image_url
) values (
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000300',
  '[REF LIFECYCLE] product',
  'ref-lifecycle-product',
  true,
  'https://example.supabase.co/storage/v1/object/public/public-assets/products/cover.jpg'
)
on conflict (id) do nothing;

-- ============================================================
-- A. Product Asset Draft creates an active 'source' ref.
-- ============================================================
do $$
declare
  v_result jsonb;
  v_asset_id uuid;
  v_ref_id uuid;
  v_ref_count integer;
  v_ref_status text;
begin
  v_result := public.save_product_asset_draft(
    p_id := null,
    p_payload := jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-000000000301',
      'asset_type', 'catalog',
      'title_cn', '[REF LIFECYCLE] asset A',
      'catalog_topic_id', 'ref-lifecycle-topic-A',
      'is_published', false,
      'access_level', 'private',
      'authorization_status', 'pending'
    ),
    p_source_bucket := 'private-assets',
    p_source_object_path := 'catalog-assets/ref-A-source.pdf',
    p_mime_type := 'application/pdf',
    p_file_size := 1024,
    p_sha256 := 'aaa0000000000000000000000000000000000000000000000000000000000000',
    p_actor_id := null,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  v_asset_id := (v_result->>'id')::uuid;
  if v_asset_id is null then
    raise exception 'A: save_product_asset_draft returned no id'
      using errcode = 'P0001';
  end if;

  -- Verify exactly one active 'source' ref exists.
  select count(*), max(status)
    into v_ref_count, v_ref_status
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source';

  if v_ref_count <> 1 or v_ref_status <> 'active' then
    raise exception
      'A: expected 1 active source ref, got count=% status=%',
      v_ref_count, v_ref_status
      using errcode = 'P0001';
  end if;

  -- Verify the ref points at the right object.
  if not exists (
    select 1 from public.storage_object_refs
      where owner_type = 'product_asset'
        and owner_id = v_asset_id
        and role = 'source'
        and status = 'active'
        and bucket = 'private-assets'
        and object_path = 'catalog-assets/ref-A-source.pdf'
  ) then
    raise exception 'A: source ref has wrong bucket/path'
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- B. Draft replacement: old ref -> pending_delete, new ref -> active.
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_old_updated_at timestamptz;
  v_result jsonb;
  v_active_count integer;
  v_pending_count integer;
  v_active_path text;
begin
  -- Find the asset created in section A.
  select id, updated_at into v_asset_id, v_old_updated_at
    from public.product_assets
    where title_cn = '[REF LIFECYCLE] asset A'
    limit 1;

  if v_asset_id is null then
    raise exception 'B: setup asset not found' using errcode = 'P0001';
  end if;

  -- Replace with a different source path.
  v_result := public.save_product_asset_draft(
    p_id := v_asset_id,
    p_payload := jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-000000000301',
      'asset_type', 'catalog',
      'title_cn', '[REF LIFECYCLE] asset A',
      'catalog_topic_id', 'ref-lifecycle-topic-A',
      'is_published', false,
      'access_level', 'private',
      'authorization_status', 'pending'
    ),
    p_source_bucket := 'private-assets',
    p_source_object_path := 'catalog-assets/ref-A-source-v2.pdf',
    p_mime_type := 'application/pdf',
    p_file_size := 2048,
    p_sha256 := 'bbb0000000000000000000000000000000000000000000000000000000000000',
    p_expected_updated_at := v_old_updated_at,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  if (v_result->>'path_changed')::boolean is not true then
    raise exception 'B: path_changed should be true'
      using errcode = 'P0001';
  end if;

  -- Exactly one active ref pointing at the new path.
  select count(*), max(object_path)
    into v_active_count, v_active_path
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'active';

  if v_active_count <> 1 or v_active_path <> 'catalog-assets/ref-A-source-v2.pdf' then
    raise exception
      'B: expected 1 active ref for new path, got count=% path=%',
      v_active_count, v_active_path
      using errcode = 'P0001';
  end if;

  -- Exactly one pending_delete ref pointing at the old path.
  select count(*)
    into v_pending_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'pending_delete'
      and object_path = 'catalog-assets/ref-A-source.pdf';

  if v_pending_count <> 1 then
    raise exception
      'B: expected 1 pending_delete ref for old path, got %',
      v_pending_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- C. Old private object atomically enqueued in cleanup queue.
-- ============================================================
do $$
declare
  v_count integer;
begin
  select count(*)
    into v_count
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-A-source.pdf'
      and status in ('pending', 'claimed', 'retry');

  if v_count <> 1 then
    raise exception
      'C: expected 1 cleanup queue row for old source path, got %',
      v_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- D. Same-path update does NOT re-enqueue or create a new ref.
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_old_updated_at timestamptz;
  v_result jsonb;
  v_active_count integer;
  v_pending_count integer;
  v_cleanup_count integer;
begin
  select id, updated_at into v_asset_id, v_old_updated_at
    from public.product_assets
    where title_cn = '[REF LIFECYCLE] asset A'
    limit 1;

  -- Capture the cleanup queue count before the same-path update.
  select count(*)
    into v_cleanup_count
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-A-source-v2.pdf';

  -- Update with the SAME path (only metadata changes).
  v_result := public.save_product_asset_draft(
    p_id := v_asset_id,
    p_payload := jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-000000000301',
      'asset_type', 'catalog',
      'title_cn', '[REF LIFECYCLE] asset A (metadata refresh)',
      'catalog_topic_id', 'ref-lifecycle-topic-A',
      'is_published', false,
      'access_level', 'private',
      'authorization_status', 'pending'
    ),
    p_source_bucket := 'private-assets',
    p_source_object_path := 'catalog-assets/ref-A-source-v2.pdf',
    p_mime_type := 'application/pdf',
    p_file_size := 4096,
    p_sha256 := 'ccc0000000000000000000000000000000000000000000000000000000000000',
    p_expected_updated_at := v_old_updated_at,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  if (v_result->>'path_changed')::boolean is not false then
    raise exception 'D: path_changed should be false for same path'
      using errcode = 'P0001';
  end if;

  -- Still exactly 1 active ref (no new ref created).
  select count(*)
    into v_active_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'active';

  if v_active_count <> 1 then
    raise exception
      'D: expected 1 active ref after same-path update, got %',
      v_active_count
      using errcode = 'P0001';
  end if;

  -- Still exactly 1 pending_delete ref (no extra supersede).
  select count(*)
    into v_pending_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'pending_delete';

  if v_pending_count <> 1 then
    raise exception
      'D: expected 1 pending_delete ref after same-path update, got %',
      v_pending_count
      using errcode = 'P0001';
  end if;

  -- No NEW cleanup row for the same path.
  select count(*)
    into v_cleanup_count
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-A-source-v2.pdf';

  if v_cleanup_count <> 0 then
    raise exception
      'D: no cleanup row should exist for the unchanged path, got %',
      v_cleanup_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- E. Catalog Publish: public ref active, source ref STAYS active.
-- ============================================================
-- Source retention policy (20260725270000):
--   * Publish must NOT transition source ref to pending_delete.
--   * Publish must NOT enqueue a cleanup for the private source.
--   * source_bucket / source_object_path columns must be preserved.
--   * Only the published ref is registered (active).
-- This is the OPPOSITE of the pre-20260725270000 behavior, which
-- deleted the private source on publish and broke republish.
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_publish_token uuid := '00000000-0000-4000-8000-000000000310';
  v_result jsonb;
  v_published_active_count integer;
  v_source_active_count integer;
  v_source_pending_count integer;
  v_cleanup_count integer;
  v_source_bucket text;
  v_source_path text;
begin
  select id into v_asset_id
    from public.product_assets
    where title_cn like '[REF LIFECYCLE] asset A%'
    order by updated_at desc
    limit 1;

  -- Transition to publishing state so finalize can proceed.
  update public.product_assets set
    publish_status = 'publishing',
    publish_token = v_publish_token,
    publish_started_at = now()
  where id = v_asset_id;

  v_result := public.finalize_catalog_asset_publish(
    p_asset_id := v_asset_id,
    p_publish_token := v_publish_token,
    p_public_bucket := 'public-assets',
    p_public_object_path := 'catalog-assets/ref-A-published.pdf',
    p_public_url := 'https://example.supabase.co/storage/v1/object/public/public-assets/catalog-assets/ref-A-published.pdf',
    p_mime_type := 'application/pdf',
    p_size_bytes := 2048,
    p_sha256 := 'ddd0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  if (v_result->>'status') <> 'published' then
    raise exception 'E: finalize should return published, got %',
      v_result->>'status'
      using errcode = 'P0001';
  end if;

  -- The result must declare source_retained=true.
  if coalesce((v_result->>'source_retained')::boolean, false) is not true then
    raise exception
      'E: finalize result should declare source_retained=true, got %',
      v_result->>'source_retained'
      using errcode = 'P0001';
  end if;

  -- Published ref must be active.
  select count(*)
    into v_published_active_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'published'
      and status = 'active'
      and bucket = 'public-assets'
      and object_path = 'catalog-assets/ref-A-published.pdf';

  if v_published_active_count <> 1 then
    raise exception
      'E: expected 1 active published ref, got %',
      v_published_active_count
      using errcode = 'P0001';
  end if;

  -- Source ref MUST STAY ACTIVE (NOT pending_delete, NOT superseded).
  -- This is the core assertion of the Source retention policy.
  select count(*)
    into v_source_active_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'active'
      and bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-A-source-v2.pdf';

  if v_source_active_count <> 1 then
    raise exception
      'E: expected 1 ACTIVE source ref (Source retention policy), got %',
      v_source_active_count
      using errcode = 'P0001';
  end if;

  -- There must be NO newly-pending_delete source ref on publish.
  -- (The pending_delete ref from test B for ref-A-source.pdf is
  -- still there, but it was created by Draft replace, not publish.)
  -- We assert the count did not increase: 1 pending_delete (from B).
  select count(*)
    into v_source_pending_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'pending_delete';

  if v_source_pending_count <> 1 then
    raise exception
      'E: expected 1 pending_delete source ref (from Draft replace, not publish), got %',
      v_source_pending_count
      using errcode = 'P0001';
  end if;

  -- NO cleanup row must exist for the CURRENT source path
  -- (catalog-assets/ref-A-source-v2.pdf). Publish does not enqueue
  -- source cleanup. The cleanup row from test B is for the OLD
  -- path (catalog-assets/ref-A-source.pdf), not the current one.
  select count(*)
    into v_cleanup_count
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-A-source-v2.pdf'
      and status in ('pending', 'claimed', 'retry');

  if v_cleanup_count <> 0 then
    raise exception
      'E: expected 0 cleanup rows for current source path (Source retention), got %',
      v_cleanup_count
      using errcode = 'P0001';
  end if;

  -- source_bucket / source_object_path columns must be preserved.
  select source_bucket, source_object_path
    into v_source_bucket, v_source_path
    from public.product_assets
    where id = v_asset_id;

  if v_source_bucket is null or v_source_bucket <> 'private-assets' then
    raise exception
      'E: source_bucket should be preserved as private-assets, got %',
      coalesce(v_source_bucket, '<null>')
      using errcode = 'P0001';
  end if;

  if v_source_path is null or v_source_path <> 'catalog-assets/ref-A-source-v2.pdf' then
    raise exception
      'E: source_object_path should be preserved, got %',
      coalesce(v_source_path, '<null>')
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- F. Cleanup success: matching refs -> deleted.
-- ============================================================
-- Uses the cleanup row enqueued by Draft replace in test B for the
-- OLD source path (catalog-assets/ref-A-source.pdf). After successful
-- cleanup completion, the pending_delete ref for that old path must
-- transition to 'deleted'.
--
-- The CURRENT active source ref (catalog-assets/ref-A-source-v2.pdf)
-- must NOT be affected — it has a different object_path and is not
-- matched by this cleanup.
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_cleanup_id uuid;
  v_lock_token uuid;
  v_claim_result jsonb;
  v_complete_result text;
  v_source_deleted_count integer;
  v_source_pending_count integer;
  v_source_active_count integer;
begin
  select id into v_asset_id
    from public.product_assets
    where title_cn like '[REF LIFECYCLE] asset A%'
    order by updated_at desc
    limit 1;

  -- Claim and complete the cleanup for the OLD source path
  -- (catalog-assets/ref-A-source.pdf), enqueued by test B's
  -- Draft replace.
  select id into v_cleanup_id
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-A-source.pdf'
      and status = 'pending'
    limit 1;

  if v_cleanup_id is null then
    raise exception
      'F: setup failure — cleanup row for ref-A-source.pdf not found'
      using errcode = 'P0001';
  end if;

  -- Claim it.
  v_claim_result := public.claim_storage_cleanup(10, 300);
  -- Find our row's lock_token from the claim result.
  select (value->>'lock_token')::uuid into v_lock_token
    from jsonb_array_elements(v_claim_result)
    where value->>'id' = v_cleanup_id::text
    limit 1;

  if v_lock_token is null then
    -- The row may have been claimed by the batch claim. Read the
    -- lock_token directly.
    select lock_token into v_lock_token
      from public.storage_cleanup_queue
      where id = v_cleanup_id;
  end if;

  v_complete_result := public.complete_storage_cleanup(
    p_cleanup_id := v_cleanup_id,
    p_lock_token := v_lock_token,
    p_success := true,
    p_final_status := 'deleted'
  );

  if v_complete_result <> 'completed' then
    raise exception
      'F: complete_storage_cleanup should return completed, got %',
      v_complete_result
      using errcode = 'P0001';
  end if;

  -- The OLD source ref (ref-A-source.pdf) must now be 'deleted'
  -- (was pending_delete from test B).
  select count(*)
    into v_source_deleted_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'deleted'
      and object_path = 'catalog-assets/ref-A-source.pdf';

  if v_source_deleted_count <> 1 then
    raise exception
      'F: expected 1 deleted source ref for old path, got %',
      v_source_deleted_count
      using errcode = 'P0001';
  end if;

  -- No remaining pending_delete source ref for the old path.
  select count(*)
    into v_source_pending_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'pending_delete'
      and object_path = 'catalog-assets/ref-A-source.pdf';

  if v_source_pending_count <> 0 then
    raise exception
      'F: expected 0 pending_delete source refs for old path after cleanup, got %',
      v_source_pending_count
      using errcode = 'P0001';
  end if;

  -- The CURRENT active source ref (ref-A-source-v2.pdf) must STILL
  -- be active. Cleanup of a different path must not affect it.
  select count(*)
    into v_source_active_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'active'
      and object_path = 'catalog-assets/ref-A-source-v2.pdf';

  if v_source_active_count <> 1 then
    raise exception
      'F: current active source ref must be preserved after cleanup of old path, got %',
      v_source_active_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- G. Cleanup failure: refs stay pending_delete (NOT deleted).
-- ============================================================
-- Uses Draft replace to create a cleanup for the OLD source path
-- (catalog-assets/ref-G-source.pdf). Then claims + FAILS the
-- cleanup. The pending_delete ref for the old path must STAY
-- pending_delete (NOT prematurely transitioned to 'deleted').
--
-- Under the Source retention policy (20260725270000), Publish no
-- longer creates a source cleanup, so we use Draft replace as the
-- canonical trigger for source cleanup (which is the correct
-- production path: only Draft replace and row-delete clean up the
-- private source object).
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_updated_at timestamptz;
  v_cleanup_id uuid;
  v_lock_token uuid;
  v_claim_result jsonb;
  v_complete_result text;
  v_pending_count integer;
  v_deleted_count integer;
begin
  -- Create asset G with initial source path.
  perform public.save_product_asset_draft(
    p_id := null,
    p_payload := jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-000000000301',
      'asset_type', 'catalog',
      'title_cn', '[REF LIFECYCLE] asset G',
      'catalog_topic_id', 'ref-lifecycle-topic-G',
      'is_published', false,
      'access_level', 'private',
      'authorization_status', 'pending'
    ),
    p_source_bucket := 'private-assets',
    p_source_object_path := 'catalog-assets/ref-G-source.pdf',
    p_mime_type := 'application/pdf',
    p_file_size := 512,
    p_sha256 := 'eee0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id, updated_at into v_asset_id, v_updated_at
    from public.product_assets
    where title_cn = '[REF LIFECYCLE] asset G'
    order by updated_at desc
    limit 1;

  -- Draft replace to a new source path. This enqueues a cleanup
  -- for the OLD path (ref-G-source.pdf) and transitions the old
  -- source ref to pending_delete.
  perform public.save_product_asset_draft(
    p_id := v_asset_id,
    p_payload := jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-000000000301',
      'asset_type', 'catalog',
      'title_cn', '[REF LIFECYCLE] asset G',
      'catalog_topic_id', 'ref-lifecycle-topic-G',
      'is_published', false,
      'access_level', 'private',
      'authorization_status', 'pending'
    ),
    p_source_bucket := 'private-assets',
    p_source_object_path := 'catalog-assets/ref-G-source-v2.pdf',
    p_mime_type := 'application/pdf',
    p_file_size := 768,
    p_sha256 := 'fff0000000000000000000000000000000000000000000000000000000000000',
    p_expected_updated_at := v_updated_at,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  -- Claim and FAIL the cleanup for the OLD source path.
  select id into v_cleanup_id
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-G-source.pdf'
      and status = 'pending'
    limit 1;

  if v_cleanup_id is null then
    raise exception
      'G: setup failure — cleanup row for ref-G-source.pdf not found'
      using errcode = 'P0001';
  end if;

  v_claim_result := public.claim_storage_cleanup(10, 300);
  select lock_token into v_lock_token
    from public.storage_cleanup_queue
    where id = v_cleanup_id;

  v_complete_result := public.complete_storage_cleanup(
    p_cleanup_id := v_cleanup_id,
    p_lock_token := v_lock_token,
    p_success := false,
    p_error_code := 'STORAGE_DELETE_FAILED',
    p_final_status := 'storage_delete_failed'
  );

  if v_complete_result <> 'retry' and v_complete_result <> 'dead_letter' then
    raise exception
      'G: complete_storage_cleanup should return retry or dead_letter, got %',
      v_complete_result
      using errcode = 'P0001';
  end if;

  -- The OLD source ref must still be pending_delete (NOT deleted).
  select count(*)
    into v_pending_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'pending_delete'
      and object_path = 'catalog-assets/ref-G-source.pdf';

  if v_pending_count <> 1 then
    raise exception
      'G: expected 1 pending_delete source ref for old path after cleanup failure, got %',
      v_pending_count
      using errcode = 'P0001';
  end if;

  -- No deleted source ref (cleanup failed).
  select count(*)
    into v_deleted_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'deleted';

  if v_deleted_count <> 0 then
    raise exception
      'G: expected 0 deleted source refs after cleanup failure, got %',
      v_deleted_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- H. Unpublish: published ref -> pending_delete.
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_publish_token uuid := '00000000-0000-4000-8000-000000000330';
  v_updated_at timestamptz;
  v_result jsonb;
  v_published_active integer;
  v_published_pending integer;
  v_cleanup_count integer;
begin
  -- Create + publish a third asset.
  perform public.save_product_asset_draft(
    p_id := null,
    p_payload := jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-000000000301',
      'asset_type', 'catalog',
      'title_cn', '[REF LIFECYCLE] asset H',
      'catalog_topic_id', 'ref-lifecycle-topic-H',
      'is_published', false,
      'access_level', 'private',
      'authorization_status', 'pending'
    ),
    p_source_bucket := 'private-assets',
    p_source_object_path := 'catalog-assets/ref-H-source.pdf',
    p_mime_type := 'application/pdf',
    p_file_size := 256,
    p_sha256 := '11e0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id into v_asset_id
    from public.product_assets
    where title_cn = '[REF LIFECYCLE] asset H'
    order by updated_at desc
    limit 1;

  update public.product_assets set
    publish_status = 'publishing',
    publish_token = v_publish_token,
    publish_started_at = now()
  where id = v_asset_id;

  perform public.finalize_catalog_asset_publish(
    p_asset_id := v_asset_id,
    p_publish_token := v_publish_token,
    p_public_bucket := 'public-assets',
    p_public_object_path := 'catalog-assets/ref-H-published.pdf',
    p_public_url := 'https://example.supabase.co/storage/v1/object/public/public-assets/catalog-assets/ref-H-published.pdf',
    p_mime_type := 'application/pdf',
    p_size_bytes := 256,
    p_sha256 := '22e0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  -- Now unpublish.
  select updated_at into v_updated_at
    from public.product_assets where id = v_asset_id;

  v_result := public.unpublish_catalog_asset(
    p_id := v_asset_id,
    p_expected_updated_at := v_updated_at,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  if (v_result->>'status') <> 'unpublished' then
    raise exception 'H: unpublish should return unpublished, got %',
      v_result->>'status'
      using errcode = 'P0001';
  end if;

  -- Published ref must be pending_delete (NOT deleted).
  select count(*)
    into v_published_pending
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'published'
      and status = 'pending_delete';

  if v_published_pending <> 1 then
    raise exception
      'H: expected 1 pending_delete published ref, got %',
      v_published_pending
      using errcode = 'P0001';
  end if;

  -- No active published ref.
  select count(*)
    into v_published_active
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'published'
      and status = 'active';

  if v_published_active <> 0 then
    raise exception
      'H: expected 0 active published refs after unpublish, got %',
      v_published_active
      using errcode = 'P0001';
  end if;

  -- Cleanup enqueued for the published object.
  select count(*)
    into v_cleanup_count
    from public.storage_cleanup_queue
    where bucket = 'public-assets'
      and object_path = 'catalog-assets/ref-H-published.pdf'
      and status in ('pending', 'claimed', 'retry');

  if v_cleanup_count <> 1 then
    raise exception
      'H: expected 1 cleanup row for unpublished object, got %',
      v_cleanup_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- I. Delete business row: all active refs -> pending_delete.
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_publish_token uuid := '00000000-0000-4000-8000-000000000340';
  v_updated_at timestamptz;
  v_result jsonb;
  v_pending_count integer;
  v_active_count integer;
  v_row_count integer;
begin
  -- Create + publish a fourth asset.
  perform public.save_product_asset_draft(
    p_id := null,
    p_payload := jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-000000000301',
      'asset_type', 'catalog',
      'title_cn', '[REF LIFECYCLE] asset I',
      'catalog_topic_id', 'ref-lifecycle-topic-I',
      'is_published', false,
      'access_level', 'private',
      'authorization_status', 'pending'
    ),
    p_source_bucket := 'private-assets',
    p_source_object_path := 'catalog-assets/ref-I-source.pdf',
    p_mime_type := 'application/pdf',
    p_file_size := 128,
    p_sha256 := '33e0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id into v_asset_id
    from public.product_assets
    where title_cn = '[REF LIFECYCLE] asset I'
    order by updated_at desc
    limit 1;

  update public.product_assets set
    publish_status = 'publishing',
    publish_token = v_publish_token,
    publish_started_at = now()
  where id = v_asset_id;

  perform public.finalize_catalog_asset_publish(
    p_asset_id := v_asset_id,
    p_publish_token := v_publish_token,
    p_public_bucket := 'public-assets',
    p_public_object_path := 'catalog-assets/ref-I-published.pdf',
    p_public_url := 'https://example.supabase.co/storage/v1/object/public/public-assets/catalog-assets/ref-I-published.pdf',
    p_mime_type := 'application/pdf',
    p_size_bytes := 128,
    p_sha256 := '44e0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  -- Delete the asset.
  select updated_at into v_updated_at
    from public.product_assets where id = v_asset_id;

  v_result := public.delete_product_asset_with_cleanup(
    p_id := v_asset_id,
    p_expected_updated_at := v_updated_at,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  if (v_result->>'status') <> 'deleted' then
    raise exception 'I: delete should return deleted, got %',
      v_result->>'status'
      using errcode = 'P0001';
  end if;

  -- Business row must be gone.
  select count(*) into v_row_count
    from public.product_assets where id = v_asset_id;
  if v_row_count <> 0 then
    raise exception 'I: product_assets row should be deleted'
      using errcode = 'P0001';
  end if;

  -- All refs must be pending_delete (not deleted — cleanup hasn't run).
  select count(*)
    into v_pending_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and status = 'pending_delete';

  if v_pending_count < 1 then
    raise exception
      'I: expected at least 1 pending_delete ref after delete, got %',
      v_pending_count
      using errcode = 'P0001';
  end if;

  -- No active refs.
  select count(*)
    into v_active_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and status = 'active';

  if v_active_count <> 0 then
    raise exception
      'I: expected 0 active refs after delete, got %',
      v_active_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- J. Certificate equivalent flow (draft -> publish).
-- ============================================================
-- Source retention policy (20260725270000) applies symmetrically
-- to certificates: Publish must NOT transition source ref to
-- pending_delete and must NOT enqueue a cleanup for the source.
-- ============================================================
do $$
declare
  v_cert_id uuid;
  v_publish_token uuid := '00000000-0000-4000-8000-000000000350';
  v_updated_at timestamptz;
  v_result jsonb;
  v_source_active integer;
  v_source_pending integer;
  v_published_active integer;
  v_cleanup_count integer;
  v_source_bucket text;
  v_source_path text;
begin
  -- Create certificate draft.
  perform public.save_certificate_draft(
    p_id := null,
    p_payload := jsonb_build_object(
      'name_cn', '[REF LIFECYCLE] cert J',
      'name_en', 'ref-lifecycle-cert-J',
      'is_published', false
    ),
    p_source_bucket := 'private-assets',
    p_source_object_path := 'certificates/ref-J-source.pdf',
    p_mime_type := 'application/pdf',
    p_file_size := 512,
    p_sha256 := '55e0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id into v_cert_id
    from public.certificates
    where name_cn = '[REF LIFECYCLE] cert J'
    order by updated_at desc
    limit 1;

  -- Source ref must be active.
  select count(*)
    into v_source_active
    from public.storage_object_refs
    where owner_type = 'certificate'
      and owner_id = v_cert_id
      and role = 'source'
      and status = 'active';

  if v_source_active <> 1 then
    raise exception 'J: expected 1 active source ref for certificate, got %',
      v_source_active
      using errcode = 'P0001';
  end if;

  -- Publish the certificate.
  update public.certificates set
    publish_status = 'publishing',
    publish_token = v_publish_token,
    publish_started_at = now()
  where id = v_cert_id;

  v_result := public.finalize_certificate_publish(
    p_id := v_cert_id,
    p_publish_token := v_publish_token,
    p_public_bucket := 'public-assets',
    p_public_object_path := 'certificates/ref-J-published.pdf',
    p_public_url := 'https://example.supabase.co/storage/v1/object/public/public-assets/certificates/ref-J-published.pdf',
    p_mime_type := 'application/pdf',
    p_size_bytes := 512,
    p_sha256 := '66e0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  if (v_result->>'status') <> 'published' then
    raise exception 'J: certificate publish should return published, got %',
      v_result->>'status'
      using errcode = 'P0001';
  end if;

  -- The result must declare source_retained=true.
  if coalesce((v_result->>'source_retained')::boolean, false) is not true then
    raise exception
      'J: certificate finalize result should declare source_retained=true, got %',
      v_result->>'source_retained'
      using errcode = 'P0001';
  end if;

  -- Published ref must be active.
  select count(*)
    into v_published_active
    from public.storage_object_refs
    where owner_type = 'certificate'
      and owner_id = v_cert_id
      and role = 'published'
      and status = 'active';

  if v_published_active <> 1 then
    raise exception 'J: expected 1 active published cert ref, got %',
      v_published_active
      using errcode = 'P0001';
  end if;

  -- Source ref MUST STAY ACTIVE (NOT pending_delete).
  select count(*)
    into v_source_active
    from public.storage_object_refs
    where owner_type = 'certificate'
      and owner_id = v_cert_id
      and role = 'source'
      and status = 'active'
      and bucket = 'private-assets'
      and object_path = 'certificates/ref-J-source.pdf';

  if v_source_active <> 1 then
    raise exception
      'J: expected 1 ACTIVE source cert ref (Source retention), got %',
      v_source_active
      using errcode = 'P0001';
  end if;

  -- No pending_delete source ref (nothing transitioned it).
  select count(*)
    into v_source_pending
    from public.storage_object_refs
    where owner_type = 'certificate'
      and owner_id = v_cert_id
      and role = 'source'
      and status = 'pending_delete';

  if v_source_pending <> 0 then
    raise exception
      'J: expected 0 pending_delete source cert refs after publish (Source retention), got %',
      v_source_pending
      using errcode = 'P0001';
  end if;

  -- NO cleanup row for the source path.
  select count(*)
    into v_cleanup_count
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'certificates/ref-J-source.pdf'
      and status in ('pending', 'claimed', 'retry');

  if v_cleanup_count <> 0 then
    raise exception
      'J: expected 0 cleanup rows for cert source (Source retention), got %',
      v_cleanup_count
      using errcode = 'P0001';
  end if;

  -- source_bucket / source_object_path columns must be preserved.
  select source_bucket, source_object_path
    into v_source_bucket, v_source_path
    from public.certificates
    where id = v_cert_id;

  if v_source_bucket is null or v_source_bucket <> 'private-assets' then
    raise exception
      'J: cert source_bucket should be preserved as private-assets, got %',
      coalesce(v_source_bucket, '<null>')
      using errcode = 'P0001';
  end if;

  if v_source_path is null or v_source_path <> 'certificates/ref-J-source.pdf' then
    raise exception
      'J: cert source_object_path should be preserved, got %',
      coalesce(v_source_path, '<null>')
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- K. Registry write failure rolls back business write + audit.
-- ============================================================
-- We install a trigger that makes register_storage_object_ref fail
-- for a specific path, then call save_product_asset_draft with that
-- path. The entire function must roll back: no product_assets row
-- and no audit row.
--
-- This test needs the OWNER/service_role split pattern from
-- schema_verifier_runtime.sql:
--   * CREATE FUNCTION / CREATE TRIGGER require owner (postgres)
--     because service_role has no CREATE privilege on schema public.
--   * The actual save_product_asset_draft call must run as
--     service_role because that is the role the application uses.
-- ============================================================

-- OWNER PHASE: postgres installs the blocking trigger.
reset role;

create or replace function public._tmp_block_ref_insert()
returns trigger
language plpgsql
as $func$
begin
  if new.object_path = 'catalog-assets/POISONED-PATH.pdf' then
    raise exception 'registry write deliberately blocked (test K)'
      using errcode = 'P0001';
  end if;
  return new;
end;
$func$;

create trigger _tmp_storage_object_refs_block
  before insert on public.storage_object_refs
  for each row
  execute function public._tmp_block_ref_insert();

-- CALLER PHASE: service_role runs the test.
set local role service_role;

do $$
declare
  v_count integer;
begin
  -- Attempt the draft save — it must raise.
  begin
    perform public.save_product_asset_draft(
      p_id := null,
      p_payload := jsonb_build_object(
        'product_id', '00000000-0000-4000-8000-000000000301',
        'asset_type', 'catalog',
        'title_cn', '[REF LIFECYCLE] asset K (should not exist)',
        'catalog_topic_id', 'ref-lifecycle-topic-K',
        'is_published', false,
        'access_level', 'private',
        'authorization_status', 'pending'
      ),
      p_source_bucket := 'private-assets',
      p_source_object_path := 'catalog-assets/POISONED-PATH.pdf',
      p_mime_type := 'application/pdf',
      p_file_size := 64,
      p_sha256 := '77e0000000000000000000000000000000000000000000000000000000000000',
      p_actor_email := 'test@example.invalid',
      p_actor_role := 'editor'
    );
    raise exception 'K: save_product_asset_draft should have raised'
      using errcode = 'P0001';
  exception when others then
    -- Expected: the trigger blocked the registry insert and the
    -- whole function rolled back.
    null;
  end;

  -- Verify NO product_assets row was inserted.
  select count(*)
    into v_count
    from public.product_assets
    where title_cn = '[REF LIFECYCLE] asset K (should not exist)';

  if v_count <> 0 then
    raise exception
      'K: product_assets row should NOT exist after registry failure, got %',
      v_count
      using errcode = 'P0001';
  end if;

  -- Verify NO audit row was inserted.
  select count(*)
    into v_count
    from public.admin_audit_log
    where target_type = 'product_asset'
      and metadata->>'source_object_path' = 'catalog-assets/POISONED-PATH.pdf';

  if v_count <> 0 then
    raise exception
      'K: audit row should NOT exist after registry failure, got %',
      v_count
      using errcode = 'P0001';
  end if;
end $$;

-- CLEANUP PHASE: postgres drops the trigger/function. (They will
-- also be rolled back by the final ROLLBACK, but be explicit so the
-- schema is clean if the test is ever run outside a transaction.)
reset role;
drop trigger if exists _tmp_storage_object_refs_block on public.storage_object_refs;
drop function if exists public._tmp_block_ref_insert();
set local role service_role;

-- ============================================================
-- L. At most one active ref per (owner_type, owner_id, role).
-- ============================================================
-- The unique partial index storage_object_refs_owner_role_active_uniq
-- enforces this at the DB level. We verify it by attempting a direct
-- INSERT that duplicates the active ref for an existing asset.
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_dummy_uuid uuid := '00000000-0000-4000-8000-000000000390';
  v_dup_failed boolean := false;
begin
  -- Reuse the asset from section A (still has 1 active source ref).
  select id into v_asset_id
    from public.product_assets
    where title_cn like '[REF LIFECYCLE] asset A%'
    order by updated_at desc
    limit 1;

  begin
    insert into public.storage_object_refs (
      owner_type, owner_id, role, bucket, object_path,
      visibility, status
    ) values (
      'product_asset', v_asset_id, 'source', 'private-assets',
      'catalog-assets/DUPLICATE-REF.pdf',
      'private', 'active'
    );
  exception when unique_violation then
    v_dup_failed := true;
  end;

  if not v_dup_failed then
    raise exception
      'L: duplicate active ref insert should have been rejected by unique index'
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- M. Publish -> Unpublish -> Republish: source retained throughout.
-- ============================================================
-- This is the canonical justification for the Source retention
-- policy. After Unpublish, the published object is cleaned up, but
-- the private source MUST still be present so that Republish can
-- re-derive the public derivative without requiring the user to
-- re-upload the original.
--
-- Sequence:
--   1. Create asset M (draft)             -> source ref active
--   2. Publish #1                          -> source ref STILL active
--                                            (Source retention policy)
--   3. Unpublish                           -> source ref STILL active
--                                            (only published ref pending_delete)
--   4. Complete cleanup for published obj  -> published ref -> deleted
--   5. Republish (Publish #2)              -> source ref STILL active
--                                            new published ref active
--
-- If source had been deleted on Publish #1 (pre-20260725270000
-- behavior), step 5 would have no source bytes to re-derive from.
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_publish_token_1 uuid := '00000000-0000-4000-8000-000000000360';
  v_publish_token_2 uuid := '00000000-0000-4000-8000-000000000361';
  v_updated_at timestamptz;
  v_result jsonb;
  v_cleanup_id uuid;
  v_lock_token uuid;
  v_claim_result jsonb;
  v_complete_result text;
  v_source_active integer;
  v_source_bucket text;
  v_source_path text;
  v_published_active integer;
  v_published_pending integer;
  v_published_deleted integer;
  v_cleanup_count integer;
begin
  -- 1. Create asset M (draft).
  perform public.save_product_asset_draft(
    p_id := null,
    p_payload := jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-000000000301',
      'asset_type', 'catalog',
      'title_cn', '[REF LIFECYCLE] asset M',
      'catalog_topic_id', 'ref-lifecycle-topic-M',
      'is_published', false,
      'access_level', 'private',
      'authorization_status', 'pending'
    ),
    p_source_bucket := 'private-assets',
    p_source_object_path := 'catalog-assets/ref-M-source.pdf',
    p_mime_type := 'application/pdf',
    p_file_size := 1024,
    p_sha256 := '88e0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id into v_asset_id
    from public.product_assets
    where title_cn = '[REF LIFECYCLE] asset M'
    order by updated_at desc
    limit 1;

  -- 2. Publish #1.
  update public.product_assets set
    publish_status = 'publishing',
    publish_token = v_publish_token_1,
    publish_started_at = now()
  where id = v_asset_id;

  perform public.finalize_catalog_asset_publish(
    p_asset_id := v_asset_id,
    p_publish_token := v_publish_token_1,
    p_public_bucket := 'public-assets',
    p_public_object_path := 'catalog-assets/ref-M-published-v1.pdf',
    p_public_url := 'https://example.supabase.co/storage/v1/object/public/public-assets/catalog-assets/ref-M-published-v1.pdf',
    p_mime_type := 'application/pdf',
    p_size_bytes := 1024,
    p_sha256 := '99e0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  -- Source ref must STILL be active after Publish #1.
  select count(*)
    into v_source_active
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'active'
      and bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-M-source.pdf';

  if v_source_active <> 1 then
    raise exception
      'M.2: source ref must be active after Publish #1, got %',
      v_source_active
      using errcode = 'P0001';
  end if;

  -- 3. Unpublish.
  select updated_at into v_updated_at
    from public.product_assets where id = v_asset_id;

  v_result := public.unpublish_catalog_asset(
    p_id := v_asset_id,
    p_expected_updated_at := v_updated_at,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  if (v_result->>'status') <> 'unpublished' then
    raise exception 'M.3: unpublish should return unpublished, got %',
      v_result->>'status'
      using errcode = 'P0001';
  end if;

  -- Source ref must STILL be active after Unpublish.
  select count(*)
    into v_source_active
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'active';

  if v_source_active <> 1 then
    raise exception
      'M.3: source ref must be active after Unpublish, got %',
      v_source_active
      using errcode = 'P0001';
  end if;

  -- Published ref must be pending_delete.
  select count(*)
    into v_published_pending
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'published'
      and status = 'pending_delete';

  if v_published_pending <> 1 then
    raise exception
      'M.3: expected 1 pending_delete published ref after unpublish, got %',
      v_published_pending
      using errcode = 'P0001';
  end if;

  -- 4. Complete cleanup for the published object.
  select id into v_cleanup_id
    from public.storage_cleanup_queue
    where bucket = 'public-assets'
      and object_path = 'catalog-assets/ref-M-published-v1.pdf'
      and status = 'pending'
    limit 1;

  if v_cleanup_id is null then
    raise exception
      'M.4: cleanup row for published v1 not found'
      using errcode = 'P0001';
  end if;

  v_claim_result := public.claim_storage_cleanup(10, 300);
  select (value->>'lock_token')::uuid into v_lock_token
    from jsonb_array_elements(v_claim_result)
    where value->>'id' = v_cleanup_id::text
    limit 1;

  if v_lock_token is null then
    select lock_token into v_lock_token
      from public.storage_cleanup_queue
      where id = v_cleanup_id;
  end if;

  v_complete_result := public.complete_storage_cleanup(
    p_cleanup_id := v_cleanup_id,
    p_lock_token := v_lock_token,
    p_success := true,
    p_final_status := 'deleted'
  );

  if v_complete_result <> 'completed' then
    raise exception
      'M.4: cleanup completion should return completed, got %',
      v_complete_result
      using errcode = 'P0001';
  end if;

  -- Published ref must now be 'deleted'.
  select count(*)
    into v_published_deleted
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'published'
      and status = 'deleted';

  if v_published_deleted <> 1 then
    raise exception
      'M.4: expected 1 deleted published ref after cleanup, got %',
      v_published_deleted
      using errcode = 'P0001';
  end if;

  -- 5. Republish (Publish #2). The source is still present, so the
  --    public derivative can be re-derived. finalize only needs the
  --    row to be in 'draft' state (set by unpublish) -> we re-arm
  --    publish_status = 'publishing'.
  update public.product_assets set
    publish_status = 'publishing',
    publish_token = v_publish_token_2,
    publish_started_at = now()
  where id = v_asset_id;

  v_result := public.finalize_catalog_asset_publish(
    p_asset_id := v_asset_id,
    p_publish_token := v_publish_token_2,
    p_public_bucket := 'public-assets',
    p_public_object_path := 'catalog-assets/ref-M-published-v2.pdf',
    p_public_url := 'https://example.supabase.co/storage/v1/object/public/public-assets/catalog-assets/ref-M-published-v2.pdf',
    p_mime_type := 'application/pdf',
    p_size_bytes := 1024,
    p_sha256 := 'aae0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  if (v_result->>'status') <> 'published' then
    raise exception 'M.5: republish should return published, got %',
      v_result->>'status'
      using errcode = 'P0001';
  end if;

  -- Source ref must STILL be active (Source retention across the
  -- entire publish -> unpublish -> republish cycle).
  select count(*)
    into v_source_active
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'active'
      and bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-M-source.pdf';

  if v_source_active <> 1 then
    raise exception
      'M.5: source ref must STILL be active after Republish, got %',
      v_source_active
      using errcode = 'P0001';
  end if;

  -- A new published ref must be active for v2 path.
  select count(*)
    into v_published_active
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'published'
      and status = 'active'
      and bucket = 'public-assets'
      and object_path = 'catalog-assets/ref-M-published-v2.pdf';

  if v_published_active <> 1 then
    raise exception
      'M.5: expected 1 active published ref for v2 after republish, got %',
      v_published_active
      using errcode = 'P0001';
  end if;

  -- source_bucket / source_object_path still intact.
  select source_bucket, source_object_path
    into v_source_bucket, v_source_path
    from public.product_assets
    where id = v_asset_id;

  if v_source_bucket <> 'private-assets' or v_source_path <> 'catalog-assets/ref-M-source.pdf' then
    raise exception
      'M.5: source columns not retained across republish, bucket=% path=%',
      v_source_bucket, v_source_path
      using errcode = 'P0001';
  end if;

  -- No cleanup row for source at any point.
  select count(*)
    into v_cleanup_count
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-M-source.pdf'
      and status in ('pending', 'claimed', 'retry');

  if v_cleanup_count <> 0 then
    raise exception
      'M.5: source cleanup must never have been enqueued (Source retention), got %',
      v_cleanup_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- N. Managed Storage Registry coverage for non-asset business writes.
-- ============================================================
-- Migration 20260725280000 wires register_managed_storage_ref_from_url
-- into save_product_with_images_and_audit, save_project_with_relations
-- _and_audit, save_company_profile_with_audit, and
-- save_site_settings_with_audit. It also fixes the projects.video_url
-- bug in save_project_with_relations and delete_project_with_audit.
--
-- This block verifies:
--   N.1  save_product_with_images_and_audit registers active refs
--        for product_cover / product_video / product_image.
--   N.2  save_project_with_relations_and_audit registers active refs
--        for project_cover / project_image AND does NOT raise
--        `column projects.video_url does not exist`.
--   N.3  save_company_profile_with_audit registers active refs
--        for company_logo / company_wechat_qr.
--   N.4  save_site_settings_with_audit registers an active ref
--        for site_og_image.
--   N.5  delete_project_with_audit marks project_cover / project_image
--        refs as pending_delete AND does not raise on the dead
--        projects.video_url column.
--   N.6  External URLs (non-managed) do NOT create refs.
--   N.7  check_storage_object_referenced returns true for a URL
--        held by project_images.image_url (regression for the
--        pre-20260725280000 coverage gap).
-- ============================================================

-- ============================================================
-- N.1  Product write registers product_cover / product_video / product_image refs.
-- ============================================================
do $$
declare
  v_product_id uuid;
  v_cover_count integer;
  v_video_count integer;
  v_image_count integer;
begin
  perform public.save_product_with_images_and_audit(
    p_id := null,
    p_product := jsonb_build_object(
      'category_id', '00000000-0000-4000-8000-000000000300',
      'name_cn', '[REGISTRY N.1] product',
      'slug', 'registry-n1-product',
      'cover_image_url', 'https://example.supabase.co/storage/v1/object/public/public-assets/products/n1-cover.jpg',
      'video_url', 'https://example.supabase.co/storage/v1/object/public/public-assets/products/n1-video.mp4',
      'is_published', false
    ),
    p_images := jsonb_build_array(
      jsonb_build_object('image_url', 'https://example.supabase.co/storage/v1/object/public/public-assets/products/n1-img1.jpg', 'sort_order', 0)
    ),
    p_expected_updated_at := null,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id into v_product_id from public.products where slug = 'registry-n1-product';

  select count(*) into v_cover_count
    from public.storage_object_refs
    where owner_type = 'product_cover' and owner_id = v_product_id
      and role = 'cover' and status = 'active';
  if v_cover_count <> 1 then
    raise exception 'N.1: expected 1 active product_cover ref, got %', v_cover_count
      using errcode = 'P0001';
  end if;

  select count(*) into v_video_count
    from public.storage_object_refs
    where owner_type = 'product_video' and owner_id = v_product_id
      and role = 'video' and status = 'active';
  if v_video_count <> 1 then
    raise exception 'N.1: expected 1 active product_video ref, got %', v_video_count
      using errcode = 'P0001';
  end if;

  select count(*) into v_image_count
    from public.storage_object_refs
    where owner_type = 'product_image' and owner_id = v_product_id
      and role = 'image' and status = 'active';
  if v_image_count <> 1 then
    raise exception 'N.1: expected 1 active product_image ref, got %', v_image_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- N.2  Project write registers project_cover / project_image refs
--      AND does not raise on the dead video_url column.
-- ============================================================
do $$
declare
  v_project_id uuid;
  v_cover_count integer;
  v_image_count integer;
begin
  -- This call MUST NOT raise `column projects.video_url does not exist`.
  perform public.save_project_with_relations_and_audit(
    p_id := null,
    p_project := jsonb_build_object(
      'title_cn', '[REGISTRY N.2] project',
      'slug', 'registry-n2-project',
      'cover_image_url', 'https://example.supabase.co/storage/v1/object/public/public-assets/projects/n2-cover.jpg',
      'is_published', false
    ),
    p_images := jsonb_build_array(
      jsonb_build_object('image_url', 'https://example.supabase.co/storage/v1/object/public/public-assets/projects/n2-img1.jpg', 'sort_order', 0)
    ),
    p_products := '[]'::jsonb,
    p_expected_updated_at := null,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id into v_project_id from public.projects where slug = 'registry-n2-project';

  select count(*) into v_cover_count
    from public.storage_object_refs
    where owner_type = 'project_cover' and owner_id = v_project_id
      and role = 'cover' and status = 'active';
  if v_cover_count <> 1 then
    raise exception 'N.2: expected 1 active project_cover ref, got %', v_cover_count
      using errcode = 'P0001';
  end if;

  select count(*) into v_image_count
    from public.storage_object_refs
    where owner_type = 'project_image' and owner_id = v_project_id
      and role = 'image' and status = 'active';
  if v_image_count <> 1 then
    raise exception 'N.2: expected 1 active project_image ref, got %', v_image_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- N.3  Company profile write registers company_logo / company_wechat_qr refs.
-- ============================================================
do $$
declare
  v_company_id uuid;
  v_logo_count integer;
  v_qr_count integer;
begin
  perform public.save_company_profile_with_audit(
    p_id := null,
    p_payload := jsonb_build_object(
      'title_cn', '[REGISTRY N.3] company',
      'logo_url', 'https://example.supabase.co/storage/v1/object/public/public-assets/company/n3-logo.png',
      'wechat_qr_url', 'https://example.supabase.co/storage/v1/object/public/public-assets/company/n3-qr.png'
    ),
    p_expected_updated_at := null,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id into v_company_id from public.company_profile where title_cn = '[REGISTRY N.3] company';

  select count(*) into v_logo_count
    from public.storage_object_refs
    where owner_type = 'company_logo' and owner_id = v_company_id
      and role = 'logo' and status = 'active';
  if v_logo_count <> 1 then
    raise exception 'N.3: expected 1 active company_logo ref, got %', v_logo_count
      using errcode = 'P0001';
  end if;

  select count(*) into v_qr_count
    from public.storage_object_refs
    where owner_type = 'company_wechat_qr' and owner_id = v_company_id
      and role = 'wechat_qr' and status = 'active';
  if v_qr_count <> 1 then
    raise exception 'N.3: expected 1 active company_wechat_qr ref, got %', v_qr_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- N.4  Site settings write registers site_og_image ref.
-- ============================================================
do $$
declare
  v_settings_id uuid;
  v_og_count integer;
begin
  perform public.save_site_settings_with_audit(
    p_id := null,
    p_payload := jsonb_build_object(
      'site_name', '[REGISTRY N.4] site',
      'default_language', 'zh',
      'default_og_image_url', 'https://example.supabase.co/storage/v1/object/public/public-assets/site/n4-og.png'
    ),
    p_expected_updated_at := null,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id into v_settings_id from public.site_settings where site_name = '[REGISTRY N.4] site';

  select count(*) into v_og_count
    from public.storage_object_refs
    where owner_type = 'site_og_image' and owner_id = v_settings_id
      and role = 'og_image' and status = 'active';
  if v_og_count <> 1 then
    raise exception 'N.4: expected 1 active site_og_image ref, got %', v_og_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- N.5  delete_project_with_audit marks project refs as pending_delete
--      AND does not raise on the dead video_url column.
-- ============================================================
do $$
declare
  v_project_id uuid;
  v_updated_at timestamptz;
  v_pending_cover integer;
  v_pending_image integer;
begin
  select id, updated_at into v_project_id, v_updated_at
    from public.projects where slug = 'registry-n2-project';

  -- This call MUST NOT raise `column projects.video_url does not exist`.
  perform public.delete_project_with_audit(
    p_id := v_project_id,
    p_expected_updated_at := v_updated_at,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select count(*) into v_pending_cover
    from public.storage_object_refs
    where owner_type = 'project_cover' and owner_id = v_project_id
      and role = 'cover' and status = 'pending_delete';
  if v_pending_cover <> 1 then
    raise exception 'N.5: expected 1 pending_delete project_cover ref, got %', v_pending_cover
      using errcode = 'P0001';
  end if;

  select count(*) into v_pending_image
    from public.storage_object_refs
    where owner_type = 'project_image' and owner_id = v_project_id
      and role = 'image' and status = 'pending_delete';
  if v_pending_image <> 1 then
    raise exception 'N.5: expected 1 pending_delete project_image ref, got %', v_pending_image
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- N.6  External URLs do NOT create refs.
-- ============================================================
do $$
declare
  v_product_id uuid;
  v_cover_count integer;
begin
  perform public.save_product_with_images_and_audit(
    p_id := null,
    p_product := jsonb_build_object(
      'category_id', '00000000-0000-4000-8000-000000000300',
      'name_cn', '[REGISTRY N.6] external product',
      'slug', 'registry-n6-external',
      'cover_image_url', 'https://cdn.example.com/external-cover.jpg',
      'is_published', false
    ),
    p_images := '[]'::jsonb,
    p_expected_updated_at := null,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  select id into v_product_id from public.products where slug = 'registry-n6-external';

  -- External URL must NOT have created a ref.
  select count(*) into v_cover_count
    from public.storage_object_refs
    where owner_type = 'product_cover' and owner_id = v_product_id
      and role = 'cover';
  if v_cover_count <> 0 then
    raise exception 'N.6: external URL must not create a ref, got %', v_cover_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- N.7  check_storage_object_referenced returns true for a URL held
--      by project_images.image_url (regression for the
--      pre-20260725280000 coverage gap).
-- ============================================================
do $$
declare
  v_referenced boolean;
begin
  -- Insert a project + image directly, then ask the reference
  -- checker about the image path. Before 20260725280000 this
  -- returned false (the column was not scanned), which would have
  -- allowed the cleanup dispatcher to delete the image while it
  -- was still referenced.
  perform public.save_project_with_relations_and_audit(
    p_id := null,
    p_project := jsonb_build_object(
      'title_cn', '[REGISTRY N.7] reference check',
      'slug', 'registry-n7-refcheck',
      'is_published', false
    ),
    p_images := jsonb_build_array(
      jsonb_build_object(
        'image_url', 'https://example.supabase.co/storage/v1/object/public/public-assets/projects/n7-img.jpg',
        'sort_order', 0
      )
    ),
    p_products := '[]'::jsonb,
    p_expected_updated_at := null,
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  v_referenced := public.check_storage_object_referenced(
    'public-assets', 'projects/n7-img.jpg'
  );
  if v_referenced is not true then
    raise exception
      'N.7: check_storage_object_referenced returned false for a path '
      'held by project_images.image_url (cleanup dispatcher would delete it)'
      using errcode = 'P0001';
  end if;
end $$;

rollback;

-- ============================================================
-- End of storage_object_ref_lifecycle.sql
-- ============================================================
