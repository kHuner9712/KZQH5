import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Phase 4 Task 6: Two-phase upload client function tests
//
// Tests the client-side functions with mocked fetch:
//   - requestUploadAuthorization
//   - uploadDirectToStorage
//   - finalizeUpload
//   - uploadViaTwoPhase (orchestrator)
// ============================================================

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestUploadAuthorization", () => {
  it("returns uploadToken and signedUrl on success", async () => {
    const { requestUploadAuthorization } = await import(
      "@/lib/services/admin-storage-fetch"
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        uploadToken: "abc-123",
        signedUrl: "https://supabase.co/upload/abc",
        headers: { "Content-Type": "image/jpeg" },
      }),
    });

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await requestUploadAuthorization(file, "product-image");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uploadToken).toBe("abc-123");
      expect(result.signedUrl).toBe("https://supabase.co/upload/abc");
      expect(result.headers).toEqual({ "Content-Type": "image/jpeg" });
    }

    // Verify fetch was called with the right arguments
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/admin/storage/upload/authorize",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
  });

  it("returns error when response is not ok", async () => {
    const { requestUploadAuthorization } = await import(
      "@/lib/services/admin-storage-fetch"
    );

    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await requestUploadAuthorization(file, "product-image");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("上传授权失败");
    }
  });

  it("returns error when uploadToken is missing", async () => {
    const { requestUploadAuthorization } = await import(
      "@/lib/services/admin-storage-fetch"
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ signedUrl: "https://supabase.co/upload/abc" }),
    });

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await requestUploadAuthorization(file, "product-image");

    expect(result.ok).toBe(false);
  });

  it("returns error when fetch throws", async () => {
    const { requestUploadAuthorization } = await import(
      "@/lib/services/admin-storage-fetch"
    );

    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await requestUploadAuthorization(file, "product-image");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("上传授权失败");
    }
  });
});

describe("uploadDirectToStorage", () => {
  it("returns ok when PUT succeeds", async () => {
    const { uploadDirectToStorage } = await import(
      "@/lib/services/admin-storage-fetch"
    );

    mockFetch.mockResolvedValueOnce({ ok: true });

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await uploadDirectToStorage(
      "https://supabase.co/upload/abc",
      file,
      { "Content-Type": "image/jpeg" },
    );

    expect(result.ok).toBe(true);

    // Verify fetch was called with CORS mode and omit credentials
    expect(mockFetch).toHaveBeenCalledWith(
      "https://supabase.co/upload/abc",
      expect.objectContaining({
        method: "PUT",
        credentials: "omit",
        mode: "cors",
      }),
    );
  });

  it("returns error when PUT fails", async () => {
    const { uploadDirectToStorage } = await import(
      "@/lib/services/admin-storage-fetch"
    );

    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await uploadDirectToStorage(
      "https://supabase.co/upload/abc",
      file,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("直传失败");
    }
  });

  it("returns error when fetch throws (CORS)", async () => {
    const { uploadDirectToStorage } = await import(
      "@/lib/services/admin-storage-fetch"
    );

    mockFetch.mockRejectedValueOnce(new Error("CORS error"));

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await uploadDirectToStorage(
      "https://supabase.co/upload/abc",
      file,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("直传失败");
    }
  });
});

describe("finalizeUpload", () => {
  it("returns StorageObjectRef on success", async () => {
    const { finalizeUpload } = await import("@/lib/services/admin-storage-fetch");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        bucket: "public-assets",
        path: "products/uuid.jpg",
        publicUrl: "https://supabase.co/storage/v1/object/public/public-assets/products/uuid.jpg",
        mimeType: "image/jpeg",
        size: 1024,
      }),
    });

    const result = await finalizeUpload("abc-123");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.bucket).toBe("public-assets");
      expect(result.data.path).toBe("products/uuid.jpg");
      expect(result.data.publicUrl).toContain("supabase.co");
      expect(result.data.mimeType).toBe("image/jpeg");
      expect(result.data.size).toBe(1024);
    }
  });

  it("returns error when response is not ok", async () => {
    const { finalizeUpload } = await import("@/lib/services/admin-storage-fetch");

    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });

    const result = await finalizeUpload("abc-123");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("上传确认失败");
    }
  });

  it("returns error when bucket is invalid", async () => {
    const { finalizeUpload } = await import("@/lib/services/admin-storage-fetch");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        bucket: "invalid-bucket",
        path: "products/uuid.jpg",
      }),
    });

    const result = await finalizeUpload("abc-123");

    expect(result.ok).toBe(false);
  });
});

describe("uploadViaTwoPhase (orchestrator)", () => {
  it("completes all three phases on success", async () => {
    const { uploadViaTwoPhase } = await import("@/lib/services/admin-storage-fetch");

    // Phase 1: authorize
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        uploadToken: "abc-123",
        signedUrl: "https://supabase.co/upload/abc",
        headers: { "Content-Type": "image/jpeg" },
      }),
    });

    // Phase 2: direct upload
    mockFetch.mockResolvedValueOnce({ ok: true });

    // Phase 3: finalize
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        bucket: "public-assets",
        path: "products/uuid.jpg",
        publicUrl: "https://supabase.co/storage/v1/object/public/public-assets/products/uuid.jpg",
        mimeType: "image/jpeg",
        size: 1024,
      }),
    });

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await uploadViaTwoPhase(file, "product-image");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.bucket).toBe("public-assets");
      expect(result.data.path).toBe("products/uuid.jpg");
    }

    // Verify 3 fetch calls were made
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("returns error when Phase 1 fails", async () => {
    const { uploadViaTwoPhase } = await import("@/lib/services/admin-storage-fetch");

    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await uploadViaTwoPhase(file, "product-image");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("上传授权失败");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns error when Phase 2 fails", async () => {
    const { uploadViaTwoPhase } = await import("@/lib/services/admin-storage-fetch");

    // Phase 1: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        uploadToken: "abc-123",
        signedUrl: "https://supabase.co/upload/abc",
        headers: {},
      }),
    });

    // Phase 2: failure
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await uploadViaTwoPhase(file, "product-image");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("直传失败");
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns error when Phase 3 fails", async () => {
    const { uploadViaTwoPhase } = await import("@/lib/services/admin-storage-fetch");

    // Phase 1: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        uploadToken: "abc-123",
        signedUrl: "https://supabase.co/upload/abc",
        headers: {},
      }),
    });

    // Phase 2: success
    mockFetch.mockResolvedValueOnce({ ok: true });

    // Phase 3: failure
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });
    const result = await uploadViaTwoPhase(file, "product-image");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("上传确认失败");
    }
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
