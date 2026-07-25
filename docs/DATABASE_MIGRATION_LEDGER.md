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

## Migration execution order

Migrations MUST be applied in filename order (which is timestamp order).
The `supabase/migrations/` directory is the canonical source.

**Non-versioned files** (`schema.sql`, `policies.sql`, `seed.sql`,
`cms_seed.sql`, `cms_upgrade.sql`) are baseline/bootstrap files and are NOT
executed by `supabase migrate up`. They are listed here for reference only.

## Pre-merge migration correction exception

Commit `1de0bc6` modified four already-submitted migration files. This is the
**only** documented exception to the immutability rule:

- Migrations were pending and had never been applied to any environment.
- Corrections were required to make the sequence executable.
- No deployed migration history was rewritten.
- After the next green HEAD, all migration files are frozen.

The `scripts/check-migration-immutability.mjs` script + `docs/MIGRATION_SHA256_MANIFEST.txt`
enforce immutability going forward. Any PR that modifies a frozen migration
will fail CI.

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
