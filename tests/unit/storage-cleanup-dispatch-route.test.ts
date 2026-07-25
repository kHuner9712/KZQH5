import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Mocks for the admin Supabase client. Each test configures `mockRpc`
// and `mockStorageRemove` to drive the route through a specific path.
// The cleanup-dispatch route accesses `client.storage.from(bucket).remove(...)`,
// so mockClient MUST expose `storage` directly (not via client.from(...).storage).
const mockRpc = vi.fn();
const mockStorageRemove = vi.fn();
const mockStorageFrom = vi.fn(() => ({ remove: mockStorageRemove }));
const mockFrom = vi.fn();
const mockClient = {
  rpc: mockRpc,
  from: mockFrom,
  storage: { from: mockStorageFrom },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => mockClient,
}));

const VALID_SECRET = "test-cleanup-dispatch-secret-0123456789-long-enough";

function dispatchRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(
    "https://kzq.test/api/internal/storage/cleanup-dispatch",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
    },
  );
}

describe("POST /api/internal/storage/cleanup-dispatch — fail-closed dispatcher entrypoint", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockStorageRemove.mockReset();
    mockFrom.mockClear();
    vi.stubEnv("STORAGE_CLEANUP_DISPATCH_SECRET", VALID_SECRET);
    // Defense-in-depth: keep the outbox secret distinct so the
    // script-level equality check (not exercised here) is satisfied.
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", "different-outbox-secret-0123456789");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 when STORAGE_CLEANUP_DISPATCH_SECRET is missing (fail-closed)", async () => {
    vi.stubEnv("STORAGE_CLEANUP_DISPATCH_SECRET", "");
    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest({}, { Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("cleanup_dispatcher_disabled");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 503 when secret is too short (<16 chars)", async () => {
    vi.stubEnv("STORAGE_CLEANUP_DISPATCH_SECRET", "short");
    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest({}, { Authorization: "Bearer short" }),
    );
    expect(response.status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(dispatchRequest({}));
    expect(response.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is not Bearer scheme", async () => {
    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest({}, { Authorization: `Basic ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 403 when Bearer token does not match (timing-safe)", async () => {
    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest({}, { Authorization: "Bearer wrong-secret-value-here" }),
    );
    expect(response.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 400 when body is not valid JSON", async () => {
    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const request = new NextRequest(
      "https://kzq.test/api/internal/storage/cleanup-dispatch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_SECRET}`,
        },
        body: "{not valid json",
      },
    );
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 200 with zero counters when no rows are claimable", async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_cleanup") {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(json.processed).toBe(true);
    expect(json.result).toEqual({
      claimed: 0,
      deleted: 0,
      blocked: 0,
      failed: 0,
      deadLettered: 0,
    });
    // claim_storage_cleanup was called with the clamped batch size and
    // the stale timeout in seconds.
    expect(mockRpc).toHaveBeenCalledWith("claim_storage_cleanup", {
      p_limit: 5,
      p_stale_timeout_seconds: 300,
    });
  });

  it("deletes a row when reference check returns false", async () => {
    const claimed = [
      {
        id: "c1",
        bucket: "public-assets",
        object_path: "products/abc.jpg",
        lock_token: "t1",
      },
    ];
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_cleanup") {
        return Promise.resolve({ data: claimed, error: null });
      }
      if (name === "check_storage_object_referenced") {
        return Promise.resolve({ data: false, error: null });
      }
      if (name === "complete_storage_cleanup") {
        return Promise.resolve({ data: "completed", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    mockStorageRemove.mockResolvedValue({ data: [], error: null });

    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.result).toEqual({
      claimed: 1,
      deleted: 1,
      blocked: 0,
      failed: 0,
      deadLettered: 0,
    });
    // Storage .remove was called once with the path.
    expect(mockStorageRemove).toHaveBeenCalledTimes(1);
    expect(mockStorageRemove).toHaveBeenCalledWith(["products/abc.jpg"]);
    // complete_storage_cleanup was called with success=true.
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_cleanup", {
      p_cleanup_id: "c1",
      p_lock_token: "t1",
      p_success: true,
      p_error_code: null,
    });
  });

  it("blocks deletion (does not call .remove) when reference check returns true", async () => {
    const claimed = [
      {
        id: "c2",
        bucket: "public-assets",
        object_path: "products/referenced.jpg",
        lock_token: "t2",
      },
    ];
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_cleanup") {
        return Promise.resolve({ data: claimed, error: null });
      }
      if (name === "check_storage_object_referenced") {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "complete_storage_cleanup") {
        return Promise.resolve({ data: "completed", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    // .remove should never be called when referenced=true.
    mockStorageRemove.mockResolvedValue({ data: [], error: null });

    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.result).toEqual({
      claimed: 1,
      deleted: 0,
      blocked: 1,
      failed: 0,
      deadLettered: 0,
    });
    expect(mockStorageRemove).not.toHaveBeenCalled();
    // complete_storage_cleanup was called with success=true and
    // the REFERENCED_BLOCKED code so the row terminates.
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_cleanup", {
      p_cleanup_id: "c2",
      p_lock_token: "t2",
      p_success: true,
      p_error_code: "REFERENCED_BLOCKED",
    });
  });

  it("fail-closed: treats object as referenced when check RPC errors", async () => {
    const claimed = [
      {
        id: "c3",
        bucket: "private-assets",
        object_path: "catalogs/draft.pdf",
        lock_token: "t3",
      },
    ];
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_cleanup") {
        return Promise.resolve({ data: claimed, error: null });
      }
      if (name === "check_storage_object_referenced") {
        // RPC error: fail-closed (treat as referenced).
        return Promise.resolve({ data: null, error: { message: "rpc failed" } });
      }
      if (name === "complete_storage_cleanup") {
        return Promise.resolve({ data: "completed", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    mockStorageRemove.mockResolvedValue({ data: [], error: null });

    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.result).toEqual({
      claimed: 1,
      deleted: 0,
      blocked: 1,
      failed: 0,
      deadLettered: 0,
    });
    // .remove was NOT called because we fail-closed.
    expect(mockStorageRemove).not.toHaveBeenCalled();
    // The error code is REFERENCED_CHECK_FAILED.
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_cleanup", {
      p_cleanup_id: "c3",
      p_lock_token: "t3",
      p_success: true,
      p_error_code: "REFERENCED_CHECK_FAILED",
    });
  });

  it("marks row as failed when Storage .remove returns an error", async () => {
    const claimed = [
      {
        id: "c4",
        bucket: "public-assets",
        object_path: "products/broken.jpg",
        lock_token: "t4",
      },
    ];
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_cleanup") {
        return Promise.resolve({ data: claimed, error: null });
      }
      if (name === "check_storage_object_referenced") {
        return Promise.resolve({ data: false, error: null });
      }
      if (name === "complete_storage_cleanup") {
        return Promise.resolve({ data: "retry", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    // Storage returns an error.
    mockStorageRemove.mockResolvedValue({
      data: null,
      error: { message: "storage unreachable" },
    });

    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.result).toEqual({
      claimed: 1,
      deleted: 0,
      blocked: 0,
      failed: 1,
      deadLettered: 0,
    });
    // complete_storage_cleanup was called with success=false.
    expect(mockRpc).toHaveBeenCalledWith("complete_storage_cleanup", {
      p_cleanup_id: "c4",
      p_lock_token: "t4",
      p_success: false,
      p_error_code: "STORAGE_DELETE_FAILED",
    });
  });

  it("counts dead_letter when complete_storage_cleanup returns dead_letter", async () => {
    const claimed = [
      {
        id: "c5",
        bucket: "public-assets",
        object_path: "products/dead.jpg",
        lock_token: "t5",
      },
    ];
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_cleanup") {
        return Promise.resolve({ data: claimed, error: null });
      }
      if (name === "check_storage_object_referenced") {
        return Promise.resolve({ data: false, error: null });
      }
      if (name === "complete_storage_cleanup") {
        return Promise.resolve({ data: "dead_letter", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    mockStorageRemove.mockResolvedValue({ data: [], error: null });

    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    // Deleted AND deadLettered (the RPC marked dead_letter despite the
    // successful delete — e.g. attempts exceeded before success recorded).
    expect(json.result.deleted).toBe(1);
    expect(json.result.deadLettered).toBe(1);
  });

  it("clamps batchSize to default when missing", async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_cleanup") {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest({}, { Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("claim_storage_cleanup", {
      p_limit: 10,
      p_stale_timeout_seconds: 300,
    });
  });

  it("clamps batchSize to MAX_BATCH_SIZE when too large", async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_cleanup") {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest(
        { batchSize: 9999 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    // MAX_BATCH_SIZE = 25.
    expect(mockRpc).toHaveBeenCalledWith("claim_storage_cleanup", {
      p_limit: 25,
      p_stale_timeout_seconds: 300,
    });
  });

  it("response body never includes object paths or bucket names", async () => {
    const claimed = [
      {
        id: "c6",
        bucket: "public-assets",
        object_path: "products/secret-path-123.jpg",
        lock_token: "t6",
      },
    ];
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_storage_cleanup") {
        return Promise.resolve({ data: claimed, error: null });
      }
      if (name === "check_storage_object_referenced") {
        return Promise.resolve({ data: false, error: null });
      }
      if (name === "complete_storage_cleanup") {
        return Promise.resolve({ data: "completed", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    mockStorageRemove.mockResolvedValue({ data: [], error: null });

    const { POST } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    const json = await response.json();
    const serialized = JSON.stringify(json);
    // Counter-only response: no paths, no bucket names, no lock tokens.
    expect(serialized).not.toContain("secret-path-123");
    expect(serialized).not.toContain("public-assets");
    expect(serialized).not.toContain("private-assets");
    expect(serialized).not.toMatch(/lock[_-]?token/i);
    expect(serialized).not.toMatch(/object[_-]?path/i);
  });

  it("GET method returns 405", async () => {
    const { GET } = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    const response = await GET();
    expect(response.status).toBe(405);
  });
});

/**
 * Verify the route is exported with the right Next.js runtime directives
 * so it is never statically optimized or cached.
 */
describe("POST /api/internal/storage/cleanup-dispatch — Next.js runtime directives", () => {
  it("route module exports dynamic and revalidate constants", async () => {
    const mod = await import(
      "@/app/api/internal/storage/cleanup-dispatch/route"
    );
    expect(mod.dynamic).toBe("force-dynamic");
    expect(mod.revalidate).toBe(0);
    expect(mod.runtime).toBe("nodejs");
  });
});
