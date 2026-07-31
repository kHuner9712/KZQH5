import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Phase 4 Task 6: Two-phase upload migration safety tests
//
// Verifies that the temp_uploads migration:
//   1. Is forward-only (no DROP TABLE, TRUNCATE, DELETE at top level)
//   2. Enables RLS on temp_uploads
//   3. Has NO policies for anon/authenticated/public
//   4. Grants EXECUTE on all RPCs to service_role ONLY
//   5. Revokes EXECUTE from public/anon/authenticated
//   6. All RPCs use SECURITY INVOKER
//   7. All RPCs use SET search_path = ''
//   8. Status CHECK constraint includes all 5 states
//   9. Temp object path format is temp/{token}/{filename}
// ============================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260729020000_temp_uploads_two_phase_upload.sql",
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

describe("Phase 4: temp_uploads migration safety", () => {
  let sql: string;

  beforeEach(() => {
    sql = readMigration();
  });

  // ============================================================
  // 1. Forward-only — no destructive top-level operations
  // ============================================================

  /**
   * Strip SQL line comments (-- ...) so that destructive keywords
   * mentioned in documentation comments (e.g. "does NOT truncate")
   * do not trigger false positives. Block comments (/* *\/) are rare
   * in this migration and not handled — the migration uses -- style.
   */
  function stripLineComments(input: string): string {
    return input
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("--")) return "";
        return line;
      })
      .join("\n");
  }

  describe("forward-only (no destructive operations)", () => {
    it("does NOT contain DROP TABLE", () => {
      // drop policy / drop trigger / drop function are allowed (idempotent cleanup)
      // but DROP TABLE is destructive. Strip comments so that the
      // header docblock ("does NOT drop any table") doesn't match.
      expect(stripLineComments(sql)).not.toMatch(/drop\s+table/i);
    });

    it("does NOT contain TRUNCATE", () => {
      // Strip comments so the header docblock ("does NOT truncate any
      // table") doesn't trigger a false positive.
      expect(stripLineComments(sql)).not.toMatch(/truncate/i);
    });

    it("does NOT contain DELETE FROM at the top level", () => {
      // DELETE inside RPC functions is OK, but not at the migration top level
      // Check that there's no bare DELETE (not inside a function body)
      const lines = sql.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip comment lines
        if (trimmed.startsWith("--")) continue;
        // DELETE inside $$ ... $$ blocks is inside functions — allowed
        // We check for bare DELETE not preceded by function context
        if (/^delete\s+from/i.test(trimmed)) {
          // This is a top-level DELETE — not allowed
          expect.fail(`Top-level DELETE found: ${trimmed}`);
        }
      }
    });

    it("does NOT modify existing tables (only CREATE TABLE IF NOT EXISTS)", () => {
      // ALTER TABLE on temp_uploads is allowed (it's the new table)
      // but ALTER TABLE on other tables is not. Strip comments to
      // avoid matching docblock mentions of ALTER TABLE.
      expect(stripLineComments(sql)).not.toMatch(/alter\s+table\s+(?!public\.temp_uploads)/i);
    });
  });

  // ============================================================
  // 2. RLS enabled
  // ============================================================
  describe("RLS enabled", () => {
    it("enables row level security on temp_uploads", () => {
      expect(sql).toMatch(/alter\s+table\s+public\.temp_uploads\s+enable\s+row\s+level\s+security/i);
    });

    it("does NOT create policies for anon/authenticated/public", () => {
      // The migration should drop any legacy policies and create NONE
      // This means: no "create policy" for temp_uploads
      expect(sql).not.toMatch(/create\s+policy[^;]*temp_uploads/i);
    });
  });

  // ============================================================
  // 3. Grants — service_role only
  // ============================================================
  describe("grants — service_role only", () => {
    it("revokes all from public, anon, authenticated on temp_uploads", () => {
      expect(sql).toMatch(
        /revoke\s+all\s+on\s+public\.temp_uploads\s+from\s+public,\s*anon,\s*authenticated/i,
      );
    });

    it("grants select, insert, update, delete to service_role on temp_uploads", () => {
      expect(sql).toMatch(/grant\s+select\s+on\s+public\.temp_uploads\s+to\s+service_role/i);
      expect(sql).toMatch(/grant\s+insert,\s*update,\s*delete\s+on\s+public\.temp_uploads\s+to\s+service_role/i);
    });

    it("revokes EXECUTE on all RPCs from public, anon, authenticated", () => {
      const rpcs = [
        "authorize_temp_upload",
        "claim_temp_upload_for_finalize",
        "complete_temp_upload_finalize",
        "fail_temp_upload_finalize",
        "recover_stale_temp_uploads",
        "reap_expired_temp_uploads",
      ];
      for (const rpc of rpcs) {
        // Migration formats GRANT/REVOKE across multiple lines with the
        // function signature between the RPC name and FROM/TO:
        //   revoke all on function public.<rpc>(<signature>)
        //     from public, anon, authenticated;
        // \s matches newlines, so we just need to allow the signature.
        expect(sql).toMatch(
          new RegExp(
            `revoke\\s+all\\s+on\\s+function\\s+public\\.${rpc}\\([^)]*\\)\\s+from\\s+public,\\s*anon,\\s*authenticated`,
            "i",
          ),
        );
      }
    });

    it("grants EXECUTE on all RPCs to service_role ONLY", () => {
      const rpcs = [
        "authorize_temp_upload",
        "claim_temp_upload_for_finalize",
        "complete_temp_upload_finalize",
        "fail_temp_upload_finalize",
        "recover_stale_temp_uploads",
        "reap_expired_temp_uploads",
      ];
      for (const rpc of rpcs) {
        expect(sql).toMatch(
          new RegExp(
            `grant\\s+execute\\s+on\\s+function\\s+public\\.${rpc}\\([^)]*\\)\\s+to\\s+service_role`,
            "i",
          ),
        );
        // Must NOT grant to anon or authenticated
        expect(sql).not.toMatch(
          new RegExp(
            `grant\\s+execute\\s+on\\s+function\\s+public\\.${rpc}\\([^)]*\\)\\s+to\\s+anon`,
            "i",
          ),
        );
        expect(sql).not.toMatch(
          new RegExp(
            `grant\\s+execute\\s+on\\s+function\\s+public\\.${rpc}\\([^)]*\\)\\s+to\\s+authenticated`,
            "i",
          ),
        );
      }
    });
  });

  // ============================================================
  // 4. RPC security — SECURITY INVOKER + empty search_path
  // ============================================================
  describe("RPC security — SECURITY INVOKER + empty search_path", () => {
    it("all RPCs use SECURITY INVOKER", () => {
      const rpcs = [
        "authorize_temp_upload",
        "claim_temp_upload_for_finalize",
        "complete_temp_upload_finalize",
        "fail_temp_upload_finalize",
        "recover_stale_temp_uploads",
        "reap_expired_temp_uploads",
      ];
      for (const rpc of rpcs) {
        // Find the function definition and check it has security invoker
        const funcPattern = new RegExp(
          `create\\s+or\\s+replace\\s+function\\s+public\\.${rpc}[\\s\\S]*?language\\s+plpgsql\\s+security\\s+invoker`,
          "i",
        );
        expect(sql).toMatch(funcPattern);
      }
    });

    it("all RPCs use SET search_path = ''", () => {
      const rpcs = [
        "authorize_temp_upload",
        "claim_temp_upload_for_finalize",
        "complete_temp_upload_finalize",
        "fail_temp_upload_finalize",
        "recover_stale_temp_uploads",
        "reap_expired_temp_uploads",
      ];
      for (const rpc of rpcs) {
        const funcPattern = new RegExp(
          `create\\s+or\\s+replace\\s+function\\s+public\\.${rpc}[\\s\\S]*?set\\s+search_path\\s*=\\s*''`,
          "i",
        );
        expect(sql).toMatch(funcPattern);
      }
    });
  });

  // ============================================================
  // 5. Status CHECK constraint
  // ============================================================
  describe("status CHECK constraint", () => {
    it("includes all 5 lifecycle states", () => {
      expect(sql).toMatch(/'authorized'/);
      expect(sql).toMatch(/'finalizing'/);
      expect(sql).toMatch(/'finalized'/);
      expect(sql).toMatch(/'failed'/);
      expect(sql).toMatch(/'rejected'/);
    });
  });

  // ============================================================
  // 6. Temp object path format
  // ============================================================
  describe("temp object path format", () => {
    it("constructs path as temp/{token}/{filename}", () => {
      expect(sql).toMatch(/temp\/.*\|\|.*token.*\|\|.*filename/i);
    });
  });

  // ============================================================
  // 7. Claim RPC uses FOR UPDATE SKIP LOCKED
  // ============================================================
  describe("claim RPC concurrency safety", () => {
    it("claim_temp_upload_for_finalize uses FOR UPDATE SKIP LOCKED", () => {
      expect(sql).toMatch(/for\s+update\s+skip\s+locked/i);
    });
  });

  // ============================================================
  // 8. Idempotency
  // ============================================================
  describe("idempotency", () => {
    it("complete_temp_upload_finalize handles already-finalized idempotently", () => {
      expect(sql).toMatch(/already_finalized/i);
    });

    it("fail_temp_upload_finalize handles already-terminal idempotently", () => {
      expect(sql).toMatch(/already_terminal/i);
    });
  });

  // ============================================================
  // 9. Expiry handling
  // ============================================================
  describe("expiry handling", () => {
    it("expires_at defaults to NOW() + 5 minutes", () => {
      expect(sql).toMatch(/interval\s+'5\s+minutes'/i);
    });

    it("claim RPC rejects expired tokens", () => {
      expect(sql).toMatch(/expires_at\s*<=\s*now\(\)/i);
    });
  });

  // ============================================================
  // 10. Manifest registration
  // ============================================================
  describe("manifest registration", () => {
    it("migration is registered in the SHA-256 manifest", () => {
      const manifest = readFileSync(
        join(process.cwd(), "docs", "MIGRATION_SHA256_MANIFEST.txt"),
        "utf8",
      );
      expect(manifest).toContain("20260729020000_temp_uploads_two_phase_upload.sql");
    });
  });
});

// ============================================================
// KZQ-P0-003: Migration 20260731020000_bind_temp_upload_actor.sql
// ------------------------------------------------------------
// Verifies the actor-binding migration:
//   1. Drops the old claim_temp_upload_for_finalize(uuid) signature
//   2. Creates the new claim_temp_upload_for_finalize(uuid, text)
//   3. New function verifies p_actor_id against row.actor_id
//   4. SECURITY INVOKER + empty search_path
//   5. GRANT EXECUTE to service_role ONLY
//   6. REVOKE from public/anon/authenticated
//   7. Does NOT drop tables, truncate, or modify existing data
//   8. Registered in the SHA-256 manifest
// ============================================================

const ACTOR_MIGRATION_PATH = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260731020000_bind_temp_upload_actor.sql",
);

function readActorMigration(): string {
  return readFileSync(ACTOR_MIGRATION_PATH, "utf8");
}

describe("KZQ-P0-003: bind_temp_upload_actor migration safety", () => {
  let actorSql: string;

  beforeEach(() => {
    actorSql = readActorMigration();
  });

  function stripLineComments(input: string): string {
    return input
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("--")) return "";
        return line;
      })
      .join("\n");
  }

  describe("forward-only (no destructive operations)", () => {
    it("does NOT contain DROP TABLE", () => {
      expect(stripLineComments(actorSql)).not.toMatch(/drop\s+table/i);
    });

    it("does NOT contain TRUNCATE", () => {
      expect(stripLineComments(actorSql)).not.toMatch(/truncate/i);
    });

    it("does NOT contain DELETE FROM at the top level", () => {
      const lines = actorSql.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("--")) continue;
        if (/^delete\s+from/i.test(trimmed)) {
          expect.fail(`Top-level DELETE found: ${trimmed}`);
        }
      }
    });

    it("does NOT modify existing tables (no ALTER TABLE)", () => {
      expect(stripLineComments(actorSql)).not.toMatch(/alter\s+table/i);
    });
  });

  describe("signature change", () => {
    it("drops the old claim_temp_upload_for_finalize(uuid) signature", () => {
      expect(actorSql).toMatch(
        /drop\s+function\s+if\s+exists\s+public\.claim_temp_upload_for_finalize\s*\(\s*p_token\s+uuid\s*\)/i,
      );
    });

    it("creates the new claim_temp_upload_for_finalize(uuid, text) signature", () => {
      expect(actorSql).toMatch(
        /create\s+or\s+replace\s+function\s+public\.claim_temp_upload_for_finalize\s*\(\s*p_token\s+uuid,\s*p_actor_id\s+text\s*\)/i,
      );
    });
  });

  describe("actor_id verification logic", () => {
    it("rejects null p_actor_id with invalid_actor", () => {
      expect(actorSql).toMatch(/invalid_actor/i);
    });

    it("rejects null row.actor_id with actor_not_bound", () => {
      expect(actorSql).toMatch(/actor_not_bound/i);
    });

    it("rejects mismatched actor_id with actor_mismatch", () => {
      expect(actorSql).toMatch(/actor_mismatch/i);
    });

    it("compares row.actor_id against p_actor_id", () => {
      expect(actorSql).toMatch(/v_row\.actor_id\s*!=\s*p_actor_id/i);
    });
  });

  describe("RPC security — SECURITY INVOKER + empty search_path", () => {
    it("new function uses SECURITY INVOKER", () => {
      expect(actorSql).toMatch(
        /create\s+or\s+replace\s+function\s+public\.claim_temp_upload_for_finalize[\s\S]*?language\s+plpgsql\s+security\s+invoker/i,
      );
    });

    it("new function uses SET search_path = ''", () => {
      expect(actorSql).toMatch(
        /create\s+or\s+replace\s+function\s+public\.claim_temp_upload_for_finalize[\s\S]*?set\s+search_path\s*=\s*''/i,
      );
    });
  });

  describe("grants — service_role only", () => {
    it("revokes EXECUTE on new function from public, anon, authenticated", () => {
      expect(actorSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.claim_temp_upload_for_finalize\s*\(\s*uuid,\s*text\s*\)\s+from\s+public,\s*anon,\s*authenticated/i,
      );
    });

    it("grants EXECUTE on new function to service_role ONLY", () => {
      expect(actorSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.claim_temp_upload_for_finalize\s*\(\s*uuid,\s*text\s*\)\s+to\s+service_role/i,
      );
      expect(actorSql).not.toMatch(
        /grant\s+execute\s+on\s+function\s+public\.claim_temp_upload_for_finalize\s*\(\s*uuid,\s*text\s*\)\s+to\s+anon/i,
      );
      expect(actorSql).not.toMatch(
        /grant\s+execute\s+on\s+function\s+public\.claim_temp_upload_for_finalize\s*\(\s*uuid,\s*text\s*\)\s+to\s+authenticated/i,
      );
    });
  });

  describe("manifest registration", () => {
    it("migration is registered in the SHA-256 manifest", () => {
      const manifest = readFileSync(
        join(process.cwd(), "docs", "MIGRATION_SHA256_MANIFEST.txt"),
        "utf8",
      );
      expect(manifest).toContain("20260731020000_bind_temp_upload_actor.sql");
    });
  });
});
