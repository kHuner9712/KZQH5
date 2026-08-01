import { beforeEach, describe, expect, it } from "vitest";

// ============================================================
// KZQ-P1-011-b: distributed rate-limit migration safety tests
//
// Verifies that migration 20260801000000_distributed_rate_limit_rpc.sql:
//   1. Is forward-only (no DROP TABLE, TRUNCATE, top-level DELETE,
//      no ALTER TABLE on pre-existing tables)
//   2. Enables RLS on rate_limit_counters
//   3. Creates NO policies for anon/authenticated/public
//   4. Revokes ALL table access from public/anon/authenticated
//   5. Grants EXECUTE on both RPCs to service_role ONLY
//   6. Revokes EXECUTE from public/anon/authenticated
//   7. Both RPCs use SECURITY INVOKER + SET search_path = ''
//   8. RPC input validation returns fixed error codes (no SQL detail)
//   9. Fixed-window semantics + atomic increment (ON CONFLICT DO UPDATE)
// ============================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260801000000_distributed_rate_limit_rpc.sql",
);

const TABLE = "public\\.rate_limit_counters";
const CHECK_FN = "public\\.rate_limit_check";
const CLEANUP_FN = "public\\.rate_limit_cleanup_expired";

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

/**
 * Strip SQL line comments (-- ...) so that destructive keywords
 * mentioned in documentation comments (e.g. "Drop the two functions
 * and the table") do not trigger false positives.
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

describe("KZQ-P1-011-b: distributed rate-limit migration safety", () => {
  let sql: string;

  beforeEach(() => {
    sql = readMigration();
  });

  // ============================================================
  // 1. Forward-only — no destructive top-level operations
  // ============================================================
  describe("forward-only (no destructive operations)", () => {
    it("does NOT contain DROP TABLE", () => {
      expect(stripLineComments(sql)).not.toMatch(/drop\s+table/i);
    });

    it("does NOT contain TRUNCATE", () => {
      expect(stripLineComments(sql)).not.toMatch(/truncate/i);
    });

    it("does NOT contain top-level DELETE FROM", () => {
      // DELETE inside $$ ... $$ function bodies is allowed (the cleanup
      // RPC deletes expired counters); only a bare top-level DELETE is
      // forbidden. Track dollar-quote state to skip function bodies.
      let inFunctionBody = false;
      for (const line of sql.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("--")) continue;
        if (/^as\s+\$\$$/i.test(trimmed)) {
          inFunctionBody = true;
          continue;
        }
        if (/^\$\$;?\s*$/.test(trimmed)) {
          inFunctionBody = false;
          continue;
        }
        if (inFunctionBody) continue;
        if (/^delete\s+from/i.test(trimmed)) {
          expect.fail(`Top-level DELETE found: ${trimmed}`);
        }
      }
    });

    it("does NOT modify pre-existing tables (only rate_limit_counters)", () => {
      // ALTER TABLE on rate_limit_counters is allowed (it's the new
      // table); ALTER TABLE on any other table is not.
      expect(stripLineComments(sql)).not.toMatch(
        new RegExp(`alter\\s+table\\s+(?!${TABLE})`, "i"),
      );
    });
  });

  // ============================================================
  // 2. RLS enabled, no public policies
  // ============================================================
  describe("RLS enabled", () => {
    it("enables row level security on rate_limit_counters", () => {
      expect(sql).toMatch(
        new RegExp(`alter\\s+table\\s+${TABLE}\\s+enable\\s+row\\s+level\\s+security`, "i"),
      );
    });

    it("creates NO policies for the table", () => {
      expect(sql).not.toMatch(
        new RegExp(`create\\s+policy[^;]*rate_limit_counters`, "i"),
      );
    });

    it("revokes ALL table access from public, anon, authenticated", () => {
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+${TABLE}\\s+from\\s+public,\\s*anon,\\s*authenticated`, "i"),
      );
    });

    it("grants NO direct table access to anon/authenticated/public", () => {
      expect(sql).not.toMatch(
        new RegExp(`grant[^;]*on\\s+${TABLE}[^;]*(to\\s+anon|to\\s+authenticated|to\\s+public)`, "i"),
      );
    });
  });

  // ============================================================
  // 3. RPC security posture
  // ============================================================
  describe("RPC security posture", () => {
    it("rate_limit_check is SECURITY INVOKER with empty search_path", () => {
      expect(sql).toMatch(
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+${CHECK_FN}\\s*\\([^)]*\\)[\\s\\S]*?security\\s+invoker[\\s\\S]*?set\\s+search_path\\s*=\\s*''`, "i"),
      );
    });

    it("rate_limit_cleanup_expired is SECURITY INVOKER with empty search_path", () => {
      expect(sql).toMatch(
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+${CLEANUP_FN}\\s*\\([^)]*\\)[\\s\\S]*?security\\s+invoker[\\s\\S]*?set\\s+search_path\\s*=\\s*''`, "i"),
      );
    });

    it("revokes EXECUTE on rate_limit_check from public, anon, authenticated", () => {
      // Must account for the function signature in parentheses between
      // the RPC name and the FROM keyword.
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${CHECK_FN}\\([^)]*\\)\\s+from\\s+public,\\s*anon,\\s*authenticated`, "i"),
      );
    });

    it("revokes EXECUTE on rate_limit_cleanup_expired from public, anon, authenticated", () => {
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${CLEANUP_FN}\\([^)]*\\)\\s+from\\s+public,\\s*anon,\\s*authenticated`, "i"),
      );
    });

    it("grants EXECUTE on rate_limit_check to service_role ONLY", () => {
      expect(sql).toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${CHECK_FN}\\([^)]*\\)\\s+to\\s+service_role`, "i"),
      );
    });

    it("grants EXECUTE on rate_limit_cleanup_expired to service_role ONLY", () => {
      expect(sql).toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${CLEANUP_FN}\\([^)]*\\)\\s+to\\s+service_role`, "i"),
      );
    });

    it("grants EXECUTE to NEITHER anon NOR authenticated NOR public", () => {
      expect(sql).not.toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+(?:${CHECK_FN}|${CLEANUP_FN})\\([^)]*\\)\\s+to\\s+(?:anon|authenticated|public)\\b`, "i"),
      );
    });
  });

  // ============================================================
  // 4. Semantics: fixed window + atomic increment + fixed errors
  // ============================================================
  describe("fixed-window atomic semantics", () => {
    it("computes the fixed-window boundary from floor(epoch / window) * window", () => {
      expect(sql).toMatch(
        /floor\s*\(\s*v_now_epoch\s*\/\s*p_window_seconds\s*\)\s*\*\s*p_window_seconds/i,
      );
    });

    it("derives the window epoch from clock_timestamp()", () => {
      expect(sql).toMatch(
        /floor\s*\(\s*extract\s*\(\s*epoch\s*from\s*clock_timestamp\s*\(\s*\)\s*\)\s*\)/i,
      );
    });

    it("increments atomically via INSERT ... ON CONFLICT DO UPDATE", () => {
      expect(sql).toMatch(/insert\s+into\s+public\.rate_limit_counters/i);
      expect(sql).toMatch(/on\s+conflict\s*\([^)]*\)[\s\S]*?do\s+update\s+set\s+count\s*=/i);
    });

    it("returns fixed error codes (no SQL detail leakage)", () => {
      for (const code of [
        "invalid_bucket",
        "invalid_key",
        "invalid_max_count",
        "invalid_window_seconds",
        "invalid_older_than_seconds",
      ]) {
        expect(sql).toContain(code);
      }
    });

    it("returns the documented JSONB contract keys", () => {
      expect(sql).toContain("retry_after_seconds");
      expect(sql).toContain("remaining");
      expect(sql).toContain("allowed");
    });
  });
});
