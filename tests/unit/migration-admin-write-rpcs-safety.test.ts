import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260724130000_admin_transactional_write_rpcs.sql",
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf-8");
}

describe("20260724130000_admin_transactional_write_rpcs.sql (Phase 2 static safety)", () => {
  it("is an additive migration (no ALTER on existing tables)", () => {
    const sql = readMigration();
    expect(sql).not.toMatch(/\balter\s+table\s+public\.products\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.product_images\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.projects\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.project_images\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.project_products\b/i);
    // No DROP statements.
    expect(sql).not.toMatch(/\bdrop\s+(table|function|column|index)\b/i);
  });

  it("declares both RPCs as security invoker with empty search_path", () => {
    const sql = readMigration();
    const fnBlocks = sql.match(/create or replace function[\s\S]+?\$\$;/gi) ?? [];
    expect(fnBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of fnBlocks) {
      expect(block).toMatch(/security\s+invoker/i);
      expect(block).toMatch(/set\s+search_path\s*=\s*''/i);
    }
  });

  it("qualifies every table reference as public.<table>", () => {
    const sql = readMigration();
    // Every INSERT / UPDATE / DELETE FROM must use public.<table>.
    expect(sql).toMatch(/\binsert\s+into\s+public\.products\b/i);
    expect(sql).toMatch(/\binsert\s+into\s+public\.product_images\b/i);
    expect(sql).toMatch(/\binsert\s+into\s+public\.projects\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.products\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.projects\b/i);
    expect(sql).toMatch(/\bdelete\s+from\s+public\.product_images\b/i);
    expect(sql).toMatch(/\bdelete\s+from\s+public\.project_images\b/i);
    expect(sql).toMatch(/\bdelete\s+from\s+public\.project_products\b/i);
    // No bare (unqualified) references to business tables anywhere.
    expect(sql).not.toMatch(/\bfrom\s+products\b/i);
    expect(sql).not.toMatch(/\bfrom\s+product_images\b/i);
    expect(sql).not.toMatch(/\bfrom\s+projects\b/i);
    expect(sql).not.toMatch(/\bfrom\s+project_images\b/i);
    expect(sql).not.toMatch(/\bfrom\s+project_products\b/i);
    expect(sql).not.toMatch(/\binto\s+products\b/i);
    expect(sql).not.toMatch(/\binto\s+product_images\b/i);
    expect(sql).not.toMatch(/\binto\s+projects\b/i);
    expect(sql).not.toMatch(/\bupdate\s+products\b/i);
    expect(sql).not.toMatch(/\bupdate\s+projects\b/i);
  });

  it("revokes from public/anon/authenticated and grants only service_role", () => {
    const sql = readMigration();
    // Two functions -> two revoke + two grant blocks.
    const revokeCount = (sql.match(/revoke\s+all\s+on\s+function/gi) ?? []).length;
    const grantCount = (sql.match(/grant\s+execute\s+on\s+function/gi) ?? []).length;
    expect(revokeCount).toBeGreaterThanOrEqual(2);
    expect(grantCount).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/revoke\s+all[\s\S]+?from\s+public,\s*anon,\s*authenticated/gi);
    expect(sql).toMatch(/grant\s+execute[\s\S]+?to\s+service_role/gi);
    // Never grant to anon or authenticated.
    expect(sql).not.toMatch(/grant\s+execute[\s\S]+?to\s+(anon|authenticated)/gi);
  });

  it("does not contain dynamic SQL (EXECUTE / format with %s)", () => {
    const sql = readMigration();
    expect(sql).not.toMatch(/\bexecute\s+'/i);
    expect(sql).not.toMatch(/\bformat\s*\(/i);
  });

  it("uses explicit column lists (no SELECT * on business tables / no jsonb_populate_record)", () => {
    const sql = readMigration();
    // SELECT * is only allowed against jsonb_array_elements (set-returning
    // function that yields the array elements), never against business tables.
    expect(sql).not.toMatch(/select\s+\*\s+from\s+public\.(products|product_images|projects|project_images|project_products)/i);
    expect(sql).not.toMatch(/select\s+\*\s+from\s+(products|product_images|projects|project_images|project_products)\b/i);
    expect(sql).not.toMatch(/jsonb_populate_record/i);
    // Every INSERT into a business table must list columns explicitly.
    expect(sql).not.toMatch(/insert\s+into\s+public\.\w+\s*values\s*\(/i);
    const inserts = sql.match(/insert\s+into\s+public\.\w+\s*\([^)]+\)/gi) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(4);
  });

  it("wraps image + relation replacement in the same transaction body", () => {
    const sql = readMigration();
    // The product RPC must delete images and re-insert them between the
    // parent insert/update and the RETURN — all inside the same $$ block.
    const productFn = sql.match(
      /create or replace function public\.save_product_with_images[\s\S]+?\$\$;/i,
    )?.[0] ?? "";
    expect(productFn).toMatch(/delete\s+from\s+public\.product_images/i);
    expect(productFn).toMatch(/insert\s+into\s+public\.product_images/i);
    // The project RPC must delete + re-insert images AND product links.
    const projectFn = sql.match(
      /create or replace function public\.save_project_with_relations[\s\S]+?\$\$;/i,
    )?.[0] ?? "";
    expect(projectFn).toMatch(/delete\s+from\s+public\.project_images/i);
    expect(projectFn).toMatch(/delete\s+from\s+public\.project_products/i);
    expect(projectFn).toMatch(/insert\s+into\s+public\.project_products/i);
  });

  it("does not perform any data reads that leak unrelated rows", () => {
    const sql = readMigration();
    // No SELECT ... INTO that could exfiltrate data into the response.
    expect(sql).not.toMatch(/select\s+\*\s+into/i);
    // No PERFORM of unrelated functions.
    expect(sql).not.toMatch(/\bperform\s+/i);
  });
});
