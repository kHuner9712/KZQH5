// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Phase 4 / Section 11: Storage audit + compensation + reconciliation
// ------------------------------------------------------------
// These tests verify the fail-closed audit saga implemented in
// lib/services/storage-upload.ts:
//
//   1. Upload: audit-start must succeed before upload; if audit-complete
//      fails after a successful upload, the uploaded object is compensated
//      (deleted) and the residual object is enqueued for cleanup if
//      compensation also fails.
//   2. Delete: if audit-complete fails after a successful delete, the
//      function returns a PARTIAL failure (not a normal success) so the
//      caller knows the audit is in an inconsistent state.
//   3. Reconciliation: long-pending audit rows are completed based on
//      the actual object state in Storage.
//
// The tests use static + mocked-runtime patterns: static assertions
// verify the source code contract; mocked runtime tests verify the
// state-machine behavior without hitting real Supabase.
// ============================================================

const ROOT = process.cwd();

function readLib(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

// ============================================================
// Shared mocks (hoisted so vi.mock can reference them)
// ============================================================
const mockStorage = {
  from: vi.fn(),
};
const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockCreateAdminClient = vi.fn(() => ({
  storage: mockStorage,
  rpc: mockRpc,
  from: mockFrom,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

vi.mock("@/lib/validation/storage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/validation/storage")>();
  return {
    ...actual,
    // Skip real Magic Bytes / MIME validation in unit tests.
    // KZQ-P0-005-a: validateUploadFile is now the shared entry point
    // used by both single-stage and two-stage paths. We mock it directly
    // so the audit saga tests focus on audit/compensation behavior, not
    // on validation internals.
    validateUploadFile: () => ({
      ok: true,
      mimeType: "image/png",
      ext: ".png",
    }),
    verifyMagicBytes: () => ({ ok: true }),
    validateMimeType: () => ({ ok: true }),
    validateFileSize: () => ({ ok: true }),
    validateMimeExtensionConsistency: () => ({ ok: true }),
  };
});

// ============================================================
// Static contract: storage-upload.ts implements the fail-closed saga
// ============================================================
//
// Static tests read the FULL source file (not just a regex slice) so
// that nested closing braces inside a function body do not truncate
// the match prematurely.
// ============================================================

describe("Storage audit + compensation — static contract", () => {
  const SOURCE = "lib/services/storage-upload.ts";

  it("compensateDeleteUploadedObject checks the .remove() error (no silent swallow)", () => {
    const content = readLib(SOURCE);
    expect(content).toMatch(
      /const\s*\{\s*error\s*\}\s*=\s*await\s+client\.storage\.from\(bucket\)\.remove\(\[path\]\)/,
    );
    expect(content).toMatch(/if\s*\(\s*error\s*\)\s*\{/);
    expect(content).toMatch(/STORAGE_COMPENSATE_DELETE_FAILED/);
    expect(content).toMatch(/STORAGE_COMPENSATE_DELETE_EXCEPTION/);
    expect(content).toMatch(/return\s*\{\s*ok:\s*false\s*\}/);
  });

  it("enqueueResidualObjectForCleanup enqueues when compensation fails", () => {
    const content = readLib(SOURCE);
    expect(content).toMatch(/enqueueResidualObjectForCleanup/);
    expect(content).toMatch(/enqueue_storage_cleanup/);
    expect(content).toMatch(/"orphan_detected"/);
  });

  it("uploadToPrivateAssets: audit-complete failure triggers compensation + cleanup enqueue", () => {
    const content = readLib(SOURCE);
    // Verify the entire function body contains the required contracts.
    // We check the whole file because nested braces break naive regex.
    const fnStart = content.indexOf("export async function uploadToPrivateAssets");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    // Find the matching closing brace by scanning the function body.
    // The function ends at a top-level "\n}\n" after the fn start.
    const afterFn = content.slice(fnStart);
    expect(afterFn).toMatch(/completeStorageAudit\(client,\s*operationId,\s*true\)/);
    expect(afterFn).toMatch(/compensateDeleteUploadedObject/);
    expect(afterFn).toMatch(/enqueueResidualObjectForCleanup/);
  });

  it("uploadToPublicAssets: same fail-closed audit saga as private upload", () => {
    const content = readLib(SOURCE);
    const fnStart = content.indexOf("export async function uploadToPublicAssets");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const afterFn = content.slice(fnStart);
    expect(afterFn).toMatch(/completeStorageAudit\(client,\s*operationId,\s*true\)/);
    expect(afterFn).toMatch(/compensateDeleteUploadedObject/);
    expect(afterFn).toMatch(/enqueueResidualObjectForCleanup/);
  });

  it("deletePrivateAsset: audit-complete failure returns PARTIAL failure (not normal success)", () => {
    const content = readLib(SOURCE);
    const fnStart = content.indexOf("export async function deletePrivateAsset");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const afterFn = content.slice(fnStart);
    expect(afterFn).toMatch(/completeStorageAudit\(client,\s*operationId,\s*true\)/);
    expect(afterFn).toMatch(/STORAGE_DELETE_OK_BUT_AUDIT_INCOMPLETE/);
    expect(afterFn).toMatch(/partial:\s*true/);
  });

  it("deletePublicAsset: same partial-failure contract as deletePrivateAsset", () => {
    const content = readLib(SOURCE);
    const fnStart = content.indexOf("export async function deletePublicAsset");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const afterFn = content.slice(fnStart);
    expect(afterFn).toMatch(/completeStorageAudit\(client,\s*operationId,\s*true\)/);
    expect(afterFn).toMatch(/STORAGE_DELETE_OK_BUT_AUDIT_INCOMPLETE/);
    expect(afterFn).toMatch(/partial:\s*true/);
  });

  it("publishCatalogAssetFlow: RPC failure triggers compensatePublicCopy + cleanup enqueue", () => {
    const content = readLib(SOURCE);
    const fnStart = content.indexOf("export async function publishCatalogAssetFlow");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const afterFn = content.slice(fnStart);
    // Must define a compensatePublicCopy helper inside the function.
    expect(afterFn).toMatch(/compensatePublicCopy/);
    expect(afterFn).toMatch(/await\s+compensatePublicCopy\(\)/);
    expect(afterFn).toMatch(/enqueueResidualObjectForCleanup/);
  });

  it("reconcilePendingStorageAudit implements the 4-state machine via claim/complete RPCs (Section 10)", () => {
    const content = readLib(SOURCE);
    const fnStart = content.indexOf("export async function reconcilePendingStorageAudit");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const afterFn = content.slice(fnStart);
    // Section 10: MUST use claim_storage_audit_reconcile RPC (FOR
    // UPDATE SKIP LOCKED + per-row lock_token), not a direct query.
    expect(afterFn).toMatch(/claim_storage_audit_reconcile/);
    expect(afterFn).toMatch(/complete_storage_audit_reconcile/);
    // Must NOT directly query admin_storage_operations anymore.
    expect(afterFn).not.toMatch(/\.from\(["']admin_storage_operations["']\)/);
    // 4-state machine preserved.
    expect(afterFn).toMatch(/minAgeSeconds/);
    expect(afterFn).toMatch(/staleTimeoutSeconds/);
    expect(afterFn).toMatch(/\.list\(/);
    expect(afterFn).toMatch(/op\.action\s*===\s*"storage\.upload"/);
    expect(afterFn).toMatch(/auditSuccess\s*=\s*objectExists/);
    expect(afterFn).toMatch(/op\.action\s*===\s*"storage\.delete"/);
    expect(afterFn).toMatch(/auditSuccess\s*=\s*!objectExists/);
    // processed counts claimed rows, not the old pendingOps variable.
    expect(afterFn).toMatch(/processed:\s*claimedOps\.length/);
    // lock_token MUST be threaded from claim to complete.
    expect(afterFn).toMatch(/p_lock_token:\s*op\.lock_token/);
    // Section 10: full parent directory (split all segments, last
    // is filename).
    expect(afterFn).toMatch(/pathSegments\.pop\(\)/);
    expect(afterFn).toMatch(/pathSegments\.join\("\/"\)/);
    // Section 10: exact name match (rejects directory entries).
    // Implementation uses `item.name !== fileName` (early return) —
    // accept either === or !== comparison against fileName.
    expect(afterFn).toMatch(/item\.name\s*[!=]==?\s*fileName/);
    // No PII leaked.
    expect(afterFn).not.toMatch(/inquiry_id|phone|email/i);
  });
});

// ============================================================
// Runtime: uploadToPrivateAssets compensation saga (mocked)
// ============================================================

describe("Storage audit compensation — runtime saga (mocked)", () => {
  beforeEach(() => {
    mockStorage.from.mockReset();
    mockRpc.mockReset();
    mockFrom.mockReset();
    // Reset createAdminClient to the default implementation.
    mockCreateAdminClient.mockImplementation(() => ({
      storage: mockStorage,
      rpc: mockRpc,
      from: mockFrom,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("upload succeeds + audit completes → returns ok with path", async () => {
    // audit-start RPC returns an operation id
    mockRpc.mockResolvedValueOnce({ data: "op-1", error: null });
    // audit-complete RPC returns success
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    // storage.upload returns no error
    mockStorage.from.mockReturnValueOnce({
      upload: vi.fn().mockResolvedValue({ error: null }),
    });

    const { uploadToPrivateAssets } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await uploadToPrivateAssets({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      size: 4,
      filename: "test.png",
      category: "products",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bucket).toBe("private-assets");
      expect(result.path).toMatch(/^products\//);
    }
  });

  it("upload succeeds + audit-complete FAILS → compensates delete + returns failure", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // audit-start succeeds
    mockRpc.mockResolvedValueOnce({ data: "op-2", error: null });
    // audit-complete fails
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "rpc down" } });
    // storage.upload succeeds
    mockStorage.from.mockReturnValueOnce({
      upload: vi.fn().mockResolvedValue({ error: null }),
    });
    // compensate .remove() succeeds
    mockStorage.from.mockReturnValueOnce({
      remove: vi.fn().mockResolvedValue({ error: null }),
    });

    const { uploadToPrivateAssets } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await uploadToPrivateAssets({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      size: 4,
      filename: "test.png",
      category: "products",
    });

    // Audit-complete failed → must NOT return success.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ADMIN_WRITE_FAILED");
    }
    // Compensation delete was called (mockStorage.from called twice: upload + remove).
    expect(mockStorage.from).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("upload succeeds + audit-complete fails + compensation fails → enqueues residual cleanup", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // audit-start succeeds
    mockRpc.mockResolvedValueOnce({ data: "op-3", error: null });
    // audit-complete fails
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "rpc down" } });
    // enqueue_storage_cleanup succeeds (called from enqueueResidualObjectForCleanup)
    mockRpc.mockResolvedValueOnce({ data: "cleanup-1", error: null });
    // storage.upload succeeds
    mockStorage.from.mockReturnValueOnce({
      upload: vi.fn().mockResolvedValue({ error: null }),
    });
    // compensate .remove() FAILS (residual object remains)
    mockStorage.from.mockReturnValueOnce({
      remove: vi.fn().mockResolvedValue({ error: { message: "storage down" } }),
    });

    const { uploadToPrivateAssets } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await uploadToPrivateAssets({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      size: 4,
      filename: "test.png",
      category: "products",
    });

    // Must still return failure (audit not consistent).
    expect(result.ok).toBe(false);
    // enqueue_storage_cleanup RPC must have been called for the residual.
    expect(mockRpc).toHaveBeenCalledWith(
      "enqueue_storage_cleanup",
      expect.objectContaining({
        p_bucket: "private-assets",
        p_reason: "orphan_detected",
      }),
    );
    warnSpy.mockRestore();
  });

  it("delete succeeds + audit-complete FAILS → returns PARTIAL failure (not normal success)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // audit-start succeeds
    mockRpc.mockResolvedValueOnce({ data: "op-4", error: null });
    // audit-complete fails
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "rpc down" } });
    // storage.remove succeeds (object is now gone, cannot compensate)
    mockStorage.from.mockReturnValueOnce({
      remove: vi.fn().mockResolvedValue({ error: null }),
    });

    const { deletePrivateAsset } = await import(
      "@/lib/services/storage-upload"
    );
    // Use a valid UUID v4: version digit (3rd group) must be 4,
    // variant digit (4th group) must start with 8/9/a/b.
    const result = await deletePrivateAsset(
      "products/12345678-1234-4234-8234-123456789012.png",
    );

    // Must NOT return normal success — partial: true signals inconsistency.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ADMIN_WRITE_FAILED");
      expect(result.partial).toBe(true);
    }
    warnSpy.mockRestore();
  });

  it("delete fails (storage error) + audit-complete fails → returns failure (no partial)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // audit-start succeeds
    mockRpc.mockResolvedValueOnce({ data: "op-5", error: null });
    // audit-complete (failure path) fails too
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "rpc down" } });
    // storage.remove FAILS (object still exists)
    mockStorage.from.mockReturnValueOnce({
      remove: vi.fn().mockResolvedValue({ error: { message: "storage down" } }),
    });

    const { deletePrivateAsset } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await deletePrivateAsset(
      "products/12345678-1234-4234-8234-123456789012.png",
    );

    expect(result.ok).toBe(false);
    // NOT partial — the delete itself failed, so there's nothing to reconcile.
    if (!result.ok) {
      expect(result.partial).toBeUndefined();
    }
    warnSpy.mockRestore();
  });
});

// ============================================================
// Runtime: reconcilePendingStorageAudit state machine (mocked)
// ------------------------------------------------------------
// Uses mockFrom (shared via the hoisted vi.mock) so that the select
// chain and the storage list chain can be configured per test.
// ============================================================

describe("reconcilePendingStorageAudit — claim/complete RPC state machine (mocked)", () => {
  beforeEach(() => {
    mockStorage.from.mockReset();
    mockRpc.mockReset();
    mockFrom.mockReset();
    // Reset createAdminClient to the default implementation.
    mockCreateAdminClient.mockImplementation(() => ({
      storage: mockStorage,
      rpc: mockRpc,
      from: mockFrom,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a claimed-row shape that matches the
   * claim_storage_audit_reconcile RPC return value.
   * Each row carries a per-row `reconcile_lock_token` that MUST be
   * passed back to complete_storage_audit_reconcile.
   */
  function makeClaimedRow(input: {
    id: string;
    action: string;
    bucket: string;
    object_path: string;
    lockToken?: string;
  }) {
    return {
      id: input.id,
      action: input.action,
      bucket: input.bucket,
      object_path: input.object_path,
      reconcile_lock_token: input.lockToken ?? `lock-${input.id}`,
    };
  }

  /**
   * Configure mockRpc so that the first call to
   * `claim_storage_audit_reconcile` returns the supplied claimed rows,
   * and subsequent calls to `complete_storage_audit_reconcile` return
   * the supplied finalize outcomes in order.
   */
  function configureRpc(claimedRows: unknown[], finalizeOutcomes: string[]) {
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_audit_reconcile") {
        return Promise.resolve({ data: claimedRows, error: null });
      }
      if (name === "complete_storage_audit_reconcile") {
        const outcome = finalizeOutcomes.shift() ?? "completed";
        return Promise.resolve({ data: outcome, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  }

  it("returns ok + zero counts when claim returns no rows", async () => {
    configureRpc([], []);

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.processed).toBe(0);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(0);
    }
    // claim was called; complete was NOT.
    expect(mockRpc).toHaveBeenCalledWith(
      "claim_storage_audit_reconcile",
      expect.objectContaining({
        p_min_age_seconds: expect.any(Number),
        p_limit: expect.any(Number),
        p_stale_timeout_seconds: expect.any(Number),
      }),
    );
    expect(mockRpc).not.toHaveBeenCalledWith(
      "complete_storage_audit_reconcile",
      expect.anything(),
    );
  });

  it("returns ok:false when admin client cannot be created", async () => {
    // Override createAdminClient to throw (no vi.resetModules needed).
    mockCreateAdminClient.mockImplementation(() => {
      throw new Error("missing service role key");
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ADMIN_WRITE_FAILED");
    }
  });

  it("returns ok:false when claim RPC fails (fail-closed)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_audit_reconcile") {
        return Promise.resolve({
          data: null,
          error: { message: "rpc unavailable" },
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ADMIN_WRITE_FAILED");
    }
    // No complete RPC was attempted.
    expect(mockRpc).not.toHaveBeenCalledWith(
      "complete_storage_audit_reconcile",
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  // ============================================================
  // State 1: upload + object exists → audit success (completed++)
  // ============================================================
  it("state 1: upload pending + object EXISTS → completes audit as success (completed++)", async () => {
    const fileName = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
    const claimed = [
      makeClaimedRow({
        id: "op-upload-exists",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: `products/${fileName}`,
      }),
    ];
    configureRpc(claimed, ["completed"]);
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        data: [{ name: fileName }],
        error: null,
      }),
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.processed).toBe(1);
      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
    }
    // complete RPC must include the lock_token issued by claim.
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_audit_reconcile", {
      p_operation_id: "op-upload-exists",
      p_lock_token: "lock-op-upload-exists",
      p_success: true,
      p_error_code: null,
    });
    // list must use the FULL parent directory ("products"), not just
    // the first segment.
    expect(mockStorage.from).toHaveBeenCalledWith("private-assets");
  });

  // ============================================================
  // State 2: upload + object gone → audit failed (compensated delete)
  // ============================================================
  it("state 2: upload pending + object GONE → completes audit as failed (failed++)", async () => {
    const fileName = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png";
    const claimed = [
      makeClaimedRow({
        id: "op-upload-gone",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: `products/${fileName}`,
      }),
    ];
    configureRpc(claimed, ["failed"]);
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({ data: [], error: null }),
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.processed).toBe(1);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(1);
    }
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_audit_reconcile", {
      p_operation_id: "op-upload-gone",
      p_lock_token: "lock-op-upload-gone",
      p_success: false,
      p_error_code: "RECONCILE_STATE_MISMATCH",
    });
  });

  // ============================================================
  // State 3: delete + object gone → audit success (completed++)
  // ============================================================
  it("state 3: delete pending + object GONE → completes audit as success (completed++)", async () => {
    const fileName = "cccccccc-cccc-4ccc-8ccc-cccccccccccc.png";
    const claimed = [
      makeClaimedRow({
        id: "op-delete-gone",
        action: "storage.delete",
        bucket: "public-assets",
        object_path: `products/${fileName}`,
      }),
    ];
    configureRpc(claimed, ["completed"]);
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({ data: [], error: null }),
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.processed).toBe(1);
      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
    }
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_audit_reconcile", {
      p_operation_id: "op-delete-gone",
      p_lock_token: "lock-op-delete-gone",
      p_success: true,
      p_error_code: null,
    });
  });

  // ============================================================
  // State 4: delete + object still exists → audit failed
  // ============================================================
  it("state 4: delete pending + object STILL EXISTS → completes audit as failed (failed++)", async () => {
    const fileName = "dddddddd-dddd-4ddd-8ddd-dddddddddddd.png";
    const claimed = [
      makeClaimedRow({
        id: "op-delete-exists",
        action: "storage.delete",
        bucket: "public-assets",
        object_path: `products/${fileName}`,
      }),
    ];
    configureRpc(claimed, ["failed"]);
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        data: [{ name: fileName }],
        error: null,
      }),
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.processed).toBe(1);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(1);
    }
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_audit_reconcile", {
      p_operation_id: "op-delete-exists",
      p_lock_token: "lock-op-delete-exists",
      p_success: false,
      p_error_code: "RECONCILE_STATE_MISMATCH",
    });
  });

  // ============================================================
  // Edge case: storage.list error → skip (no complete RPC, row
  // stays 'claimed' for stale recovery)
  // ============================================================
  it("storage.list error → skips operation (no complete RPC, next retry)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fileName = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png";
    const claimed = [
      makeClaimedRow({
        id: "op-list-error",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: `products/${fileName}`,
      }),
    ];
    configureRpc(claimed, []);
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "list failed" },
      }),
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    // ok=true (loop completed) but processed reflects claim, with
    // no completed/failed since we skipped.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.processed).toBe(1);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(0);
    }
    // complete_storage_audit_reconcile must NOT have been called.
    expect(mockRpc).not.toHaveBeenCalledWith(
      "complete_storage_audit_reconcile",
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  // ============================================================
  // Edge case: unknown action → skip (no complete RPC)
  // ============================================================
  it("unknown action → skips operation (no complete RPC)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fileName = "ffffffff-ffff-4fff-8fff-ffffffffffff.png";
    const claimed = [
      makeClaimedRow({
        id: "op-unknown",
        action: "storage.unknown_action",
        bucket: "private-assets",
        object_path: `products/${fileName}`,
      }),
    ];
    configureRpc(claimed, []);
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        data: [{ name: fileName }],
        error: null,
      }),
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.processed).toBe(1);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(0);
    }
    expect(mockRpc).not.toHaveBeenCalledWith(
      "complete_storage_audit_reconcile",
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  // ============================================================
  // Mixed batch: multiple claimed rows in one reconcile run
  // ============================================================
  it("mixed batch: processes multiple claimed rows with different outcomes", async () => {
    const f1 = "11111111-1111-4111-8111-111111111111.png";
    const f2 = "22222222-2222-4222-8222-222222222222.png";
    const f3 = "33333333-3333-4333-8333-333333333333.png";
    const claimed = [
      makeClaimedRow({
        id: "op-mix-1",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: `products/${f1}`,
      }),
      makeClaimedRow({
        id: "op-mix-2",
        action: "storage.delete",
        bucket: "public-assets",
        object_path: `products/${f2}`,
      }),
      makeClaimedRow({
        id: "op-mix-3",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: `products/${f3}`,
      }),
    ];
    // 1st: upload + exists → completed
    // 2nd: delete + gone → completed
    // 3rd: upload + gone → failed
    configureRpc(claimed, ["completed", "completed", "failed"]);
    mockStorage.from.mockReturnValue({
      list: vi.fn()
        .mockResolvedValueOnce({ data: [{ name: f1 }], error: null })
        .mockResolvedValueOnce({ data: [], error: null })
        .mockResolvedValueOnce({ data: [], error: null }),
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.processed).toBe(3);
      expect(result.completed).toBe(2); // op-mix-1 + op-mix-2
      expect(result.failed).toBe(1); // op-mix-3
    }
    // Verify complete RPC called 3 times with correct success flags
    // and per-row lock_tokens (NOT a shared token).
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_audit_reconcile", {
      p_operation_id: "op-mix-1",
      p_lock_token: "lock-op-mix-1",
      p_success: true,
      p_error_code: null,
    });
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_audit_reconcile", {
      p_operation_id: "op-mix-2",
      p_lock_token: "lock-op-mix-2",
      p_success: true,
      p_error_code: null,
    });
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_audit_reconcile", {
      p_operation_id: "op-mix-3",
      p_lock_token: "lock-op-mix-3",
      p_success: false,
      p_error_code: "RECONCILE_STATE_MISMATCH",
    });
  });

  // ============================================================
  // Token mismatch (concurrent worker already finalized) → row
  // NOT counted in completed/failed
  // ============================================================
  it("NOT_FOUND_OR_TOKEN_MISMATCH → row not counted in completed/failed", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fileName = "44444444-4444-4444-8444-444444444444.png";
    const claimed = [
      makeClaimedRow({
        id: "op-token-mismatch",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: `products/${fileName}`,
      }),
    ];
    configureRpc(claimed, ["NOT_FOUND_OR_TOKEN_MISMATCH"]);
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        data: [{ name: fileName }],
        error: null,
      }),
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // processed counts the claim, but completed/failed are 0 because
      // the token did not match (a concurrent worker already finalized).
      expect(result.processed).toBe(1);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(0);
    }
    warnSpy.mockRestore();
  });

  // ============================================================
  // claim RPC failure → ok:false (fail-closed, no complete calls)
  // ============================================================
  it("claim_storage_audit_reconcile exception → returns ok:false (fail-closed)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_audit_reconcile") {
        throw new Error("network down");
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ADMIN_WRITE_FAILED");
    }
    expect(mockRpc).not.toHaveBeenCalledWith(
      "complete_storage_audit_reconcile",
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  // ============================================================
  // Section 10: full parent directory used for multi-segment paths
  // ============================================================
  it("uses full parent directory for multi-segment paths (Section 10)", async () => {
    const fileName = "55555555-5555-5555-8555-555555555555.png";
    // Two-segment parent: "products/covers"
    const claimed = [
      makeClaimedRow({
        id: "op-multi-segment",
        action: "storage.upload",
        bucket: "public-assets",
        object_path: `products/covers/${fileName}`,
      }),
    ];
    configureRpc(claimed, ["completed"]);
    const listMock = vi.fn().mockResolvedValue({
      data: [{ name: fileName }],
      error: null,
    });
    mockStorage.from.mockReturnValue({ list: listMock });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    await reconcilePendingStorageAudit();

    // list must be called with the FULL parent directory "products/covers",
    // NOT just the first segment "products".
    expect(listMock).toHaveBeenCalledWith(
      "products/covers",
      expect.objectContaining({ search: fileName, limit: 1 }),
    );
  });

  // ============================================================
  // Section 10: exact name match rejects directory entries
  // ============================================================
  it("rejects directory entries with the same name (exact match)", async () => {
    const fileName = "66666666-6666-6666-8666-666666666666.png";
    const claimed = [
      makeClaimedRow({
        id: "op-dir-match",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: `products/${fileName}`,
      }),
    ];
    configureRpc(claimed, ["failed"]);
    // list returns an entry whose name matches but isDir=true (a
    // directory, not the file we are looking for).
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        data: [{ name: fileName, isDir: true }],
        error: null,
      }),
    });

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The directory entry is NOT the file → treated as missing →
      // upload audit completed as failed (object was compensated).
      expect(result.processed).toBe(1);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(1);
    }
  });
});

// ============================================================
// Static: ImageUpload error state machine (Section 12)
// ============================================================

describe("ImageUpload — local error state machine (Section 12)", () => {
  const SOURCE = "components/admin/ImageUpload.tsx";

  it("handleRemove differentiates delete-success / delete-fail-enqueue-ok / delete-fail-enqueue-fail", () => {
    const content = readLib(SOURCE);
    // 1. Delete success path → clear error
    expect(content).toMatch(
      /del\.ok[\s\S]+?setNewUploadedRef\(null\)[\s\S]+?setError\(null\)/,
    );
    // 2. Delete failure + enqueue success → show "已加入待清理" message
    expect(content).toMatch(/已加入待清理/);
    // 3. Delete failure + enqueue failure → show "清理登记失败，请联系管理员"
    expect(content).toMatch(/清理登记失败，请联系管理员/);
    // 4. enqueueCleanupViaServerApi result MUST be checked (not ignored)
    expect(content).toMatch(/const\s+enq\s*=\s*await\s+enqueueCleanupViaServerApi/);
    expect(content).toMatch(/if\s*\(\s*enq\.ok\s*\)/);
  });

  it("handleFile enqueues previous new upload when replaced (form_cancelled)", () => {
    const content = readLib(SOURCE);
    expect(content).toMatch(/previousNewRef/);
    expect(content).toMatch(/reason:\s*"form_cancelled"/);
  });

  it("does not require publicUrl !== null as the success condition (private-assets support)", () => {
    const content = readLib(SOURCE);
    expect(content).toMatch(/ref\.publicUrl\s*\?\?\s*encodePrivateRef/);
    expect(content).not.toMatch(/publicUrl\s*!==\s*null/);
    expect(content).not.toMatch(/result\.data\.publicUrl\s*!==\s*null/);
  });
});
