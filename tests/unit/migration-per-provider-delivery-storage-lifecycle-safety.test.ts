import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260725110000_per_provider_delivery_storage_lifecycle.sql",
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf-8");
}

describe("20260725110000_per_provider_delivery_storage_lifecycle.sql (Phase 15 safety)", () => {
  it("adds provider initialization columns to inquiry_outbox", () => {
    const sql = readMigration();
    // The migration uses a single ALTER TABLE with two ADD COLUMN clauses
    // spread across multiple lines:
    //   alter table public.inquiry_outbox
    //     add column if not exists providers_initialized_at timestamptz,
    //     add column if not exists configured_provider_count integer not null default 0;
    expect(sql).toMatch(/alter\s+table\s+public\.inquiry_outbox/i);
    expect(sql).toMatch(
      /add\s+column\s+if\s+not\s+exists\s+providers_initialized_at\s+timestamptz/i,
    );
    expect(sql).toMatch(
      /add\s+column\s+if\s+not\s+exists\s+configured_provider_count\s+integer\s+not\s+null\s+default\s+0/i,
    );
  });

  it("drops the legacy partial unique index before creating the unconditional constraint", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /drop\s+index\s+if\s+exists\s+public\.uq_outbox_deliveries_event_provider_active/i,
    );
    expect(sql).toMatch(
      /alter\s+table\s+public\.inquiry_outbox_deliveries\s+add\s+constraint\s+uq_outbox_deliveries_event_provider\s+unique\s+\(outbox_event_id,\s*provider\)/i,
    );
  });

  it("fail-closed: duplicate detection before constraint creation", () => {
    const sql = readMigration();
    // Must check for existing duplicates and raise_exception if found.
    expect(sql).toMatch(/raise\s+exception/i);
    expect(sql).toMatch(/check_violation/i);
    expect(sql).toMatch(/having\s+count\(\*\)\s*>\s*1/i);
  });

  it("claim_inquiry_outbox_deliveries returns attempts and max_attempts", () => {
    const sql = readMigration();
    // The replaced claim RPC must return attempts + max_attempts.
    const claimBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.claim_inquiry_outbox_deliveries[\s\S]+?\$\$;/i,
    );
    expect(claimBlock).not.toBeNull();
    expect(claimBlock![0]).toMatch(/returning\s+id,\s*outbox_event_id,\s*provider,\s*lock_token,\s*attempts,\s*max_attempts/i);
  });

  it("claim_inquiry_outbox_deliveries uses FOR UPDATE SKIP LOCKED + make_interval", () => {
    const sql = readMigration();
    const claimBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.claim_inquiry_outbox_deliveries[\s\S]+?\$\$;/i,
    );
    expect(claimBlock).not.toBeNull();
    expect(claimBlock![0]).toMatch(/for\s+update\s+skip\s+locked/i);
    expect(claimBlock![0]).toMatch(/make_interval\(secs\s*=>\s*v_safe_timeout\)/i);
    // Must NOT use the broken string-concatenation interval pattern.
    expect(claimBlock![0]).not.toMatch(/\(v_safe_timeout\s*\|\|\s*' seconds'\)::interval/i);
  });

  it("initialize_inquiry_outbox_deliveries whitelists only email and wecom", () => {
    const sql = readMigration();
    const initBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.initialize_inquiry_outbox_deliveries[\s\S]+?\$\$;/i,
    );
    expect(initBlock).not.toBeNull();
    expect(initBlock![0]).toMatch(
      /if\s+v_provider\s+in\s+\('email',\s*'wecom'\)\s+then/i,
    );
  });

  it("initialize with zero providers transitions parent to dead_letter", () => {
    const sql = readMigration();
    const initBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.initialize_inquiry_outbox_deliveries[\s\S]+?\$\$;/i,
    );
    expect(initBlock).not.toBeNull();
    expect(initBlock![0]).toMatch(/if\s+v_count\s*=\s*0\s+then/i);
    expect(initBlock![0]).toMatch(/status\s*=\s*'dead_letter'/i);
    expect(initBlock![0]).toMatch(/last_error_code\s*=\s*'NOTIFICATION_NOT_CONFIGURED'/i);
  });

  it("find_uninitialized_outbox_events returns uuid[]", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /create\s+or\s+replace\s+function\s+public\.find_uninitialized_outbox_events[\s\S]+?returns\s+uuid\[]/i,
    );
    // Must filter on providers_initialized_at IS NULL.
    expect(sql).toMatch(/providers_initialized_at\s+is\s+null/i);
  });

  it("storage_cleanup_queue has required fields and RLS", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.storage_cleanup_queue/i,
    );
    const requiredFields = [
      "id",
      "bucket",
      "object_path",
      "reason",
      "source_type",
      "source_id",
      "status",
      "attempts",
      "max_attempts",
      "lock_token",
      "locked_at",
      "next_retry_at",
      "last_error_code",
      "created_at",
      "updated_at",
      "completed_at",
    ];
    for (const field of requiredFields) {
      expect(sql).toMatch(new RegExp(`\\b${field}\\b`, "i"));
    }
    expect(sql).toMatch(
      /alter\s+table\s+public\.storage_cleanup_queue\s+enable\s+row\s+level\s+security/i,
    );
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+table\s+public\.storage_cleanup_queue\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /grant\s+all\s+on\s+table\s+public\.storage_cleanup_queue\s+to\s+service_role/i,
    );
    // Unique index for active rows (pending/claimed/retry).
    expect(sql).toMatch(
      /create\s+unique\s+index\s+if\s+not\s+exists\s+uq_storage_cleanup_active/i,
    );
  });

  it("enqueue_storage_cleanup validates bucket whitelist and rejects empty path", () => {
    const sql = readMigration();
    const enqueueBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.enqueue_storage_cleanup[\s\S]+?\$\$;/i,
    );
    expect(enqueueBlock).not.toBeNull();
    expect(enqueueBlock![0]).toMatch(
      /p_bucket\s+not\s+in\s+\('public-assets',\s*'private-assets'\)/i,
    );
    expect(enqueueBlock![0]).toMatch(/check_violation/i);
    expect(enqueueBlock![0]).toMatch(
      /length\(p_object_path\)\s*=\s*0/i,
    );
  });

  it("check_storage_object_referenced checks all known URL columns", () => {
    const sql = readMigration();
    const checkBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.check_storage_object_referenced[\s\S]+?\$\$;/i,
    );
    expect(checkBlock).not.toBeNull();
    // Must check products.cover_image_url + video_url.
    expect(checkBlock![0]).toMatch(/products/i);
    expect(checkBlock![0]).toMatch(/cover_image_url/i);
    expect(checkBlock![0]).toMatch(/video_url/i);
    // Must check product_images.image_url.
    expect(checkBlock![0]).toMatch(/product_images/i);
    expect(checkBlock![0]).toMatch(/image_url/i);
    // Must check product_assets.file_url + cover_image_url.
    expect(checkBlock![0]).toMatch(/product_assets/i);
    expect(checkBlock![0]).toMatch(/file_url/i);
    // Must check certificates.image_url.
    expect(checkBlock![0]).toMatch(/certificates/i);
    // Must check projects.cover_image_url + video_url.
    expect(checkBlock![0]).toMatch(/projects/i);
    // Refuse delete on invalid path (returns true).
    expect(checkBlock![0]).toMatch(/return\s+true/i);
  });

  it("claim_storage_cleanup uses FOR UPDATE SKIP LOCKED + stale recovery", () => {
    const sql = readMigration();
    const claimBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.claim_storage_cleanup[\s\S]+?\$\$;/i,
    );
    expect(claimBlock).not.toBeNull();
    expect(claimBlock![0]).toMatch(/for\s+update\s+skip\s+locked/i);
    expect(claimBlock![0]).toMatch(
      /make_interval\(secs\s*=>\s*v_safe_timeout\)/i,
    );
  });

  it("complete_storage_cleanup clears lock fields on completed and retry", () => {
    const sql = readMigration();
    const completeBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.complete_storage_cleanup[\s\S]+?\$\$;/i,
    );
    expect(completeBlock).not.toBeNull();
    // Success branch must clear lock_token + locked_at.
    expect(completeBlock![0]).toMatch(
      /status\s*=\s*'completed'[\s\S]+?lock_token\s*=\s*null[\s\S]+?locked_at\s*=\s*null/i,
    );
    // Dead_letter branch must clear lock_token + locked_at.
    expect(completeBlock![0]).toMatch(
      /status\s*=\s*'dead_letter'[\s\S]+?lock_token\s*=\s*null[\s\S]+?locked_at\s*=\s*null/i,
    );
    // Retry branch must clear lock_token + locked_at.
    expect(completeBlock![0]).toMatch(
      /status\s*=\s*'retry'[\s\S]+?lock_token\s*=\s*null[\s\S]+?locked_at\s*=\s*null/i,
    );
    // Exponential backoff with cap.
    expect(completeBlock![0]).toMatch(/power\(2,\s*v_attempts\s*-\s*1\)/i);
    expect(completeBlock![0]).toMatch(/interval\s+'30\s+minutes'/i);
  });

  it("fail_delivery_event supports p_force_dead_letter parameter", () => {
    const sql = readMigration();
    const failBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.fail_delivery_event[\s\S]+?\$\$;/i,
    );
    expect(failBlock).not.toBeNull();
    expect(failBlock![0]).toMatch(/p_force_dead_letter\s+boolean\s+default\s+false/i);
    expect(failBlock![0]).toMatch(
      /if\s+p_force_dead_letter\s+or\s+v_attempts\s*>=\s*v_max_attempts\s+then/i,
    );
    // Lock fields cleared on both branches.
    const lockClears = failBlock![0].match(/lock_token\s*=\s*null/gi) ?? [];
    expect(lockClears.length).toBeGreaterThanOrEqual(2);
  });

  it("fail_delivery_event marks parent dead_letter when any delivery is dead_letter", () => {
    const sql = readMigration();
    const failBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.fail_delivery_event[\s\S]+?\$\$;/i,
    );
    expect(failBlock).not.toBeNull();
    expect(failBlock![0]).toMatch(
      /update\s+public\.inquiry_outbox\s+set\s+status\s*=\s*'dead_letter'[\s\S]+?where\s+id\s*=\s*v_event_id/i,
    );
  });

  it("publish_catalog_asset enforces publication gate", () => {
    const sql = readMigration();
    const publishBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.publish_catalog_asset[\s\S]+?\$\$;/i,
    );
    expect(publishBlock).not.toBeNull();
    // Must check access_level = 'public'.
    expect(publishBlock![0]).toMatch(
      /v_access_level\s*<>\s*'public'/i,
    );
    // Must check authorization_status = 'confirmed'.
    expect(publishBlock![0]).toMatch(
      /v_auth_status\s*<>\s*'confirmed'/i,
    );
    // Must check is_published = true.
    expect(publishBlock![0]).toMatch(/not\s+v_is_published/i);
    // Must use FOR UPDATE lock.
    expect(publishBlock![0]).toMatch(/for\s+update/i);
  });

  it("publish_catalog_asset inserts audit log in same transaction", () => {
    const sql = readMigration();
    const publishBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.publish_catalog_asset[\s\S]+?\$\$;/i,
    );
    expect(publishBlock).not.toBeNull();
    expect(publishBlock![0]).toMatch(
      /insert\s+into\s+public\.admin_audit_log/i,
    );
    expect(publishBlock![0]).toMatch(/catalog_asset\.publish/i);
  });

  it("publish_catalog_asset returns old + new URLs", () => {
    const sql = readMigration();
    const publishBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.publish_catalog_asset[\s\S]+?\$\$;/i,
    );
    expect(publishBlock).not.toBeNull();
    expect(publishBlock![0]).toMatch(/old_file_url/i);
    expect(publishBlock![0]).toMatch(/old_cover_image_url/i);
    expect(publishBlock![0]).toMatch(/new_file_url/i);
    expect(publishBlock![0]).toMatch(/new_cover_image_url/i);
  });

  it("declares all new RPCs as security invoker with empty search_path", () => {
    const sql = readMigration();
    // Match all function definitions.
    const fnBlocks =
      sql.match(
        /create\s+(or\s+replace\s+)?function\s+public\.\w+[\s\S]+?\$\$;/gi,
      ) ?? [];
    // New + redefined RPCs: claim_inquiry_outbox_deliveries,
    // initialize_inquiry_outbox_deliveries, find_uninitialized_outbox_events,
    // mark_inquiry_outbox_not_configured, enqueue_storage_cleanup,
    // check_storage_object_referenced, claim_storage_cleanup,
    // complete_storage_cleanup, fail_delivery_event, publish_catalog_asset.
    expect(fnBlocks.length).toBeGreaterThanOrEqual(10);
    for (const block of fnBlocks) {
      expect(block).toMatch(/security\s+invoker/i);
      expect(block).toMatch(/set\s+search_path\s*=\s*''/i);
    }
  });

  it("revokes all new RPCs from public/anon/authenticated and grants only service_role", () => {
    const sql = readMigration();
    const revokeCount = (sql.match(/revoke\s+all\s+on\s+function/gi) ?? []).length;
    const grantCount = (sql.match(/grant\s+execute\s+on\s+function/gi) ?? []).length;
    // At least 10 new RPCs.
    expect(revokeCount).toBeGreaterThanOrEqual(10);
    expect(grantCount).toBeGreaterThanOrEqual(10);
    // Never grants execute to anon or authenticated.
    expect(sql).not.toMatch(
      /grant\s+execute\s+on\s+function[^;]*\bto\s+(anon|authenticated)/i,
    );
  });

  it("qualifies every table reference as public.<table>", () => {
    const sql = readMigration();
    // No bare (unqualified) references to business tables.
    expect(sql).not.toMatch(/\bfrom\s+inquiry_outbox\b/i);
    expect(sql).not.toMatch(/\bfrom\s+inquiry_outbox_deliveries\b/i);
    expect(sql).not.toMatch(/\bfrom\s+storage_cleanup_queue\b/i);
    expect(sql).not.toMatch(/\bfrom\s+product_assets\b/i);
    expect(sql).not.toMatch(/\bfrom\s+products\b/i);
    expect(sql).not.toMatch(/\bfrom\s+product_images\b/i);
    expect(sql).not.toMatch(/\bfrom\s+certificates\b/i);
    expect(sql).not.toMatch(/\bfrom\s+projects\b/i);
    expect(sql).not.toMatch(/\binto\s+inquiry_outbox_deliveries\b/i);
    expect(sql).not.toMatch(/\binto\s+storage_cleanup_queue\b/i);
    expect(sql).not.toMatch(/\bupdate\s+inquiry_outbox\b/i);
    expect(sql).not.toMatch(/\bupdate\s+inquiry_outbox_deliveries\b/i);
    expect(sql).not.toMatch(/\bupdate\s+storage_cleanup_queue\b/i);
    expect(sql).not.toMatch(/\bupdate\s+product_assets\b/i);
    // Qualified references must be present.
    expect(sql).toMatch(/\bfrom\s+public\.inquiry_outbox\b/i);
    expect(sql).toMatch(/\bfrom\s+public\.inquiry_outbox_deliveries\b/i);
    expect(sql).toMatch(/\bfrom\s+public\.storage_cleanup_queue\b/i);
    expect(sql).toMatch(/\bfrom\s+public\.product_assets\b/i);
    expect(sql).toMatch(/\bfrom\s+public\.products\b/i);
    expect(sql).toMatch(/\bfrom\s+public\.product_images\b/i);
    expect(sql).toMatch(/\bfrom\s+public\.certificates\b/i);
    expect(sql).toMatch(/\bfrom\s+public\.projects\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.inquiry_outbox\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.inquiry_outbox_deliveries\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.storage_cleanup_queue\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.product_assets\b/i);
    expect(sql).toMatch(/\binto\s+public\.inquiry_outbox_deliveries\b/i);
    expect(sql).toMatch(/\binto\s+public\.storage_cleanup_queue\b/i);
    expect(sql).toMatch(/\binto\s+public\.admin_audit_log\b/i);
  });

  it("deprecates (does NOT drop) old parent-level RPCs", () => {
    const sql = readMigration();
    // Must add deprecation comments, NOT drop the old RPCs.
    expect(sql).toMatch(
      /comment\s+on\s+function\s+public\.claim_inquiry_outbox_batch/i,
    );
    expect(sql).toMatch(
      /comment\s+on\s+function\s+public\.mark_inquiry_outbox_sent/i,
    );
    expect(sql).toMatch(
      /comment\s+on\s+function\s+public\.fail_inquiry_outbox_event/i,
    );
    expect(sql).toMatch(/DEPRECATED/i);
    // Must NOT drop the old RPCs.
    expect(sql).not.toMatch(/drop\s+function\s+public\.claim_inquiry_outbox_batch/i);
    expect(sql).not.toMatch(/drop\s+function\s+public\.mark_inquiry_outbox_sent/i);
    expect(sql).not.toMatch(/drop\s+function\s+public\.fail_inquiry_outbox_event/i);
  });
});
