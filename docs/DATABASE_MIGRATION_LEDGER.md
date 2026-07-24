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
| 4 | `20260714125149_production_stability_analytics_wechat.pdf` | Add analytics_events table + initial 14-event constraint; company_profile.wechat column. | unknown | unknown | unknown | — | — | — | Drop analytics_events table, wechat column. |
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

## Migration execution order

Migrations MUST be applied in filename order (which is timestamp order).
The `supabase/migrations/` directory is the canonical source.

**Non-versioned files** (`schema.sql`, `policies.sql`, `seed.sql`,
`cms_seed.sql`, `cms_upgrade.sql`) are baseline/bootstrap files and are NOT
executed by `supabase migrate up`. They are listed here for reference only.

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
