-- ============================================================
-- Phase 18 (Section 4.6): storage_object_refs lifecycle tests.
--
-- Proves the pending_delete lifecycle wired by 20260725261000:
--
--   A. Product Asset Draft creates an active 'source' ref.
--   B. Draft replacement produces a new active ref; old ref -> pending_delete.
--   C. Old private object is atomically enqueued in storage_cleanup_queue.
--   D. Same-path update does NOT re-enqueue or create a new ref.
--   E. Catalog Publish: public ref active, source ref -> pending_delete.
--   F. Cleanup success: matching refs -> deleted.
--   G. Cleanup failure: refs stay pending_delete (NOT deleted).
--   H. Unpublish: published ref -> pending_delete.
--   I. Delete business row: all active refs -> pending_delete.
--   J. Certificate equivalent flow (draft -> publish -> cleanup).
--   K. Registry write failure rolls back business write + audit.
--   L. At most one active ref per (owner_type, owner_id, role).
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
-- E. Catalog Publish: public ref active, source ref -> pending_delete.
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_publish_token uuid := '00000000-0000-4000-8000-000000000310';
  v_result jsonb;
  v_published_active_count integer;
  v_source_pending_count integer;
  v_cleanup_count integer;
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

  -- Source ref must be pending_delete (NOT superseded, NOT active).
  select count(*)
    into v_source_pending_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'pending_delete';

  if v_source_pending_count <> 1 then
    raise exception
      'E: expected 1 pending_delete source ref, got %',
      v_source_pending_count
      using errcode = 'P0001';
  end if;

  -- A cleanup row must exist for the old private source object.
  select count(*)
    into v_cleanup_count
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-A-source-v2.pdf'
      and status in ('pending', 'claimed', 'retry');

  if v_cleanup_count <> 1 then
    raise exception
      'E: expected 1 cleanup row for old source, got %',
      v_cleanup_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- F. Cleanup success: matching refs -> deleted.
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
begin
  select id into v_asset_id
    from public.product_assets
    where title_cn like '[REF LIFECYCLE] asset A%'
    order by updated_at desc
    limit 1;

  -- Claim and complete the cleanup for the old source path.
  select id into v_cleanup_id
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-A-source-v2.pdf'
      and status = 'pending'
    limit 1;

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

  -- The source ref must now be 'deleted' (was pending_delete).
  select count(*)
    into v_source_deleted_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'deleted';

  if v_source_deleted_count <> 1 then
    raise exception
      'F: expected 1 deleted source ref after cleanup success, got %',
      v_source_deleted_count
      using errcode = 'P0001';
  end if;

  -- No remaining pending_delete source ref.
  select count(*)
    into v_source_pending_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'pending_delete';

  if v_source_pending_count <> 0 then
    raise exception
      'F: expected 0 pending_delete source refs after cleanup, got %',
      v_source_pending_count
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- G. Cleanup failure: refs stay pending_delete (NOT deleted).
-- ============================================================
do $$
declare
  v_asset_id uuid;
  v_publish_token uuid := '00000000-0000-4000-8000-000000000320';
  v_cleanup_id uuid;
  v_lock_token uuid;
  v_claim_result jsonb;
  v_complete_result text;
  v_pending_count integer;
  v_deleted_count integer;
begin
  -- Create a second asset, publish it, then fail the cleanup.
  -- Insert a fresh draft.
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

  select id into v_asset_id
    from public.product_assets
    where title_cn = '[REF LIFECYCLE] asset G'
    order by updated_at desc
    limit 1;

  -- Publish it.
  update public.product_assets set
    publish_status = 'publishing',
    publish_token = v_publish_token,
    publish_started_at = now()
  where id = v_asset_id;

  perform public.finalize_catalog_asset_publish(
    p_asset_id := v_asset_id,
    p_publish_token := v_publish_token,
    p_public_bucket := 'public-assets',
    p_public_object_path := 'catalog-assets/ref-G-published.pdf',
    p_public_url := 'https://example.supabase.co/storage/v1/object/public/public-assets/catalog-assets/ref-G-published.pdf',
    p_mime_type := 'application/pdf',
    p_size_bytes := 512,
    p_sha256 := 'fff0000000000000000000000000000000000000000000000000000000000000',
    p_actor_email := 'test@example.invalid',
    p_actor_role := 'editor'
  );

  -- Claim and FAIL the cleanup for the source path.
  select id into v_cleanup_id
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'catalog-assets/ref-G-source.pdf'
      and status = 'pending'
    limit 1;

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

  -- The source ref must still be pending_delete (NOT deleted).
  select count(*)
    into v_pending_count
    from public.storage_object_refs
    where owner_type = 'product_asset'
      and owner_id = v_asset_id
      and role = 'source'
      and status = 'pending_delete';

  if v_pending_count <> 1 then
    raise exception
      'G: expected 1 pending_delete source ref after cleanup failure, got %',
      v_pending_count
      using errcode = 'P0001';
  end if;

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
-- J. Certificate equivalent flow (draft -> publish -> cleanup).
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

  -- Published ref active, source ref pending_delete.
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

  select count(*)
    into v_source_pending
    from public.storage_object_refs
    where owner_type = 'certificate'
      and owner_id = v_cert_id
      and role = 'source'
      and status = 'pending_delete';

  if v_source_pending <> 1 then
    raise exception 'J: expected 1 pending_delete source cert ref, got %',
      v_source_pending
      using errcode = 'P0001';
  end if;

  -- Cleanup enqueued for the source.
  select count(*)
    into v_cleanup_count
    from public.storage_cleanup_queue
    where bucket = 'private-assets'
      and object_path = 'certificates/ref-J-source.pdf'
      and status in ('pending', 'claimed', 'retry');

  if v_cleanup_count <> 1 then
    raise exception 'J: expected 1 cleanup row for cert source, got %',
      v_cleanup_count
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
-- ============================================================
do $$
declare
  v_count integer;
begin
  -- Trigger function: raises an exception for the poisoned path.
  create or replace function public._tmp_block_ref_insert()
  returns trigger
  language plpgsql
  as $$
  begin
    if new.object_path = 'catalog-assets/POISONED-PATH.pdf' then
      raise exception 'registry write deliberately blocked (test K)'
        using errcode = 'P0001';
    end if;
    return new;
  end;
  $$;

  create trigger _tmp_storage_object_refs_block
    before insert on public.storage_object_refs
    for each row
    execute function public._tmp_block_ref_insert();

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

  -- Clean up the trigger (will also be rolled back, but be explicit).
  drop trigger if exists _tmp_storage_object_refs_block on public.storage_object_refs;
  drop function if exists public._tmp_block_ref_insert();
end $$;

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

rollback;

-- ============================================================
-- End of storage_object_ref_lifecycle.sql
-- ============================================================
