import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const migrationsDir = resolve(root, "supabase/migrations");

function listMigrations(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .sort();
}

function readMigration(name: string): string {
  return readFileSync(resolve(migrationsDir, name), "utf8");
}

/** Strip `-- ...` line comments so keyword assertions inspect SQL only. */
function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function findMigrationContaining(needle: string): string | undefined {
  return listMigrations().find((name) => readMigration(name).includes(needle));
}

describe("get_admin_dashboard_snapshot migration static safety", () => {
  const migrationName = findMigrationContaining(
    "get_admin_dashboard_snapshot",
  );

  it("a dedicated timestamped migration exists for the snapshot RPC", () => {
    expect(migrationName, "expected a migration defining get_admin_dashboard_snapshot")
      .toMatch(/^\d{14}_.*\.sql$/);
  });

  if (!migrationName) return;

  const raw = readMigration(migrationName);
  const sql = stripLineComments(raw).toLowerCase();

  it("declares language sql (no procedural side effects)", () => {
    expect(sql).toMatch(/language\s+sql/);
    expect(sql).not.toMatch(/language\s+plpgsql/);
  });

  it("is declared stable (read-only, cacheable)", () => {
    expect(sql).toMatch(/\bstable\b/);
  });

  it("uses security invoker (runs with caller privileges)", () => {
    expect(sql).toMatch(/security\s+invoker/);
    expect(sql).not.toMatch(/security\s+definer/);
  });

  it("sets search_path to empty (no implicit schema resolution)", () => {
    expect(sql).toMatch(/set\s+search_path\s*=\s*''/);
  });

  it("references every table with an explicit public. schema prefix", () => {
    expect(sql).toMatch(/public\.products/);
    expect(sql).toMatch(/public\.certificates/);
    expect(sql).toMatch(/public\.inquiries/);
    // No bare unqualified references to the snapshot tables in FROM clauses.
    expect(sql).not.toMatch(/\bfrom\s+products\b/);
    expect(sql).not.toMatch(/\bfrom\s+certificates\b/);
    expect(sql).not.toMatch(/\bfrom\s+inquiries\b/);
  });

  it("uses exact count(*) (never estimated counts)", () => {
    expect(sql).toMatch(/count\(\*\)/);
    expect(sql).not.toMatch(/reltuples/);
    expect(sql).not.toMatch(/count_estimated/);
  });

  it("does not modify data (no insert/update/delete/truncate)", () => {
    expect(sql).not.toMatch(/\binsert\s+into\b/);
    expect(sql).not.toMatch(/\bupdate\s+public\./);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(/\balter\b/);
  });

  it("revokes execute from public, anon and authenticated", () => {
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.get_admin_dashboard_snapshot\(\)/,
    );
    expect(sql).toMatch(/from\s+public,\s*anon,\s*authenticated/);
  });

  it("grants execute to service_role only", () => {
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.get_admin_dashboard_snapshot\(\)/,
    );
    expect(sql).toMatch(/to\s+service_role/);
    // No grant to anon/authenticated/public on this function.
    const grantSection = sql.slice(
      sql.indexOf("grant execute on function public.get_admin_dashboard_snapshot"),
    );
    expect(grantSection).not.toMatch(/to\s+anon/);
    expect(grantSection).not.toMatch(/to\s+authenticated/);
    expect(grantSection).not.toMatch(/to\s+public\b/);
  });

  it("returns all five required snapshot fields as bigint", () => {
    expect(sql).toMatch(/total_products\s+bigint/);
    expect(sql).toMatch(/published_products\s+bigint/);
    expect(sql).toMatch(/total_certificates\s+bigint/);
    expect(sql).toMatch(/total_inquiries\s+bigint/);
    expect(sql).toMatch(/unread_inquiries\s+bigint/);
  });

  it("does not fall back to 0 on error (no coalesce/exception swallowing)", () => {
    expect(sql).not.toMatch(/exception\b/);
    expect(sql).not.toMatch(/coalesce/);
    expect(sql).not.toMatch(/when\s+others\s+then/);
  });
});
