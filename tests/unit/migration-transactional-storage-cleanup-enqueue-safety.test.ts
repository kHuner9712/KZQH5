import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260725160000_transactional_storage_cleanup_enqueue.sql",
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf-8");
}

describe("20260725160000_transactional_storage_cleanup_enqueue.sql (Section 9 safety)", () => {
  it("migration file exists and is non-empty", () => {
    const sql = readMigration();
    expect(sql.length).toBeGreaterThan(0);
  });

  it("is forward-only: does not drop or modify existing table data", () => {
    const sql = readMigration();
    // Forbidden destructive patterns on existing tables.
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/truncate\s+table/i);
    // Note: `delete from public.product_images where product_id = v_id`
    // inside save_product_with_images_and_audit is legitimate business
    // logic (image replacement), NOT migration-level data destruction.
    // We only forbid unconditional deletes (no WHERE clause) at the
    // migration top level.
    expect(sql).not.toMatch(/delete\s+from\s+public\.\w+\s*;/i);
    expect(sql).not.toMatch(/alter\s+table\s+public\.\w+\s+drop\s+column/i);
  });

  it("adds extract_managed_storage_path helper (security invoker + empty search_path)", () => {
    const sql = readMigration();
    const fnBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.extract_managed_storage_path[\s\S]+?\$\$;/i,
    );
    expect(fnBlock).not.toBeNull();
    expect(fnBlock![0]).toMatch(/language\s+plpgsql/i);
    expect(fnBlock![0]).toMatch(/security\s+invoker/i);
    expect(fnBlock![0]).toMatch(/set\s+search_path\s*=\s*''/i);
    // Only matches the public-assets URL prefix; never matches private-assets.
    expect(fnBlock![0]).toMatch(/\/storage\/v1\/object\/public\/public-assets\//i);
    expect(fnBlock![0]).not.toMatch(/private-assets/i);
    // Strips query string (signed URLs).
    expect(fnBlock![0]).toMatch(/position\('\?'\s+in\s+v_rest\)/i);
  });

  it("adds enqueue_managed_storage_cleanup helper (no-op for external URLs)", () => {
    const sql = readMigration();
    const fnBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.enqueue_managed_storage_cleanup[\s\S]+?\$\$;/i,
    );
    expect(fnBlock).not.toBeNull();
    expect(fnBlock![0]).toMatch(/security\s+invoker/i);
    expect(fnBlock![0]).toMatch(/set\s+search_path\s*=\s*''/i);
    // Must extract managed path first and short-circuit on null.
    expect(fnBlock![0]).toMatch(
      /v_path\s*:=\s*public\.extract_managed_storage_path\(p_url\)/i,
    );
    expect(fnBlock![0]).toMatch(
      /if\s+v_path\s+is\s+null\s+or\s+btrim\(v_path\)\s*=\s*''\s+then\s+return\s+null/i,
    );
    // Always uses 'public-assets' bucket (extract_managed_storage_path only matches that).
    expect(fnBlock![0]).toMatch(/p_bucket\s*:=\s*'public-assets'/i);
    expect(fnBlock![0]).not.toMatch(/'private-assets'/i);
  });

  it("replaces save_product_with_images with cleanup enqueue logic (signature unchanged)", () => {
    const sql = readMigration();
    // Drop the old signature before recreating.
    expect(sql).toMatch(
      /drop\s+function\s+if\s+exists\s+public\.save_product_with_images\(uuid,\s*jsonb,\s*jsonb,\s*timestamptz\)/i,
    );
    // Re-create with same signature.
    const fnBlock = sql.match(
      /create\s+function\s+public\.save_product_with_images[\s\S]+?\$\$;/i,
    );
    expect(fnBlock).not.toBeNull();
    expect(fnBlock![0]).toMatch(
      /p_id\s+uuid,\s*p_product\s+jsonb,\s*p_images\s+jsonb\s+default\s+'\[\]'::jsonb,\s*p_expected_updated_at\s+timestamptz\s+default\s+null/i,
    );
  });

  it("replaces save_product_with_images_and_audit (production RPC) with cleanup enqueue", () => {
    const sql = readMigration();
    // Drop the old signature before recreating.
    expect(sql).toMatch(
      /drop\s+function\s+if\s+exists\s+public\.save_product_with_images_and_audit\(uuid,\s*jsonb,\s*jsonb,\s*timestamptz,\s*uuid,\s*text,\s*text\)/i,
    );
    const fnBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.save_product_with_images_and_audit[\s\S]+?\$\$;/i,
    );
    expect(fnBlock).not.toBeNull();
    // Signature unchanged.
    expect(fnBlock![0]).toMatch(
      /p_id\s+uuid,\s*p_product\s+jsonb,\s*p_images\s+jsonb\s+default\s+'\[\]'::jsonb,\s*p_expected_updated_at\s+timestamptz\s+default\s+null,\s*p_actor_id\s+uuid\s+default\s+null,\s*p_actor_email\s+text\s+default\s+null,\s*p_actor_role\s+text\s+default\s+null/i,
    );
  });

  it("captures OLD URLs before mutation in save_product_with_images_and_audit", () => {
    const sql = readMigration();
    const fnBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.save_product_with_images_and_audit[\s\S]+?\$\$;/i,
    );
    expect(fnBlock).not.toBeNull();
    // Must capture old cover_image_url + video_url BEFORE the UPDATE.
    expect(fnBlock![0]).toMatch(
      /select\s+cover_image_url,\s*video_url\s+into\s+v_old_cover_image_url,\s*v_old_video_url\s+from\s+public\.products\s+where\s+id\s*=\s*p_id/i,
    );
    // Must capture old product_images BEFORE DELETE.
    expect(fnBlock![0]).toMatch(
      /select\s+array_agg\(image_url\)\s+into\s+v_old_image_urls\s+from\s+public\.product_images\s+where\s+product_id\s*=\s*p_id/i,
    );
  });

  it("enqueues removed URLs only when value changed (not on every save)", () => {
    const sql = readMigration();
    const fnBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.save_product_with_images_and_audit[\s\S]+?\$\$;/i,
    );
    expect(fnBlock).not.toBeNull();
    // cover_image_url: only enqueue when old != new.
    expect(fnBlock![0]).toMatch(
      /v_old_cover_image_url\s+<>\s*coalesce\(v_new_cover_image_url,\s*''\)/i,
    );
    // video_url: only enqueue when old != new.
    expect(fnBlock![0]).toMatch(
      /v_old_video_url\s+<>\s*coalesce\(v_new_video_url,\s*''\)/i,
    );
  });

  it("uses enqueue_managed_storage_cleanup for removed URLs (external URLs are NOT enqueued)", () => {
    const sql = readMigration();
    const fnBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.save_product_with_images_and_audit[\s\S]+?\$\$;/i,
    );
    expect(fnBlock).not.toBeNull();
    // Must call enqueue_managed_storage_cleanup, NOT enqueue_storage_cleanup directly.
    expect(fnBlock![0]).toMatch(/enqueue_managed_storage_cleanup/i);
    // Reason for replaced product images is 'replaced'.
    expect(fnBlock![0]).toMatch(/p_reason\s*:=\s*'replaced'/i);
    // Source type identifies the kind of asset (product_image | product_cover_image | product_video).
    expect(fnBlock![0]).toMatch(/p_source_type\s*:=\s*'product_image'/i);
    expect(fnBlock![0]).toMatch(/p_source_type\s*:=\s*'product_cover_image'/i);
    expect(fnBlock![0]).toMatch(/p_source_type\s*:=\s*'product_video'/i);
  });

  it("replaces save_project_with_relations with cleanup enqueue (signature unchanged)", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /drop\s+function\s+if\s+exists\s+public\.save_project_with_relations\(uuid,\s*jsonb,\s*jsonb,\s*jsonb,\s*timestamptz\)/i,
    );
    const fnBlock = sql.match(
      /create\s+function\s+public\.save_project_with_relations[\s\S]+?\$\$;/i,
    );
    expect(fnBlock).not.toBeNull();
    expect(fnBlock![0]).toMatch(
      /p_id\s+uuid,\s*p_project\s+jsonb,\s*p_images\s+jsonb\s+default\s+'\[\]'::jsonb,\s*p_products\s+jsonb\s+default\s+'\[\]'::jsonb,\s*p_expected_updated_at\s+timestamptz\s+default\s+null/i,
    );
  });

  it("save_project_with_relations enqueues removed project images + cover + video", () => {
    const sql = readMigration();
    const fnBlock = sql.match(
      /create\s+function\s+public\.save_project_with_relations[\s\S]+?\$\$;/i,
    );
    expect(fnBlock).not.toBeNull();
    expect(fnBlock![0]).toMatch(
      /select\s+array_agg\(image_url\)\s+into\s+v_old_image_urls\s+from\s+public\.project_images\s+where\s+project_id\s*=\s*p_id/i,
    );
    expect(fnBlock![0]).toMatch(
      /p_source_type\s*:=\s*'project_image'/i,
    );
    expect(fnBlock![0]).toMatch(
      /p_source_type\s*:=\s*'project_cover_image'/i,
    );
    expect(fnBlock![0]).toMatch(
      /p_source_type\s*:=\s*'project_video'/i,
    );
  });

  it("declares all new/replaced RPCs as security invoker with empty search_path", () => {
    const sql = readMigration();
    // Every CREATE FUNCTION must include SECURITY INVOKER + SET search_path = ''.
    const fnBlocks =
      sql.match(
        /create\s+(or\s+replace\s+)?function\s+public\.\w+[\s\S]+?\$\$;/gi,
      ) ?? [];
    expect(fnBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of fnBlocks) {
      expect(block).toMatch(/security\s+invoker/i);
      expect(block).toMatch(/set\s+search_path\s*=\s*''/i);
    }
  });

  it("revokes execute on new RPCs from public/anon/authenticated; grants to service_role only", () => {
    const sql = readMigration();
    // New RPCs must not be callable by anon / authenticated.
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.extract_managed_storage_path\(text\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.extract_managed_storage_path\(text\)\s+to\s+service_role/i,
    );
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.enqueue_managed_storage_cleanup\(text,\s*text,\s*text,\s*uuid\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.enqueue_managed_storage_cleanup\(text,\s*text,\s*text,\s*uuid\)\s+to\s*service_role/i,
    );
  });

  it("updates verify_required_schema to know about new helpers", () => {
    const sql = readMigration();
    const verifyBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.verify_required_schema[\s\S]+?\$\$;/i,
    );
    expect(verifyBlock).not.toBeNull();
    expect(verifyBlock![0]).toMatch(/enqueue_managed_storage_cleanup/i);
    expect(verifyBlock![0]).toMatch(/extract_managed_storage_path/i);
    expect(verifyBlock![0]).toMatch(/storage_cleanup_queue/i);
    expect(verifyBlock![0]).toMatch(/admin_storage_operations/i);
  });
});
