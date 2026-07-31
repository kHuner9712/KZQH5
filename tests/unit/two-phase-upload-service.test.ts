import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Phase 4 Task 6: Two-phase upload service tests
//
// Tests the server-side authorizeTempUpload and finalizeTempUpload
// functions with mocked Supabase client. No real Supabase connection.
// ============================================================

const mockRpc = vi.fn();
const mockCreateSignedUploadUrl = vi.fn();
const mockList = vi.fn();
const mockCreateSignedUrl = vi.fn();
const mockCopy = vi.fn();
const mockDownload = vi.fn();
const mockUpload = vi.fn();
const mockRemove = vi.fn();
const mockGetPublicUrl = vi.fn();

const mockStorage = {
  from: vi.fn(() => ({
    createSignedUploadUrl: mockCreateSignedUploadUrl,
    list: mockList,
    createSignedUrl: mockCreateSignedUrl,
    copy: mockCopy,
    download: mockDownload,
    upload: mockUpload,
    remove: mockRemove,
    getPublicUrl: mockGetPublicUrl,
  })),
};

const mockClient = {
  rpc: mockRpc,
  storage: mockStorage,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockClient,
}));

vi.mock("@/lib/services/storage-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/storage-upload")>();
  return {
    ...actual,
    // Use real generatePrivateStoragePath / generatePublicStoragePath
  };
});

vi.mock("@/lib/services/storage-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/storage-upload")>();
  return {
    ...actual,
    enqueueStorageCleanup: vi.fn().mockResolvedValue({ ok: true }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ============================================================
// authorizeTempUpload tests
// ============================================================
describe("authorizeTempUpload", () => {
  it("rejects invalid purpose", async () => {
    const { authorizeTempUpload } = await import("@/lib/services/two-phase-upload");
    const result = await authorizeTempUpload({
      purpose: "invalid-purpose" as never,
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: 1024,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_PURPOSE");
  });

  it("rejects MIME not allowed for purpose", async () => {
    const { authorizeTempUpload } = await import("@/lib/services/two-phase-upload");
    // catalog-draft allows PDF but product-image does not
    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: "test.pdf",
      mimeType: "application/pdf",
      size: 1024,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MIME_NOT_ALLOWED_FOR_PURPOSE");
  });

  it("rejects size exceeding two-phase limit", async () => {
    const { authorizeTempUpload, TWO_PHASE_MAX_SIZE } = await import(
      "@/lib/services/two-phase-upload"
    );
    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: TWO_PHASE_MAX_SIZE["image/jpeg"] + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIZE_EXCEEDS_LIMIT");
  });

  it("rejects size <= 0", async () => {
    const { authorizeTempUpload } = await import("@/lib/services/two-phase-upload");
    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIZE_EXCEEDS_LIMIT");
  });

  it("rejects filename with path separators", async () => {
    const { authorizeTempUpload } = await import("@/lib/services/two-phase-upload");
    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: "../../etc/passwd",
      mimeType: "image/jpeg",
      size: 1024,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_FILENAME");
  });

  it("rejects filename with null bytes", async () => {
    const { authorizeTempUpload } = await import("@/lib/services/two-phase-upload");
    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: "test\x00.jpg",
      mimeType: "image/jpeg",
      size: 1024,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_FILENAME");
  });

  it("rejects dot-only filename", async () => {
    const { authorizeTempUpload } = await import("@/lib/services/two-phase-upload");
    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: ".",
      mimeType: "image/jpeg",
      size: 1024,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_FILENAME");
  });

  it("returns signed URL on success", async () => {
    const { authorizeTempUpload } = await import("@/lib/services/two-phase-upload");

    const token = "abc12345-1234-1234-1234-123456789abc";
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        row: {
          id: token,
          object_path: `temp/${token}/test.jpg`,
          expires_at: "2026-07-29T12:00:00Z",
        },
      },
      error: null,
    });

    mockCreateSignedUploadUrl.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.co/storage/v1/object/upload/private-assets/temp/abc/test.jpg" },
      error: null,
    });

    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: 1024,
    });

    expect(result.ok).toBe(true);
    expect(result.uploadToken).toBe(token);
    expect(result.signedUrl).toContain("supabase.co");
    expect(result.method).toBe("PUT");
    expect(result.headers).toEqual({ "Content-Type": "image/jpeg" });
  });

  it("marks row as failed when signed URL generation fails", async () => {
    const { authorizeTempUpload } = await import("@/lib/services/two-phase-upload");

    const token = "abc12345-1234-1234-1234-123456789abc";
    mockRpc.mockResolvedValueOnce({
      data: { ok: true, row: { id: token, object_path: `temp/${token}/test.jpg`, expires_at: "2026-07-29T12:00:00Z" } },
      error: null,
    });

    mockCreateSignedUploadUrl.mockResolvedValueOnce({
      data: null,
      error: { message: "Storage error" },
    });

    // fail_temp_upload_finalize RPC
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: 1024,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIGNED_URL_FAILED");
    // Verify fail RPC was called
    expect(mockRpc).toHaveBeenCalledWith(
      "fail_temp_upload_finalize",
      expect.objectContaining({ p_token: token }),
    );
  });

  it("handles RPC failure", async () => {
    const { authorizeTempUpload } = await import("@/lib/services/two-phase-upload");

    mockRpc.mockResolvedValueOnce({
      data: { ok: false, error: "invalid_purpose" },
      error: null,
    });

    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: 1024,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_purpose");
  });
});

// ============================================================
// finalizeTempUpload tests
// ============================================================
describe("finalizeTempUpload", () => {
  const validClaimRow = {
    id: "abc12345-1234-1234-1234-123456789abc",
    object_path: "temp/abc12345-1234-1234-1234-123456789abc/test.jpg",
    declared_mime_type: "image/jpeg",
    declared_size: 1024,
    declared_filename: "test.jpg",
    final_bucket: "public-assets",
    final_category: "products",
  };

  it("rejects when claim RPC fails", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    mockRpc.mockResolvedValueOnce({
      data: { ok: false, error: "not_found_or_locked" },
      error: null,
    });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_found_or_locked");
  });

  it("rejects when object not found in Storage", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    mockRpc.mockResolvedValueOnce({
      data: { ok: true, row: validClaimRow },
      error: null,
    });

    mockList.mockResolvedValueOnce({ data: [], error: null });
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null }); // fail RPC

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("OBJECT_NOT_FOUND");
  });

  it("rejects when size mismatches", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    mockRpc.mockResolvedValueOnce({
      data: { ok: true, row: validClaimRow },
      error: null,
    });

    mockList.mockResolvedValueOnce({
      data: [{ name: "test.jpg", metadata: { size: 2048 } }],
      error: null,
    });
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null }); // fail RPC

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIZE_MISMATCH");
  });
});

// ============================================================
// finalizeTempUpload — strict complete RPC parsing (KZQ-P0-001)
// ------------------------------------------------------------
// The complete_temp_upload_finalize RPC must be strictly parsed:
// transport error, null data, invalid structure, or ok !== true
// are ALL treated as failures. When the object has already been
// moved to its final path but the RPC fails, compensation must
// delete the moved object and return a fixed error code — never
// success.
// ============================================================
describe("finalizeTempUpload — strict complete RPC parsing (KZQ-P0-001)", () => {
  // Valid JPEG magic bytes fetch response ([0xFF, 0xD8, 0xFF, ...])
  function mockJpegFetchResponse() {
    return {
      ok: true,
      arrayBuffer: async () => {
        const buffer = new ArrayBuffer(16);
        const bytes = new Uint8Array(buffer);
        bytes[0] = 0xff;
        bytes[1] = 0xd8;
        bytes[2] = 0xff;
        bytes[3] = 0xe0;
        return buffer;
      },
    };
  }

  // Set up happy-path mocks through step 8 (temp delete) for a
  // private-assets final bucket. Each test then appends the
  // complete-RPC mock and any compensation mocks.
  function setupHappyPathPrivateAssets() {
    const token = "abc12345-1234-1234-1234-123456789abc";
    const claimRow = {
      id: token,
      object_path: `temp/${token}/test.jpg`,
      declared_mime_type: "image/jpeg",
      declared_size: 1024,
      declared_filename: "test.jpg",
      final_bucket: "private-assets",
      final_category: "products",
    };
    // 1. claim RPC
    mockRpc.mockResolvedValueOnce({ data: { ok: true, row: claimRow }, error: null });
    // 2. list (verify object exists + size)
    mockList.mockResolvedValueOnce({
      data: [{ name: "test.jpg", metadata: { size: 1024 } }],
      error: null,
    });
    // 3. createSignedUrl (for magic bytes range download)
    mockCreateSignedUrl.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.co/storage/signed/test" },
      error: null,
    });
    // 4. fetch (magic bytes) — stubbed globally
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJpegFetchResponse()));
    // 5. copy (temp → final path)
    mockCopy.mockResolvedValueOnce({ error: null });
    // 6. remove temp object (step 8)
    mockRemove.mockResolvedValueOnce({ data: [], error: null });
    return { token, claimRow };
  }

  // Compensation delete succeeds + fail RPC
  function setupCompensationSuccess() {
    mockRemove.mockResolvedValueOnce({ data: [], error: null }); // compensation delete
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null }); // fail RPC
  }

  // Compensation delete fails + fail RPC
  function setupCompensationFailure() {
    mockRemove.mockResolvedValueOnce({ data: null, error: { message: "Storage error" } });
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null }); // fail RPC
  }

  it("fails on complete RPC transport error (compensation succeeds)", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
    setupHappyPathPrivateAssets();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "Network timeout" } });
    setupCompensationSuccess();

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("COMPLETE_RPC_FAILED");
  });

  it("fails on complete RPC returning null data", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
    setupHappyPathPrivateAssets();
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    setupCompensationSuccess();

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("COMPLETE_RPC_FAILED");
  });

  it("fails on complete RPC returning invalid structure (no ok field)", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
    setupHappyPathPrivateAssets();
    mockRpc.mockResolvedValueOnce({ data: { foo: "bar" }, error: null });
    setupCompensationSuccess();

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("COMPLETE_RPC_FAILED");
  });

  it("fails on complete RPC returning ok:false", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
    setupHappyPathPrivateAssets();
    mockRpc.mockResolvedValueOnce({
      data: { ok: false, error: "invalid_status" },
      error: null,
    });
    setupCompensationSuccess();

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("COMPLETE_RPC_FAILED");
  });

  it("compensation delete succeeds → no cleanup enqueued for final object", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
    const { enqueueStorageCleanup } = await import("@/lib/services/storage-upload");
    const mockedEnqueueCleanup = vi.mocked(enqueueStorageCleanup);

    setupHappyPathPrivateAssets();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "Network error" } });
    setupCompensationSuccess();

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    // Compensation delete succeeded → cleanup NOT enqueued
    expect(mockedEnqueueCleanup).not.toHaveBeenCalled();
  });

  it("compensation delete fails → cleanup enqueued for final object", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
    const { enqueueStorageCleanup } = await import("@/lib/services/storage-upload");
    const mockedEnqueueCleanup = vi.mocked(enqueueStorageCleanup);

    setupHappyPathPrivateAssets();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "Network error" } });
    setupCompensationFailure();

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    // Compensation delete failed → cleanup enqueued for the FINAL object
    expect(mockedEnqueueCleanup).toHaveBeenCalledTimes(1);
    const callArgs = mockedEnqueueCleanup.mock.calls[0][0];
    expect(callArgs.bucket).toBe("private-assets");
    expect(callArgs.reason).toBe("orphan_detected");
    // Path must be the final object path, NOT the temp path
    expect(callArgs.objectPath).not.toContain("temp/");
  });

  it("returns success on normal complete RPC ok:true", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
    setupHappyPathPrivateAssets();
    mockRpc.mockResolvedValueOnce({
      data: { ok: true, row: { id: "abc", status: "finalized" } },
      error: null,
    });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(true);
    expect(result.bucket).toBe("private-assets");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.size).toBe(1024);
  });

  it("returns success on idempotent re-finalize (already_finalized:true)", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
    setupHappyPathPrivateAssets();
    mockRpc.mockResolvedValueOnce({
      data: { ok: true, already_finalized: true, row: { id: "abc", status: "finalized" } },
      error: null,
    });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    // already_finalized returns ok:true → treated as success
    expect(result.ok).toBe(true);
  });
});
