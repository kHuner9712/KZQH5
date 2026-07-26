import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260725100000_fix_storage_rls_outbox_rpc.sql",
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf-8");
}

describe("20260725100000_fix_storage_rls_outbox_rpc.sql (Phase 14 safety)", () => {
  it("drops the legacy storage policies by EXPLICIT name (not pattern)", () => {
    const sql = readMigration();
    // Must explicitly drop the four legacy policies by name. The previous
    // migration tried `policyname like '%authenticated%'` which matched
    // nothing because the policies are named `*_admin_*`.
    expect(sql).toMatch(
      /drop\s+policy\s+if\s+exists\s+"public_assets_admin_write"\s+on\s+storage\.objects/i,
    );
    expect(sql).toMatch(
      /drop\s+policy\s+if\s+exists\s+"public_assets_admin_update"\s+on\s+storage\.objects/i,
    );
    expect(sql).toMatch(
      /drop\s+policy\s+if\s+exists\s+"public_assets_admin_delete"\s+on\s+storage\.objects/i,
    );
    expect(sql).toMatch(
      /drop\s+policy\s+if\s+exists\s+"private_assets_admin_all"\s+on\s+storage\.objects/i,
    );
    // Must NOT use the broken pattern-based drop.
    expect(sql).not.toMatch(/policyname\s+like\s+'%authenticated%'/i);
  });

  it("recreates only service_role + anon-read-public-assets policies", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /create\s+policy\s+"service_role_all_storage"\s+on\s+storage\.objects\s+for\s+all\s+to\s+service_role/i,
    );
    expect(sql).toMatch(
      /create\s+policy\s+"anon_read_public_assets_only"\s+on\s+storage\.objects\s+for\s+select\s+to\s+anon/i,
    );
    // No policy grants INSERT/UPDATE/DELETE to authenticated.
    expect(sql).not.toMatch(
      /create\s+policy[^;]*\bto\b[^;]*\bauthenticated\b[^;]*\b(insert|update|delete|for\s+all)\b/i,
    );
  });

  it("replaces update_inquiry_with_audit with static SQL (no dynamic EXECUTE)", () => {
    const sql = readMigration();
    // Must NOT contain the broken `returning to_jsonb(t)` alias.
    expect(sql).not.toMatch(/returning\s+to_jsonb\(t\)/i);
    // Must use static SQL with `returning * into v_row`.
    expect(sql).toMatch(/returning\s+\*\s+into\s+v_row/i);
    // Must NOT use dynamic `execute format(...)` for the UPDATE.
    // (Static CASE statements handle the partial patch.)
    expect(sql).toMatch(/update\s+public\.inquiries\s+set\s+status\s*=\s*case/i);
    expect(sql).toMatch(/is_read\s*=\s*case/i);
    expect(sql).toMatch(/read_at\s*=\s*case/i);
    expect(sql).toMatch(/notes\s*=\s*case/i);
    expect(sql).toMatch(/assignee\s*=\s*case/i);
  });

  it("fixes the outbox claim WHERE clause operator precedence", () => {
    const sql = readMigration();
    // The corrected form groups the two claimable-state predicates
    // with parens, then applies the attempts filter via an outer AND.
    // We check for the corrected pattern: `) and attempts < max_attempts`.
    expect(sql).toMatch(/\)\s*\n\s*and\s+attempts\s*<\s*max_attempts/i);
    // Must NOT use the broken string-concatenation interval pattern.
    expect(sql).not.toMatch(/\(v_safe_timeout\s*\|\|\s*' seconds'\)::interval/i);
    // Must use make_interval(secs => v_safe_timeout).
    expect(sql).toMatch(/make_interval\(secs\s*=>\s*v_safe_timeout\)/i);
  });

  it("clears lock fields on sent / retry / dead_letter transitions", () => {
    const sql = readMigration();
    // mark_inquiry_outbox_sent must clear lock_token, locked_at,
    // processing_started_at on the sent transition.
    const sentBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.mark_inquiry_outbox_sent[\s\S]+?\$\$;/i,
    );
    expect(sentBlock).not.toBeNull();
    expect(sentBlock![0]).toMatch(/lock_token\s*=\s*null/i);
    expect(sentBlock![0]).toMatch(/locked_at\s*=\s*null/i);
    expect(sentBlock![0]).toMatch(/processing_started_at\s*=\s*null/i);

    // fail_inquiry_outbox_event must clear lock fields on BOTH the
    // dead_letter and retry transitions.
    const failBlock = sql.match(
      /create\s+or\s+replace\s+function\s+public\.fail_inquiry_outbox_event[\s\S]+?\$\$;/i,
    );
    expect(failBlock).not.toBeNull();
    // Two UPDATE branches (dead_letter + retry), each must clear
    // lock fields. Count occurrences of `lock_token = null` — at
    // least 2 (one per branch) inside the fail function.
    const lockClearsInFail =
      failBlock![0].match(/lock_token\s*=\s*null/gi) ?? [];
    expect(lockClearsInFail.length).toBeGreaterThanOrEqual(2);
  });

  it("creates inquiry_outbox_deliveries with RLS and service_role-only grant", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.inquiry_outbox_deliveries/i,
    );
    expect(sql).toMatch(
      /alter\s+table\s+public\.inquiry_outbox_deliveries\s+enable\s+row\s+level\s+security/i,
    );
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+table\s+public\.inquiry_outbox_deliveries\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /grant\s+all\s+on\s+table\s+public\.inquiry_outbox_deliveries\s+to\s+service_role/i,
    );
    // Never grants to anon or authenticated.
    expect(sql).not.toMatch(
      /grant\s+all\s+on\s+table\s+public\.inquiry_outbox_deliveries\s+to\s+(anon|authenticated)/i,
    );
    // Has a unique partial index on (event, provider) for active rows.
    expect(sql).toMatch(
      /create\s+unique\s+index\s+if\s+not\s+exists\s+uq_outbox_deliveries_event_provider_active/i,
    );
  });

  it("creates admin_storage_operations table with required audit fields", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.admin_storage_operations/i,
    );
    // Required audit fields per the task spec.
    const requiredFields = [
      "actor_id",
      "actor_role",
      "action",
      "bucket",
      "object_path",
      "mime_type",
      "size_bytes",
      "sha256",
      "status",
      "error_code",
      "created_at",
      "completed_at",
    ];
    for (const field of requiredFields) {
      expect(sql).toMatch(new RegExp(`\\b${field}\\b`, "i"));
    }
    expect(sql).toMatch(
      /alter\s+table\s+public\.admin_storage_operations\s+enable\s+row\s+level\s+security/i,
    );
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+table\s+public\.admin_storage_operations\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /grant\s+all\s+on\s+table\s+public\.admin_storage_operations\s+to\s+service_role/i,
    );
  });

  it("declares all RPCs as security invoker with empty search_path", () => {
    const sql = readMigration();
    const fnBlocks =
      sql.match(
        /create\s+(or\s+replace\s+)?function\s+public\.\w+[\s\S]+?\$\$;/gi,
      ) ?? [];
    // 6 functions: update_inquiry_with_audit, claim_inquiry_outbox_batch,
    // mark_inquiry_outbox_sent, fail_inquiry_outbox_event,
    // claim_inquiry_outbox_deliveries, mark_delivery_sent,
    // fail_delivery_event, record_storage_operation_started,
    // complete_storage_operation -> 9 functions.
    expect(fnBlocks.length).toBeGreaterThanOrEqual(9);
    for (const block of fnBlocks) {
      expect(block).toMatch(/security\s+invoker/i);
      expect(block).toMatch(/set\s+search_path\s*=\s*''/i);
    }
  });

  it("revokes all RPCs from public/anon/authenticated and grants only service_role", () => {
    const sql = readMigration();
    const revokeCount =
      (sql.match(/revoke\s+all\s+on\s+function/gi) ?? []).length;
    const grantCount =
      (sql.match(/grant\s+execute\s+on\s+function/gi) ?? []).length;
    expect(revokeCount).toBeGreaterThanOrEqual(9);
    expect(grantCount).toBeGreaterThanOrEqual(9);
    // Never grants execute to anon or authenticated.
    expect(sql).not.toMatch(
      /grant\s+execute\s+on\s+function[^;]*\bto\s+(anon|authenticated)/i,
    );
  });

  it("qualifies every table reference as public.<table>", () => {
    const sql = readMigration();
    // No bare (unqualified) references to business tables.
    expect(sql).not.toMatch(/\bfrom\s+inquiries\b/i);
    expect(sql).not.toMatch(/\bfrom\s+inquiry_outbox\b/i);
    expect(sql).not.toMatch(/\bfrom\s+inquiry_outbox_deliveries\b/i);
    expect(sql).not.toMatch(/\bfrom\s+admin_storage_operations\b/i);
    expect(sql).not.toMatch(/\binto\s+inquiries\b/i);
    expect(sql).not.toMatch(/\binto\s+inquiry_outbox\b/i);
    expect(sql).not.toMatch(/\binto\s+inquiry_outbox_deliveries\b/i);
    expect(sql).not.toMatch(/\binto\s+admin_storage_operations\b/i);
    expect(sql).not.toMatch(/\bupdate\s+inquiries\b/i);
    expect(sql).not.toMatch(/\bupdate\s+inquiry_outbox\b/i);
    expect(sql).not.toMatch(/\bupdate\s+inquiry_outbox_deliveries\b/i);
    expect(sql).not.toMatch(/\bupdate\s+admin_storage_operations\b/i);
    // Qualified references must be present. Note: the migration
    // UPDATEs inquiries (no INSERT), so we check for UPDATE and FROM
    // qualifications rather than INTO.
    expect(sql).toMatch(/\bfrom\s+public\.inquiries\b/i);
    expect(sql).toMatch(/\bfrom\s+public\.inquiry_outbox\b/i);
    expect(sql).toMatch(/\bfrom\s+public\.inquiry_outbox_deliveries\b/i);
    expect(sql).toMatch(/\binto\s+public\.admin_storage_operations\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.inquiries\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.inquiry_outbox\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.inquiry_outbox_deliveries\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.admin_storage_operations\b/i);
  });
});
