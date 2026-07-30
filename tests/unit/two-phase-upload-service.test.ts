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

  // ============================================================
  // KZQ-P0-001: complete_temp_upload_finalize RPC business
  // return value (`ok` field) validation.
  //
  // These tests pin the contract that the finalize service must
  // validate the RPC JSONB return object, not just the transport
  // error. Transport error, null data, malformed structure, or
  // `ok !== true` are ALL failures. When the object has already
  // been moved but the RPC fails, the service must NOT return
  // success — it must compensate (delete the moved object) and,
  // if compensation fails, enqueue cleanup.
  // ============================================================

  /**
   * Sets up the mock sequence for a finalize that reaches step 9
   * (the complete_temp_upload_finalize RPC). claim → list →
   * signedUrl → fetch(magic bytes) → copy → cross-bucket download
   * → cross-bucket upload → remove temp copy → remove temp object
   * → [caller controls the complete RPC response].
   *
   * Returns the index in mockRpc.mockResolvedValueOnce queue where
   * the caller should push the complete RPC response (it is the
   * SECOND RPC call; the first is fail_temp_upload_finalize only
   * used on failure paths before step 9, so for the success-to-9
   * path there is exactly ONE prior RPC: claim).
   */
  function setupFinalizeToStep9(): void {
    // 1. claim_temp_upload_for_finalize → ok
    mockRpc.mockResolvedValueOnce({
      data: { ok: true, row: validClaimRow },
      error: null,
    });

    // 2. storage.list → object exists with matching size
    mockList.mockResolvedValueOnce({
      data: [{ name: "test.jpg", metadata: { size: validClaimRow.declared_size } }],
      error: null,
    });

    // 3. storage.createSignedUrl → ok (for magic bytes range download)
    mockCreateSignedUrl.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.co/storage/v1/object/sign/private-assets/temp/test.jpg" },
      error: null,
    });

    // 4. fetch → JPEG magic bytes (FF D8 FF)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer,
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    // 5. storage.copy (temp → final within private-assets) → ok
    mockCopy.mockResolvedValueOnce({ data: { path: validClaimRow.object_path }, error: null });

    // 6. cross-bucket move for public-assets: download → upload → remove temp copy
    mockDownload.mockResolvedValueOnce({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    mockUpload.mockResolvedValueOnce({ data: { path: "products/final.jpg" }, error: null });
    mockRemove.mockResolvedValueOnce({ data: null, error: null });

    // 7. getPublicUrl (no network, returns synchronously)
    mockGetPublicUrl.mockReturnValueOnce({
      data: { publicUrl: "https://cdn.example.com/products/final.jpg" },
    });

    // 8. remove original temp object (non-fatal on failure)
    mockRemove.mockResolvedValueOnce({ data: null, error: null });

    // 9. complete_temp_upload_finalize — caller must push the
    //    NEXT mockRpc.mockResolvedValueOnce(...) for this call.
  }

  it("returns ok:true on full success path with valid JPEG magic bytes", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    setupFinalizeToStep9();
    // 9. complete_temp_upload_finalize → { ok: true }
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(true);
    expect(result.bucket).toBe("public-assets");
    expect(result.path).toBeDefined();
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.size).toBe(1024);
    expect(result.publicUrl).toContain("cdn.example.com");

    vi.unstubAllGlobals();
  });

  it("returns ok:false when complete RPC returns transport error", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    setupFinalizeToStep9();
    // 9. complete RPC → transport error
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "connection refused" },
    });
    // Compensation path: storage.remove(finalObjectPath) → ok
    mockRemove.mockResolvedValueOnce({ data: null, error: null });
    // failFinalize: fail_temp_upload_finalize → ok (best-effort)
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("FINALIZE_RPC_FAILED");
    // Verify compensation deleted the moved final object
    expect(mockRemove).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("products/")]),
    );
    vi.unstubAllGlobals();
  });

  it("returns ok:false when complete RPC returns null data", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    setupFinalizeToStep9();
    // 9. complete RPC → null data, no transport error
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    // Compensation: remove final object → ok
    mockRemove.mockResolvedValueOnce({ data: null, error: null });
    // failFinalize → ok
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("FINALIZE_RPC_FAILED");
    vi.unstubAllGlobals();
  });

  it("returns ok:false when complete RPC returns malformed structure", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    setupFinalizeToStep9();
    // 9. complete RPC → non-object data (malformed)
    mockRpc.mockResolvedValueOnce({ data: "not-an-object", error: null });
    // Compensation: remove final object → ok
    mockRemove.mockResolvedValueOnce({ data: null, error: null });
    // failFinalize → ok
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("FINALIZE_RPC_FAILED");
    vi.unstubAllGlobals();
  });

  it("returns ok:false when complete RPC returns { ok: false }", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    setupFinalizeToStep9();
    // 9. complete RPC → { ok: false, error: "invalid_status" }
    mockRpc.mockResolvedValueOnce({
      data: { ok: false, error: "invalid_status" },
      error: null,
    });
    // Compensation: remove final object → ok
    mockRemove.mockResolvedValueOnce({ data: null, error: null });
    // failFinalize → ok
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("FINALIZE_RPC_FAILED");
    // Verify failFinalize was called with a reason containing the RPC error
    expect(mockRpc).toHaveBeenCalledWith(
      "fail_temp_upload_finalize",
      expect.objectContaining({
        p_reason: expect.stringContaining("invalid_status"),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("compensates by deleting moved object when RPC fails (compensation success)", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    setupFinalizeToStep9();
    // 9. complete RPC fails
    mockRpc.mockResolvedValueOnce({
      data: { ok: false, error: "race_finalized" },
      error: null,
    });
    // Compensation: remove final object → SUCCESS (no error)
    mockRemove.mockResolvedValueOnce({ data: null, error: null });
    // failFinalize → ok
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("FINALIZE_RPC_FAILED");
    // Compensation delete was attempted on the final bucket
    expect(mockRemove).toHaveBeenCalled();
    // No cleanup enqueue when compensation succeeds (enqueueStorageCleanup is mocked)
    vi.unstubAllGlobals();
  });

  it("enqueues cleanup when compensation delete also fails", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
    const { enqueueStorageCleanup } = await import("@/lib/services/storage-upload");

    setupFinalizeToStep9();
    // 9. complete RPC fails
    mockRpc.mockResolvedValueOnce({
      data: { ok: false, error: "invalid_status" },
      error: null,
    });
    // Compensation: remove final object → FAILS
    mockRemove.mockResolvedValueOnce({
      data: null,
      error: { message: "storage unavailable" },
    });
    // failFinalize → ok (best-effort)
    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("FINALIZE_RPC_FAILED");
    // Cleanup queue must be enqueued because compensation delete failed
    expect(enqueueStorageCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "public-assets",
        reason: "orphan_detected",
      }),
    );
    vi.unstubAllGlobals();
  });

  it("is idempotent: returns ok:true when complete RPC says already_finalized", async () => {
    const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");

    setupFinalizeToStep9();
    // 9. complete RPC → { ok: true, already_finalized: true } (idempotent retry)
    mockRpc.mockResolvedValueOnce({
      data: { ok: true, already_finalized: true },
      error: null,
    });

    const result = await finalizeTempUpload({
      uploadToken: "abc12345-1234-1234-1234-123456789abc",
    });

    // already_finalized is a success path — the row was already
    // finalized by a prior call, so the object is in place and
    // we should return success.
    expect(result.ok).toBe(true);
    expect(result.code).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
