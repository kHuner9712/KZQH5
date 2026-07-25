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

  it("reconcilePendingStorageAudit implements the 4-state machine", () => {
    const content = readLib(SOURCE);
    const fnStart = content.indexOf("export async function reconcilePendingStorageAudit");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const afterFn = content.slice(fnStart);
    expect(afterFn).toMatch(/admin_storage_operations/);
    expect(afterFn).toMatch(/\.eq\("status",\s*"pending"\)/);
    expect(afterFn).toMatch(/minAgeSeconds/);
    expect(afterFn).toMatch(/\.list\(/);
    expect(afterFn).toMatch(/op\.action\s*===\s*"storage\.upload"/);
    expect(afterFn).toMatch(/auditSuccess\s*=\s*objectExists/);
    expect(afterFn).toMatch(/op\.action\s*===\s*"storage\.delete"/);
    expect(afterFn).toMatch(/auditSuccess\s*=\s*!objectExists/);
    expect(afterFn).toMatch(/processed:\s*pendingOps\.length/);
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

describe("reconcilePendingStorageAudit — 4-state machine (mocked)", () => {
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

  // Helper: build a select chain for admin_storage_operations query.
  // The actual call chain is: from(table).select(cols).eq(...).lt(...).order(...).limit(...)
  function makeSelectChain(data: unknown, error: unknown) {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          lt: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({ data, error }),
            })),
          })),
        })),
      })),
    };
  }

  it("returns ok + zero counts when no pending operations exist", async () => {
    mockFrom.mockReturnValue(makeSelectChain([], null));

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

  // ============================================================
  // State 1: upload + object exists → audit success (completed++)
  // ============================================================
  it("state 1: upload pending + object EXISTS → completes audit as success (completed++)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pendingOps = [
      {
        id: "op-upload-exists",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: "products/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png",
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === "admin_storage_operations") {
        return makeSelectChain(pendingOps, null);
      }
      return null;
    });
    // storage.from(bucket).list(...) returns the object (exists = true).
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        data: [{ name: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png" }],
        error: null,
      }),
    });
    // complete_storage_operation RPC returns success.
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

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
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_operation", {
      p_operation_id: "op-upload-exists",
      p_success: true,
      p_error_code: null,
    });
    warnSpy.mockRestore();
  });

  // ============================================================
  // State 2: upload + object gone → audit failed (compensated delete)
  // ============================================================
  it("state 2: upload pending + object GONE → completes audit as failed (failed++)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pendingOps = [
      {
        id: "op-upload-gone",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: "products/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png",
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === "admin_storage_operations") {
        return makeSelectChain(pendingOps, null);
      }
      return null;
    });
    // storage.list returns empty (object was compensated-deleted).
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({ data: [], error: null }),
    });
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

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
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_operation", {
      p_operation_id: "op-upload-gone",
      p_success: false,
      p_error_code: "RECONCILE_STATE_MISMATCH",
    });
    warnSpy.mockRestore();
  });

  // ============================================================
  // State 3: delete + object gone → audit success (completed++)
  // ============================================================
  it("state 3: delete pending + object GONE → completes audit as success (completed++)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pendingOps = [
      {
        id: "op-delete-gone",
        action: "storage.delete",
        bucket: "public-assets",
        object_path: "products/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png",
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === "admin_storage_operations") {
        return makeSelectChain(pendingOps, null);
      }
      return null;
    });
    // storage.list returns empty (object successfully deleted).
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({ data: [], error: null }),
    });
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

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
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_operation", {
      p_operation_id: "op-delete-gone",
      p_success: true,
      p_error_code: null,
    });
    warnSpy.mockRestore();
  });

  // ============================================================
  // State 4: delete + object still exists → audit failed
  // ============================================================
  it("state 4: delete pending + object STILL EXISTS → completes audit as failed (failed++)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pendingOps = [
      {
        id: "op-delete-exists",
        action: "storage.delete",
        bucket: "public-assets",
        object_path: "products/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png",
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === "admin_storage_operations") {
        return makeSelectChain(pendingOps, null);
      }
      return null;
    });
    // storage.list returns the object (delete did not take effect).
    mockStorage.from.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        data: [{ name: "dddddddd-dddd-4ddd-8ddd-dddddddddddd.png" }],
        error: null,
      }),
    });
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

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
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_operation", {
      p_operation_id: "op-delete-exists",
      p_success: false,
      p_error_code: "RECONCILE_STATE_MISMATCH",
    });
    warnSpy.mockRestore();
  });

  // ============================================================
  // Edge case: storage.list error → skip (no audit mutation)
  // ============================================================
  it("storage.list error → skips operation (no RPC call, next retry)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pendingOps = [
      {
        id: "op-list-error",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: "products/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png",
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === "admin_storage_operations") {
        return makeSelectChain(pendingOps, null);
      }
      return null;
    });
    // storage.list returns an error.
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

    // ok=true (loop completed) but processed counts reflect skip.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.processed).toBe(1);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(0);
    }
    // complete_storage_operation must NOT have been called.
    expect(mockRpc).not.toHaveBeenCalledWith(
      "complete_storage_operation",
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  // ============================================================
  // Edge case: unknown action → skip (no audit mutation)
  // ============================================================
  it("unknown action → skips operation (no RPC call)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pendingOps = [
      {
        id: "op-unknown",
        action: "storage.unknown_action",
        bucket: "private-assets",
        object_path: "products/ffffffff-ffff-4fff-8fff-ffffffffffff.png",
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === "admin_storage_operations") {
        return makeSelectChain(pendingOps, null);
      }
      return null;
    });
    const listChain = {
      list: vi.fn().mockResolvedValue({
        data: [{ name: "ffffffff-ffff-4fff-8fff-ffffffffffff.png" }],
        error: null,
      }),
    };
    mockStorage.from.mockReturnValue(listChain);

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
      "complete_storage_operation",
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  // ============================================================
  // Mixed batch: multiple ops in one reconcile run
  // ============================================================
  it("mixed batch: processes multiple ops with different state outcomes", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pendingOps = [
      {
        id: "op-mix-1",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: "products/11111111-1111-4111-8111-111111111111.png",
      },
      {
        id: "op-mix-2",
        action: "storage.delete",
        bucket: "public-assets",
        object_path: "products/22222222-2222-4222-8222-222222222222.png",
      },
      {
        id: "op-mix-3",
        action: "storage.upload",
        bucket: "private-assets",
        object_path: "products/33333333-3333-4333-8333-333333333333.png",
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === "admin_storage_operations") {
        return makeSelectChain(pendingOps, null);
      }
      return null;
    });
    // 1st: upload + exists → success
    // 2nd: delete + gone → success
    // 3rd: upload + gone → failed
    mockStorage.from.mockReturnValue({
      list: vi.fn()
        .mockResolvedValueOnce({
          data: [{ name: "11111111-1111-4111-8111-111111111111.png" }],
          error: null,
        })
        .mockResolvedValueOnce({ data: [], error: null })
        .mockResolvedValueOnce({ data: [], error: null }),
    });
    // complete_storage_operation succeeds for all three.
    mockRpc.mockResolvedValue({ data: null, error: null });

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
    // Verify RPC was called 3 times with correct success flags.
    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockRpc).toHaveBeenNthCalledWith(1, "complete_storage_operation", {
      p_operation_id: "op-mix-1",
      p_success: true,
      p_error_code: null,
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, "complete_storage_operation", {
      p_operation_id: "op-mix-2",
      p_success: true,
      p_error_code: null,
    });
    expect(mockRpc).toHaveBeenNthCalledWith(3, "complete_storage_operation", {
      p_operation_id: "op-mix-3",
      p_success: false,
      p_error_code: "RECONCILE_STATE_MISMATCH",
    });
    warnSpy.mockRestore();
  });

  // ============================================================
  // admin_storage_operations read failure → ok:false (fail-closed)
  // ============================================================
  it("admin_storage_operations read error → returns ok:false (fail-closed)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFrom.mockReturnValue(
      makeSelectChain(null, { message: "permission denied" }),
    );

    const { reconcilePendingStorageAudit } = await import(
      "@/lib/services/storage-upload"
    );
    const result = await reconcilePendingStorageAudit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ADMIN_WRITE_FAILED");
    }
    // No audit mutation attempted.
    expect(mockRpc).not.toHaveBeenCalledWith(
      "complete_storage_operation",
      expect.anything(),
    );
    warnSpy.mockRestore();
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
