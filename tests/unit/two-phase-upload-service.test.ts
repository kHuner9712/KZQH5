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

  // ============================================================
  // KZQ-P0-002: Signed upload URL lifecycle model.
  //
  // The DB `expires_at` (5 min) is the BUSINESS authorization window
  // for the temp_uploads row, NOT the Supabase signed-upload-URL TTL.
  // `createSignedUploadUrl` does not accept a TTL argument; the
  // capability URL lifetime is server-controlled (default 1h). The
  // `expiresAt` field returned to the caller must reflect the DB row's
  // business window, and the constant must be named to reflect that
  // it is an authorization window, not a signed-URL TTL.
  // ============================================================
  it("returns expiresAt as the business authorization window, not the signed-URL TTL", async () => {
    const { authorizeTempUpload, TEMP_UPLOAD_AUTHORIZATION_WINDOW_SECONDS } =
      await import("@/lib/services/two-phase-upload");

    // The constant must represent the 5-minute business window.
    expect(TEMP_UPLOAD_AUTHORIZATION_WINDOW_SECONDS).toBe(300);

    const token = "abc12345-1234-1234-1234-123456789abc";
    const businessWindowExpiresAt = "2026-07-29T12:05:00Z";
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        row: {
          id: token,
          object_path: `temp/${token}/test.jpg`,
          expires_at: businessWindowExpiresAt,
        },
      },
      error: null,
    });

    mockCreateSignedUploadUrl.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.co/storage/v1/object/upload/private-assets/temp/test.jpg" },
      error: null,
    });

    const result = await authorizeTempUpload({
      purpose: "product-image",
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: 1024,
    });

    expect(result.ok).toBe(true);
    // expiresAt must equal the DB row's business authorization window
    // deadline, NOT a derived signed-URL TTL. The signed URL's actual
    // capability lifetime is server-controlled and not exposed here.
    expect(result.expiresAt).toBe(businessWindowExpiresAt);
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
