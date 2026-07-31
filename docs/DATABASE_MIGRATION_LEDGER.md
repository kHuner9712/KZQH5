# KZQ Database Migration Ledger

This is the **single source of truth** for every Supabase migration in the
KZQH5 repository. Other documents (README, DEPLOYMENT, runbooks) link here
instead of maintaining their own conflicting lists.

**Rules:**
- Never modify a historical migration file. New changes = new timestamped file.
- Update this ledger every time a migration is added or its execution status changes.
- "Status" values: `pending` (file exists, not applied anywhere), `applied` (confirmed on the named environment), `unknown` (not yet verified).
- Never mark a migration as `applied` without verification evidence.

| # | File | Purpose | Local | Staging | Production | Executed | Operator | Evidence | Rollback boundary |
|---|------|---------|-------|---------|------------|----------|----------|----------|-------------------|
| 1 | `20260713181111_upgrade_inquiries.sql` | Add phone/wechat/language/channel/UTM/notes/assignee columns to inquiries; add updated_at trigger; add indexes. | unknown | unknown | unknown | — | — | — | Drop added columns (data loss for new fields). Safe to keep. |
| 2 | `20260714032351_b2b_product_search_and_inquiry_items.sql` | Add pg_trgm search; search_document column + trigger; search_published_products RPC; inquiry_items table; create_inquiry_with_items RPC (original 2-arg). | unknown | unknown | unknown | — | — | — | Drop inquiry_items table, search_document column, triggers, RPCs. Old inquiries remain valid. |
| 3 | `20260714084116_procurement_assets_and_projects.sql` | Add product_assets table, projects table, project_images, project_products. | unknown | unknown | unknown | — | — | — | Drop the 4 new tables. Products/categories unaffected. |
| 4 | `20260714125149_production_stability_analytics_wechat.sql` | Add analytics_events table + initial 14-event constraint; company_profile.wechat column. | unknown | unknown | unknown | — | — | — | Drop analytics_events table, wechat column. |
| 5 | `20260714201851_enforce_inquiry_product_integrity.sql` | Add FK from inquiries.product_id to products (on delete set null). | unknown | unknown | unknown | — | — | — | Drop FK constraint. Inquiries keep product_id as plain text. |
| 6 | `20260715090000_security_hardening_explicit_grants.sql` | Revoke public grants on sensitive tables; grant only service_role / authenticated as appropriate. | unknown | unknown | unknown | — | — | — | Re-grant public (NOT recommended — security regression). |
| 7 | `20260718182435_count_unread_inquiries_rpc.sql` | Add count_unread_inquiries() RPC for admin dashboard. | unknown | unknown | unknown | — | — | — | Drop function. Dashboard unread count breaks. |
| 8 | `20260719090000_catalog_center_fields.sql` | Add catalog_topic_id, cover_image_url, published_at, content_hash to product_assets; 2 indexes. | unknown | unknown | unknown | — | — | — | Drop columns + indexes. Catalog feature breaks. |
| 9 | `20260721000000_catalog_viewer_analytics_events.sql` | Replace analytics_events check constraint with 19-event taxonomy. | unknown | unknown | unknown | — | — | — | Restore old 14-event constraint (loses catalog viewer events). |
| 10 | `20260724120000_admin_dashboard_snapshot_rpc.sql` | **Phase 1.** Add get_admin_dashboard_snapshot() RPC replacing count:exact queries. | pending | pending | pending | — | — | — | Drop function. Dashboard reverts to count:exact (slower, RLS-dependent). |
| 11 | `20260724130000_admin_transactional_write_rpcs.sql` | **Phase 2.** Add save_product_with_images() and save_project_with_relations() transactional RPCs. | pending | pending | pending | — | — | — | Drop functions. Admin CMS reverts to client-side inserts (non-atomic). |
| 12 | `20260724150000_inquiry_idempotency_and_outbox.sql` | **Phase 5.** Add client_submission_id column; inquiry_outbox table; idempotent create_inquiry_with_items(3-arg); outbox claim/mark/fail RPCs. | pending | pending | pending | — | — | — | Drop outbox table + column. Idempotency and reliable notifications lost. Old 2-arg RPC signature is dropped by this migration — rollback requires restoring the old function. |
| 13 | `20260724160000_schema_verification_rpc.sql` | **Phase 7.** Add verify_schema_readiness() read-only RPC for release checks. | pending | pending | pending | — | — | — | Drop function. Release readiness script falls back to direct REST probing (less reliable). |
| 14 | `20260724170000_storage_bucket_hardening.sql` | **Phase 4.** Set allowed_mime_types (PDF/JPEG/PNG/WebP, no SVG) and file_size_limit (50MB) on public-assets and private-assets storage buckets. | pending | pending | pending | — | — | — | Re-configure buckets via dashboard (allows SVG and removes size limit). Safe to keep. |
| 15 | `20260724180000_admin_rbac_audit_optimistic_lock.sql` | **Phase 3.** Add updated_at + trigger + role CHECK constraint to admin_profiles; create admin_audit_log table (RLS, service_role only); replace save_product_with_images / save_project_with_relations with versions accepting p_expected_updated_at for optimistic locking (backward compatible — null default skips the check). | pending | pending | pending | — | — | — | Drop the audit_log table and the updated_at column. Restore the old 3-arg / 4-arg function signatures (loses optimistic locking). Role CHECK constraint can be dropped separately. |
| 16 | `20260724190000_catalog_authorization_metadata.sql` | **Phase 12.** Add access_level, source_type, authorization_status columns to product_assets with CHECK constraints; replace product_assets_public_read RLS policy to enforce access_level (anon sees only 'public', authenticated sees 'public'+'registered', 'restricted' status excluded from public reads); add index on access_level. | pending | pending | pending | — | — | — | Drop the 3 columns and restore the old RLS policy (anon can read all is_published assets). Backward compatible — defaults preserve existing access. |
| 17 | `20260724200000_catalog_authorization_tighten.sql` | **Phase 12 correction.** Tighten the Catalog authorization model: backfill registered/partner -> private; replace access_level CHECK to only allow public/private; replace RLS policy so anon read requires is_published=true AND access_level='public' AND authorization_status='confirmed' (pending is no longer publicly readable); authenticated role is NOT granted private access (no customer authorization system exists). Admin access via service_role only (app-layer RBAC). | pending | pending | pending | — | — | — | Drop this migration's policy/constraint and restore the 20260724190000 policy. Safe — only tightens access, never loosens. |
| 18 | `20260724210000_inquiry_rpc_restore_db_owned_snapshot.sql` | **Phase 5 correction.** Restore the server-owned product snapshot in `create_inquiry_with_items` that was regressed by migration 20260724150000. The 20260724150000 function used CLIENT-supplied `product_name_cn`/`product_name_en`/`product_slug` in `inquiry_items` instead of DB-owned values, skipped product existence/publication validation, and had no max-items (30) cap or duplicate product_id check. This migration replaces the function body to restore all of those guards while preserving the 3-arg signature `(jsonb, jsonb, uuid)`, idempotency via `p_client_submission_id`, the outbox event write, and the jsonb return shape `{ inquiry, idempotent, outbox_id }`. | pending | pending | pending | — | — | — | Re-apply the 20260724150000 function body (loses DB-owned snapshot, validation, and caps). NOT safe to roll back in production — would allow clients to forge product names in inquiry items. |
| 19 | `20260725090000_transactional_audit_outbox_storage_hardening.sql` | Transactional audit + outbox + storage hardening. | pending | pending | pending | — | — | — | Drop added functions/tables. |
| 20 | `20260725100000_fix_storage_rls_outbox_rpc.sql` | Fix storage RLS + outbox RPC issues. | pending | pending | pending | — | — | — | Restore prior RLS policies. |
| 21 | `20260725110000_per_provider_delivery_storage_lifecycle.sql` | Per-provider delivery + storage lifecycle. | pending | pending | pending | — | — | — | Drop added functions. |
| 22 | `20260725120000_grant_admin_audit_log_to_service_role.sql` | Grant admin_audit_log to service_role. | pending | pending | pending | — | — | — | Revoke grant. |
| 23 | `20260725130000_make_outbox_next_retry_at_nullable.sql` | Make outbox next_retry_at nullable. | pending | pending | pending | — | — | — | Restore NOT NULL constraint. |
| 24 | `20260725140000_fix_find_uninitialized_outbox_events.sql` | Fix find_uninitialized_outbox_events RPC. | pending | pending | pending | — | — | — | Restore prior function body. |
| 25 | `20260725150000_fix_check_storage_object_referenced_projects_video_url.sql` | Fix check_storage_object_referenced + projects.video_url. | pending | pending | pending | — | — | — | Restore prior behavior. |
| 26 | `20260725160000_transactional_storage_cleanup_enqueue.sql` | Transactional storage cleanup enqueue. | pending | pending | pending | — | — | — | Drop enqueue function. |
| 27 | `20260725170000_storage_object_refs_and_publish_protocol.sql` | storage_object_refs table + publish protocol RPCs. | pending | pending | pending | — | — | — | Drop table + RPCs. |
| 28 | `20260725180000_storage_audit_reconcile_claim.sql` | Storage audit reconcile claim RPC. | pending | pending | pending | — | — | — | Drop function. |
| 29 | `20260725190000_catalog_certificate_publish_close_loop.sql` | Catalog + certificate publish close-loop RPCs. | pending | pending | pending | — | — | — | Drop RPCs. |
| 30 | `20260725200000_claim_require_optimistic_lock.sql` | claim_catalog_asset_publish requires optimistic lock. | pending | pending | pending | — | — | — | Restore non-locking claim. |
| 31 | `20260725210000_storage_cleanup_audit_saga.sql` | Storage cleanup audit saga (complete_storage_operation, record_storage_operation_started, complete_storage_cleanup). | pending | pending | pending | — | — | — | Drop saga RPCs. |
| 32 | `20260725220000_project_audit_rpc.sql` | Project audit RPC. | pending | pending | pending | — | — | — | Drop function. |
| 33 | `20260725230000_cms_content_audit_rpcs.sql` | CMS content audit RPCs. | pending | pending | pending | — | — | — | Drop functions. |
| 34 | `20260725240000_fix_cleanup_rpc_signature_and_schema_contract.sql` | **PR #12 fix.** Canonicalize `complete_storage_cleanup` to a single 6-arg signature (drop 4-arg + 6-arg overloads that caused `is not unique` errors). Stabilize `verify_required_schema` to `returns table(missing text)` with real existence/grant checks. Add `list_required_schema_objects()` for the static expected-objects list. Assert only one `complete_storage_cleanup` overload exists. | pending | pending | pending | — | — | — | Re-create dropped overloads (would reintroduce ambiguity). NOT safe — the 4-arg call path is preserved via default parameters. |
| 35 | `20260725240010_aggregate_audit_updated_fields.sql` | **PR #12 fix.** Replace scalar subquery `select jsonb_object_keys(v_payload)` (which raised `more than one row returned by a subquery used as an expression`) with `jsonb_agg(key order by key)` producing a stable sorted JSON array in audit metadata `updated_fields`. | pending | pending | pending | — | — | — | Restore scalar subquery (would reintroduce multi-row error). |
| 36 | `20260725250000_wire_storage_object_refs_into_asset_lifecycle.sql` | **PR #12 fix.** Wire `storage_object_refs` registry into the asset lifecycle: draft create, draft replace, publish finalize (catalog + certificate), cleanup completion. Registers an active ref for each new private/public object, marks replaced refs as superseded, and transitions refs to deleted only after cleanup completion. NOTE: this version had two defects fixed by 20260725261000 — it wrote `deleted` before the Storage object was physically removed, and it did not compare old vs new paths on draft replacement. | pending | pending | pending | — | — | — | Drop the helper RPCs and restore prior RPC bodies (would leave storage_object_refs unused). |
| 37 | `20260725260000_fix_schema_verifier_runtime.sql` | **PR #12 fix.** Make the schema verifier runtime-correct: remove two phantom columns (`product_assets.storage_operation_id`, `product_assets.final_status`) from the expected-objects catalog (they only exist on `storage_cleanup_queue`); replace fragile text-based function-signature comparison with `to_regprocedure` round-trip + overload-count guard; replace non-existent `acl.privilege_mask` with `has_function_privilege` and add separate PUBLIC/anon/authenticated grantee checks. Add `mark_storage_object_refs_pending_delete` to the catalog. | pending | pending | pending | — | — | — | Restore the 20260725240000 verifier body (would reintroduce phantom-column false positives, signature false negatives, and the ACL runtime crash). |
| 38 | `20260725261000_fix_storage_ref_deletion_lifecycle.sql` | **PR #12 fix.** Introduce a `pending_delete` ref lifecycle so refs are NOT marked `deleted` before the Storage object is physically removed. Widen `storage_object_refs.status` CHECK to include `pending_delete`. Add `mark_storage_object_refs_pending_delete` helper. Rewrite `save_product_asset_draft` / `save_certificate_draft` to compare old vs new paths (no redundant ref/cleanup on same-path update) and transition old refs to `pending_delete` + enqueue cleanup atomically. Rewrite publish finalize, unpublish, and delete RPCs to transition refs to `pending_delete` (not `deleted`) until cleanup succeeds. Rewrite `complete_storage_cleanup` to transition matching `active`/`superseded`/`pending_delete` refs to `deleted` only on `p_final_status='deleted'`. | pending | pending | pending | — | — | — | Restore the 20260725250000 RPC bodies and status CHECK (would reintroduce premature `deleted` writes and redundant same-path ref creation). |
| 39 | `20260725262000_fix_schema_verifier_oid_contract.sql` | **PR #12 fix.** Rewrite the verifier to resolve function identity exclusively via `to_regprocedure('public.fn(sig)')` (OID contract), eliminating text-based signature comparison. Add `mark_storage_object_refs_pending_delete` to the curated catalog. Replace `has_function_privilege('PUBLIC', ...)` (which raises on PG16) with `aclexplode(proacl)` grantee=0 checks. | pending | pending | pending | — | — | — | Restore the 20260725260000 verifier body (would reintroduce text-signature false positives and the PG16 PUBLIC-role crash). |
| 40 | `20260725270000_unify_source_retention_policy.sql` | **PR #12 fix.** Unify Catalog and Certificate source retention: publish leaves the private source ref ACTIVE and preserves `source_bucket` / `source_object_path` on the row. Only Draft replacement transitions the old source ref to `pending_delete` and enqueues cleanup. Unpublish only transitions the public ref to `pending_delete`. Makes Unpublish → Republish retain the original asset. | pending | pending | pending | — | — | — | Restore per-flush source cleanup (would reintroduce Unpublish → Republish data loss). |
| 41 | `20260725280000_extend_managed_storage_registry_coverage.sql` | **PR #12 fix.** Add `register_managed_storage_ref_from_url` helper and wire it into `save_product_with_images_and_audit` (cover, video, first image), `save_project_with_relations_and_audit` (cover, first image), `save_company_profile_with_audit` (logo, wechat QR), and `save_site_settings_with_audit`. Remove the broken `projects.video_url` reference. Extend `check_storage_object_referenced` to scan `project_images`, `company_profile`, `site_settings`. | pending | pending | pending | — | — | — | Restore the narrow `check_storage_object_referenced` and drop the `register_managed_storage_ref_from_url` helper (would reintroduce the coverage gap). |
| 42 | `20260725290000_add_admin_audit_log_metadata_column.sql` | **PR #12 fix.** Add `metadata jsonb` column + GIN index to `admin_audit_log`. The audit RPCs introduced by `20260725230000` / `20260725240010` write to this column; without it every CMS write raised `column does not exist`. | pending | pending | pending | — | — | — | Drop the column (would reintroduce the audit-write crash). |
| 43 | `20260725300000_fix_product_save_rpc_keywords_cast.sql` | **PR #12 fix.** Rewrite the INSERT and UPDATE of `keywords_cn`, `keywords_en`, `search_aliases` in `save_product_with_images_and_audit` to use `jsonb_array_elements_text` instead of assigning raw jsonb to `text[]` columns. PG16 removed the implicit jsonb → text[] cast. | pending | pending | pending | — | — | — | Restore the raw jsonb assignment (would reintroduce the PG16 cast error on every product save). |
| 44 | `20260725310000_enforce_strict_managed_storage_identity.sql` | **Round-4 fix.** Replace the loose URL parser (`extract_managed_storage_path`) on all write/delete paths with `extract_managed_storage_path_strict` that validates scheme (https), host (exact match against `site_settings.managed_storage_host`), port (443 only), no userinfo, no fragment. Add `register_managed_storage_ref_structured` for bucket+path input. Rewrite `register_managed_storage_ref_from_url`, `enqueue_managed_storage_cleanup`, `check_storage_object_referenced` to use the strict parser. External URLs no longer enter the registry or cleanup queue. | pending | pending | pending | — | — | — | Restore the loose parser on write/delete paths (would reintroduce the external-host impersonation vulnerability). |
| 45 | `20260725311000_register_each_managed_image_object.sql` | **Round-4 fix.** Rewrite `save_product_with_images_and_audit` and `save_project_with_relations` to register a separate `storage_object_refs` row per image (owner_id = `product_images.id` / `project_images.id`, role = `image`). The previous model registered only one ref per parent row. Reconciliation is transactional: SELECT FOR UPDATE, match by image id, insert new, mark removed as `pending_delete`, enqueue cleanup per removed object. | pending | pending | pending | — | — | — | Restore the single-ref-per-parent model (would reintroduce the per-image registry gap). |
| 46 | `20260725312000_require_content_write_optimistic_lock.sql` | **Round-4 fix.** Add `verify_optimistic_lock_enforcement()` helper and runtime assertion. All 5 content-write RPCs (`save_product_with_images_and_audit`, `save_project_with_relations`, `save_company_profile_with_audit`, `save_site_settings_with_audit`, `save_homepage_content_with_audit`) MUST raise SQLSTATE 22004 when `p_id is not null` and `p_expected_updated_at is null`, and SQLSTATE 40P01 on stale timestamp. | pending | pending | pending | — | — | — | Drop the verifier (would allow future CREATE OR REPLACE to silently remove the strict lock check). |
| 47 | `20260725313000_update_schema_verifier_for_round4.sql` | **Round-4 fix.** Update the Schema Verifier required-objects catalog to include the new Round-4 RPCs: `extract_managed_storage_path_strict`, `get_managed_storage_host`, `register_managed_storage_ref_structured`, `verify_optimistic_lock_enforcement`. Verifier checks existence, exact signature, service_role EXECUTE, and PUBLIC/anon/authenticated no-EXECUTE. | pending | pending | pending | — | — | — | Restore the old catalog (would miss the new Round-4 RPCs in release readiness checks). |
| 48 | `20260725314000_fix_delete_project_per_image_refs.sql` | **Round-4 fix.** Rewrite `delete_project_with_audit` and `bulk_delete_products_with_audit` to mark per-image `storage_object_refs` rows as `pending_delete` using the correct `owner_id` (each `project_images.id` / `product_images.id`), not the parent project/product id. The previous version marked zero rows because no per-image ref had `owner_id = parent.id`. | pending | pending | pending | — | — | — | Restore the parent-id marking (would leave per-image refs as `active` forever after deletion). |
<<<<<<< HEAD
| 49 | `20260728000000_revoke_authenticated_business_dml.sql` | Revoke DML (insert/update/delete) from `authenticated` role on business tables. Only `service_role` may write; `authenticated` retains read access where appropriate. | pending | pending | pending | — | — | — | Re-grant DML to authenticated (security regression). |
| 50 | `20260728020000_outbox_orphaned_status_and_health.sql` | Add `orphaned` status to inquiry_outbox and outbox health-check RPC. | pending | pending | pending | — | — | — | Drop status + RPC. Outbox processing loses orphan detection. |
| 51 | `20260729020000_temp_uploads_two_phase_upload.sql` | **Phase 4.** Add `temp_uploads` table (RLS-enabled, no anon/authenticated policies) and 6 lifecycle RPCs (`authorize_temp_upload`, `claim_temp_upload_for_finalize`, `complete_temp_upload_finalize`, `fail_temp_upload_finalize`, `recover_stale_temp_uploads`, `reap_expired_temp_uploads`). All RPCs are SECURITY INVOKER, empty search_path, EXECUTE granted to service_role ONLY. Enables two-phase large file upload bypassing EdgeOne's 6 MB body limit. | pending | pending | pending | — | — | — | Drop table + RPCs. Two-phase upload feature breaks. |
| 52 | `20260731020000_bind_temp_upload_actor.sql` | **KZQ-P0-003.** Drop old `claim_temp_upload_for_finalize(uuid)` signature and replace with `claim_temp_upload_for_finalize(uuid, text)` that accepts `p_actor_id` and verifies it matches the row's `actor_id`. Rejects with `invalid_actor` (null p_actor_id), `actor_not_bound` (null row.actor_id), or `actor_mismatch` (different admin). Only the admin who authorized the upload can finalize it. SECURITY INVOKER, empty search_path, EXECUTE to service_role ONLY. | pending | pending | pending | — | — | — | Restore old 1-arg signature (would remove actor binding — security regression allowing any admin to finalize any upload). |
| 53 | `20260731120000_extend_schema_verification_rls_revoke.sql` | **KZQ-P0-011-c.** Drop and recreate `verify_schema_readiness()` to add 30 new checks: 15 `rls_enabled_<table>` checks (verify RLS still enabled on tables the migrations declare as RLS-enabled, via `pg_class.relrowsecurity`) and 15 `revoke_dml_<table>_authenticated` checks (verify `authenticated` still lacks INSERT on the 15 business tables revoked by migration 20260728000000, via `has_table_privilege`). All 15 original checks unchanged. Re-applies revoke from public/anon/authenticated and grant to service_role ONLY. | pending | pending | pending | — | — | — | Drop the function (reverts to the 15-check version from 20260724160000 — loses RLS and DML revoke verification in release readiness). |
| 53 | `20260731120000_extend_schema_verification_rls_revoke.sql` | **KZQ-P0-011-c.** Drop and recreate `verify_schema_readiness()` to add 30 new checks: 15 `rls_enabled_<table>` checks (verify RLS still enabled on tables the migrations declare as RLS-enabled, via `pg_class.relrowsecurity`) and 15 `revoke_dml_<table>_authenticated` checks (verify `authenticated` still lacks INSERT on the 15 business tables revoked by migration 20260728000000, via `has_table_privilege`). All 15 original checks unchanged. Re-applies revoke from public/anon/authenticated and grant to service_role ONLY. | pending | pending | pending | — | — | — | Drop the function (reverts to the 15-check version from 20260724160000 — loses RLS and DML revoke verification in release readiness). |
| 54 | `20260731130000_add_service_role_grant_verification.sql` | **KZQ-P0-011-d.** CREATE OR REPLACE `verify_schema_readiness()` to add 6 new `grant_service_role_<fn>` checks verifying service_role still has EXECUTE on the 6 critical service-role-only RPCs (`count_unread_inquiries`, `get_admin_dashboard_snapshot`, `create_inquiry_with_items(jsonb, jsonb, uuid)`, `save_product_with_images(uuid, jsonb, jsonb, timestamptz)`, `save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)`, `verify_schema_readiness()` itself). Resolves each function by canonical signature via `to_regprocedure('public.fn(sig)')` to handle overloads, then checks `has_function_privilege('service_role', <oid>, 'execute')`. All 45 existing checks (1-9) unchanged. Re-applies revoke from public/anon/authenticated and grant to service_role ONLY. | pending | pending | pending | — | — | — | CREATE OR REPLACE with the 45-check version from 20260731120000 (loses service_role grant verification in release readiness). |

## Migration execution order

Migrations MUST be applied in filename order (which is timestamp order).
The `supabase/migrations/` directory is the canonical source.

**Non-versioned files** (`schema.sql`, `policies.sql`, `seed.sql`,
`cms_seed.sql`, `cms_upgrade.sql`) are baseline/bootstrap files and are NOT
executed by `supabase migrate up`. They are listed here for reference only.

## Pre-merge migration correction exception (two windows, now closed)

PR #12 is a pre-merge hardening sweep. None of its migrations have ever
been applied to a shared Local environment, Staging, or Production. Two
windows of in-place correction occurred before the final freeze baseline
was established. Both are documented here in full so reviewers can audit
what changed and why.

### Window 1 — commit `1de0bc6` (round 1)

Commit `1de0bc6` modified four already-submitted migration files. This was
the first documented exception to the immutability rule:

- Migrations were pending and had never been applied to any environment.
- Corrections were required to make the sequence executable.
- No deployed migration history was rewritten.

### Window 2 — commits `7dfe1f6` through `1f89392` (rounds 2 and 3)

The round-2 PR body declared the manifest "frozen" at commit `7dfe1f6`,
but that declaration was premature. Round 3 surfaced real PostgreSQL 16
runtime defects (jsonb→text[] cast, missing `metadata` column, phantom
verifier catalog entries, `aclexplode` literal case) that required further
in-place edits to migrations that had already been committed. The
following migrations were modified after `7dfe1f6`:

| File | Created at | Modified after `7dfe1f6` by |
|------|------------|------------------------------|
| `20260725190000_catalog_certificate_publish_close_loop.sql` | `19a6ce0` (round 1) | `6a9874d` |
| `20260725240010_aggregate_audit_updated_fields.sql` | `dbb6cd2` (round 1) | `6a9874d` |
| `20260725250000_wire_storage_object_refs_into_asset_lifecycle.sql` | `45ad010` (round 1) | `6a9874d` |
| `20260725260000_fix_schema_verifier_runtime.sql` | `e7d4531` (round 2) | `4fe7976`, `70c81dc` |
| `20260725261000_fix_storage_ref_deletion_lifecycle.sql` | `5a163c7` (round 2) | `d6cfae3`, `6a9874d` |
| `20260725262000_fix_schema_verifier_oid_contract.sql` | `cc646b0` (round 1) | `1f79787`, `70c81dc`, `4fe7976` |
| `20260725280000_extend_managed_storage_registry_coverage.sql` | `e86580d` (round 2) | `70c81dc`, `4fe7976` |
| `20260725290000_add_admin_audit_log_metadata_column.sql` | `cbfceee` (round 3) | `f140422` (content filled in same round) |

This list was generated by `git log --follow` and `git diff --name-only
7dfe1f6..1f89392 -- supabase/migrations`, not by hand.

### Final freeze baseline

**`MIGRATION_FREEZE_REF = 1f893925f49619d0d30c871732ba3067f341fcc4`**

This is the HEAD at which all round-3 PG16 runtime fixes landed and CI was
green on all three jobs (`check`, `database`, `demo-e2e`, run
`30171668749`). After this commit:

- **Zero** existing migration files have been modified.
- **Zero** existing manifest hash lines have been rewritten.
- The immutability gate now anchors to `MIGRATION_FREEZE_REF` via
  `--verify-against-ref` (see `scripts/check-migration-immutability.mjs`).
- CI sets `MIGRATION_FREEZE_REF` and `CI_DISALLOW_INITIALIZE=true` so the
  trust baseline is enforced and `--initialize` is hard-disabled.

Any future fix to a migration that already exists at
`MIGRATION_FREEZE_REF` MUST be a NEW timestamped migration, not an in-place
edit. The `--verify-against-ref` mode will reject any PR that edits a
frozen migration or rewrites a frozen manifest hash line.

## Verification procedure

After applying migrations, run:

```bash
node scripts/check-release-readiness.mjs
```

The script calls `verify_schema_readiness()` via the Supabase service role
and BLOCKs (exit code 1) if any required schema element is missing or if a
critical RPC is incorrectly granted to anon/authenticated.

## Rollback safety

- **Never** `supabase db reset` on Staging or Production.
- **Never** modify a historical migration file.
- Rollback = write a NEW timestamped migration that reverses the change.
- Column drops lose data — prefer marking as deprecated first.
- Function drops are safe if no application code calls them.
