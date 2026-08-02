import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const MIGRATION_PATH = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260802193000_homepage_hero_carousel_and_copy.sql",
);

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("homepage hero carousel migration", () => {
  let sql: string;

  beforeEach(() => {
    sql = readFileSync(MIGRATION_PATH, "utf8");
  });

  it("is forward-only and does not remove business data", () => {
    const executable = stripComments(sql);
    expect(executable).not.toMatch(/drop\s+table/i);
    expect(executable).not.toMatch(/truncate/i);
    expect(executable).not.toMatch(/delete\s+from\s+public\.homepage_content/i);
  });

  it("adds a bounded jsonb hero_slides column", () => {
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+hero_slides\s+jsonb/i);
    expect(sql).toMatch(/jsonb_typeof\(hero_slides\)\s*=\s*'array'/i);
    expect(sql).toMatch(/jsonb_array_length\(hero_slides\)\s*<=\s*5/i);
  });

  it("preserves transactional audit and optimistic locking", () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.save_homepage_content_with_audit/i);
    expect(sql).toMatch(/p_expected_updated_at\s+is\s+null/i);
    expect(sql).toMatch(/errcode\s*=\s*'22004'/i);
    expect(sql).toMatch(/v_existing\.updated_at\s*<>\s*p_expected_updated_at/i);
    expect(sql).toMatch(/insert\s+into\s+public\.admin_audit_log/i);
  });

  it("uses SECURITY INVOKER, an empty search_path and service_role-only execute", () => {
    expect(sql).toMatch(/language\s+plpgsql\s+security\s+invoker\s+set\s+search_path\s*=\s*''/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+function[\s\S]*from\s+public,\s*anon,\s*authenticated/i);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function[\s\S]*to\s+service_role/i);
  });

  it("queues removed managed hero images rather than deleting them inline", () => {
    expect(sql).toContain("enqueue_managed_storage_cleanup");
    expect(sql).toContain("homepage_hero");
    expect(sql).not.toMatch(/delete\s+from\s+storage\.objects/i);
  });
});
