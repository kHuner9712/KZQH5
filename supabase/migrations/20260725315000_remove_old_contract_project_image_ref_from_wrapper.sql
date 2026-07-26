-- ============================================================
-- Migration 20260725315000
-- Remove old-contract project_image ref from save_project_with_relations_and_audit
-- ============================================================
-- Round-4 follow-up. Migration 20260725311000 rewrote the INNER
-- function `save_project_with_relations` to register per-image
-- `project_image` refs with `owner_id = project_images.id` (the
-- new per-object contract) and a `project_cover` ref with
-- `owner_id = project.id`.
--
-- However, 20260725311000 did NOT rewrite the OUTER wrapper
-- `save_project_with_relations_and_audit`. The version frozen by
-- 20260725280000 still runs its OWN ref registration AFTER
-- delegating to the inner function:
--
--   1. project_cover ref (owner_id = project.id, role = 'cover')
--      — REDUNDANT: the inner function already registers this.
--   2. project_image ref (owner_id = project.id, role = 'image')
--      — OLD CONTRACT: this creates a second ref keyed by the
--        parent project id, not the per-image id. The per-image
--        refs (correct) are also created by the inner function.
--
-- The result is that each project save creates N+1 image refs:
-- N per-image refs (correct, owner_id = project_images.id) plus
-- 1 old-contract ref (wrong, owner_id = project.id). The
-- old-contract ref is never transitioned to `pending_delete` by
-- `delete_project_with_audit` (which was rewritten by
-- 20260725314000 to mark per-image refs by image id), so it
-- leaks as `active` forever — a Registry leak.
--
-- This migration rewrites `save_project_with_relations_and_audit`
-- to ONLY:
--   1. Delegate to `save_project_with_relations` (which handles
--      all ref registration: per-image + cover).
--   2. Insert the audit log.
--   3. Return the project id.
--
-- No ref registration in the wrapper. The inner function is the
-- single source of truth for Registry writes.
--
-- Forward-only. No existing migration is modified.
-- ============================================================


-- ============================================================
-- A. save_project_with_relations_and_audit (REWRITTEN)
-- ============================================================
-- Signature unchanged:
--   (uuid, jsonb, jsonb, jsonb, timestamptz, uuid, text, text) -> uuid
--
-- Behavioral change: the wrapper no longer registers any
-- `project_image` or `project_cover` refs. The inner function
-- `save_project_with_relations` (rewritten by 20260725311000)
-- already registers:
--   * one `project_cover` ref (owner_id = project.id, role = 'cover')
--   * one `project_image` ref per image (owner_id = project_images.id,
--     role = 'image')
-- The wrapper's old ref registration was creating an additional
-- old-contract `project_image` ref with owner_id = project.id,
-- which leaked because `delete_project_with_audit` (rewritten by
-- 20260725314000) only marks per-image refs as pending_delete.
-- ============================================================
create or replace function public.save_project_with_relations_and_audit(
  p_id uuid,
  p_project jsonb,
  p_images jsonb default '[]'::jsonb,
  p_products jsonb default '[]'::jsonb,
  p_expected_updated_at timestamptz default null,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_action text;
  v_title text;
begin
  -- Delegate the business write + image reconciliation + ref
  -- registration + cleanup enqueue to the round-4 inner function.
  -- Any error raised inside propagates and aborts this transaction.
  v_id := public.save_project_with_relations(
    p_id := p_id,
    p_project := p_project,
    p_images := p_images,
    p_products := p_products,
    p_expected_updated_at := p_expected_updated_at
  );

  if v_id is null then
    raise exception 'save_project_with_relations returned null'
      using errcode = 'P0001';
  end if;

  -- Determine action and fetch display title for the audit summary.
  if p_id is null then
    v_action := 'project.create';
  else
    v_action := 'project.update';
  end if;

  select title_cn into v_title from public.projects where id = v_id;

  -- Atomic audit insert — same transaction as the business write.
  -- Failure here rolls back the project save (no best-effort audit).
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    v_action,
    'project',
    v_id::text,
    coalesce(v_title, '')
  );

  -- NOTE: No ref registration here. The inner function
  -- save_project_with_relations (20260725311000) already registers:
  --   * project_cover ref (owner_id = project.id, role = 'cover')
  --   * one project_image ref per image (owner_id = project_images.id,
  --     role = 'image')
  -- The old wrapper (20260725280000) registered an additional
  -- project_image ref with owner_id = project.id (old contract),
  -- which leaked because delete_project_with_audit only marks
  -- per-image refs. Removed here.

  return v_id;
end;
$$;

revoke all on function public.save_project_with_relations_and_audit(
  uuid, jsonb, jsonb, jsonb, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_project_with_relations_and_audit(
  uuid, jsonb, jsonb, jsonb, timestamptz, uuid, text, text
) to service_role;
