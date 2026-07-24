import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260724150000_inquiry_idempotency_and_outbox.sql",
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf-8");
}

describe("20260724150000_inquiry_idempotency_and_outbox.sql (Phase 5 static safety)", () => {
  it("adds client_submission_id as a nullable uuid column with a partial unique index", () => {
    const sql = readMigration();
    // Column is added with if not exists and is nullable (no NOT NULL).
    expect(sql).toMatch(
      /alter\s+table\s+public\.inquiries\s+add\s+column\s+if\s+not\s+exists\s+client_submission_id\s+uuid/i,
    );
    // NOT NULL is forbidden — historical inquiries must remain NULL-compatible.
    expect(sql).not.toMatch(
      /client_submission_id\s+uuid\s+not\s+null/i,
    );
    // Partial unique index only where client_submission_id IS NOT NULL.
    expect(sql).toMatch(
      /create\s+unique\s+index\s+if\s+not\s+exists\s+inquiries_client_submission_id_unique\s+on\s+public\.inquiries\(client_submission_id\)\s+where\s+client_submission_id\s+is\s+not\s+null/i,
    );
  });

  it("creates the inquiry_outbox table with the required safety columns", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.inquiry_outbox/i,
    );
    // Required columns for retry / dead-letter handling.
    expect(sql).toMatch(/inquiry_id\s+uuid\s+not\s+null\s+references\s+public\.inquiries\(id\)\s+on\s+delete\s+cascade/i);
    expect(sql).toMatch(/status\s+text\s+not\s+null\s+default\s+'pending'/i);
    expect(sql).toMatch(/attempts\s+integer\s+not\s+null\s+default\s+0/i);
    expect(sql).toMatch(/max_attempts\s+integer\s+not\s+null\s+default\s+5/i);
    expect(sql).toMatch(/next_retry_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
    // RLS enabled.
    expect(sql).toMatch(
      /alter\s+table\s+public\.inquiry_outbox\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("revokes inquiry_outbox from public/anon/authenticated and grants only service_role", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+table\s+public\.inquiry_outbox\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /grant\s+all\s+on\s+table\s+public\.inquiry_outbox\s+to\s+service_role/i,
    );
    // Never grant to anon or authenticated.
    expect(sql).not.toMatch(
      /grant\s+all\s+on\s+table\s+public\.inquiry_outbox\s+to\s+(anon|authenticated)/i,
    );
  });

  it("declares all RPCs as security invoker with empty search_path", () => {
    const sql = readMigration();
    const fnBlocks =
      sql.match(/create\s+(or\s+replace\s+)?function\s+public\.\w+[\s\S]+?\$\$;/gi) ?? [];
    // create_inquiry_with_items, claim_inquiry_outbox_batch,
    // mark_inquiry_outbox_sent, fail_inquiry_outbox_event -> 4 functions.
    expect(fnBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of fnBlocks) {
      expect(block).toMatch(/security\s+invoker/i);
      expect(block).toMatch(/set\s+search_path\s*=\s*''/i);
    }
  });

  it("qualifies every table reference as public.<table>", () => {
    const sql = readMigration();
    // No bare (unqualified) references to business tables.
    expect(sql).not.toMatch(/\bfrom\s+inquiries\b/i);
    expect(sql).not.toMatch(/\bfrom\s+inquiry_outbox\b/i);
    expect(sql).not.toMatch(/\bfrom\s+inquiry_items\b/i);
    expect(sql).not.toMatch(/\binto\s+inquiries\b/i);
    expect(sql).not.toMatch(/\binto\s+inquiry_outbox\b/i);
    expect(sql).not.toMatch(/\binto\s+inquiry_items\b/i);
    expect(sql).not.toMatch(/\bupdate\s+inquiries\b/i);
    expect(sql).not.toMatch(/\bupdate\s+inquiry_outbox\b/i);
    // Qualified references must be present.
    expect(sql).toMatch(/\bfrom\s+public\.inquiries\b/i);
    expect(sql).toMatch(/\binto\s+public\.inquiries\b/i);
    expect(sql).toMatch(/\binto\s+public\.inquiry_items\b/i);
    expect(sql).toMatch(/\binto\s+public\.inquiry_outbox\b/i);
    expect(sql).toMatch(/\bupdate\s+public\.inquiry_outbox\b/i);
  });

  it("revokes all RPCs from public/anon/authenticated and grants only service_role", () => {
    const sql = readMigration();
    // 4 functions -> at least 4 revoke + 4 grant blocks.
    const revokeCount = (sql.match(/revoke\s+all\s+on\s+function/gi) ?? []).length;
    const grantCount = (sql.match(/grant\s+execute\s+on\s+function/gi) ?? []).length;
    expect(revokeCount).toBeGreaterThanOrEqual(4);
    expect(grantCount).toBeGreaterThanOrEqual(4);
    expect(sql).toMatch(/revoke\s+all[\s\S]+?from\s+public,\s*anon,\s*authenticated/gi);
    expect(sql).toMatch(/grant\s+execute[\s\S]+?to\s+service_role/gi);
    // Never grant execute to anon or authenticated.
    expect(sql).not.toMatch(/grant\s+execute[\s\S]+?to\s+(anon|authenticated)/gi);
  });

  it("drops and recreates create_inquiry_with_items with the new signature", () => {
    const sql = readMigration();
    // The old 2-arg signature must be dropped before creating the 3-arg one.
    expect(sql).toMatch(
      /drop\s+function\s+if\s+exists\s+public\.create_inquiry_with_items\(jsonb,\s*jsonb\)/i,
    );
    // New function must accept p_client_submission_id.
    expect(sql).toMatch(
      /create\s+function\s+public\.create_inquiry_with_items\([\s\S]+?p_client_submission_id\s+uuid\s+default\s+null/i,
    );
  });

  it("implements idempotency: returns existing row when client_submission_id matches", () => {
    const sql = readMigration();
    // Must SELECT ... WHERE client_submission_id = p_client_submission_id
    // and return the existing row when found.
    expect(sql).toMatch(
      /select\s+\*\s+into\s+v_existing\s+from\s+public\.inquiries\s+where\s+client_submission_id\s*=\s*p_client_submission_id/i,
    );
    expect(sql).toMatch(/if\s+found\s+then/i);
    expect(sql).toMatch(/'idempotent',\s*true/i);
  });

  it("writes the outbox event in the same function body as the inquiry insert", () => {
    const sql = readMigration();
    const fnBlock =
      sql.match(
        /create\s+function\s+public\.create_inquiry_with_items[\s\S]+?\$\$;/i,
      )?.[0] ?? "";
    // The function body must contain both the inquiry INSERT and the outbox
    // INSERT — proving they share the same transaction.
    expect(fnBlock).toMatch(/insert\s+into\s+public\.inquiries/i);
    expect(fnBlock).toMatch(/insert\s+into\s+public\.inquiry_items/i);
    expect(fnBlock).toMatch(/insert\s+into\s+public\.inquiry_outbox/i);
  });

  it("does not contain dynamic SQL (EXECUTE / format with %s)", () => {
    const sql = readMigration();
    expect(sql).not.toMatch(/\bexecute\s+'/i);
    expect(sql).not.toMatch(/\bformat\s*\(/i);
  });

  it("does not perform SELECT * INTO on business tables for data exfiltration", () => {
    const sql = readMigration();
    // SELECT * INTO v_existing is allowed ONLY for the idempotency lookup
    // against public.inquiries (single row by client_submission_id).
    expect(sql).toMatch(
      /select\s+\*\s+into\s+v_existing\s+from\s+public\.inquiries\s+where\s+client_submission_id/i,
    );
    // No other SELECT * INTO that could leak data.
    const allSelectStarInto =
      sql.match(/select\s+\*\s+into\s+\w+\s+from\s+public\.\w+/gi) ?? [];
    expect(allSelectStarInto.length).toBe(1);
  });

  it("uses FOR UPDATE SKIP LOCKED in the claim function for multi-instance safety", () => {
    const sql = readMigration();
    const claimFn =
      sql.match(
        /create\s+or\s+replace\s+function\s+public\.claim_inquiry_outbox_batch[\s\S]+?\$\$;/i,
      )?.[0] ?? "";
    expect(claimFn).toMatch(/for\s+update\s+skip\s+locked/i);
  });

  it("implements exponential backoff and dead-letter in fail_inquiry_outbox_event", () => {
    const sql = readMigration();
    const failFn =
      sql.match(
        /create\s+or\s+replace\s+function\s+public\.fail_inquiry_outbox_event[\s\S]+?\$\$;/i,
      )?.[0] ?? "";
    expect(failFn).toMatch(/dead_letter/i);
    expect(failFn).toMatch(/retry/i);
    // Exponential backoff via power(2, v_attempts - 1).
    expect(failFn).toMatch(/power\s*\(\s*2\s*,/i);
    // Capped at 30 minutes.
    expect(failFn).toMatch(/interval\s+'30\s+minutes'/i);
  });
});
