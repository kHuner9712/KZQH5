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
  // KZQ-P0-004: Final extension from verified MIME, not filename.
  //
  // These tests verify that the final Storage object path uses the
  // extension derived from the server-verified MIME type (magic bytes
  // verified), NOT the user-supplied filename. The temp_uploads row
  // stores declared_filename for display/audit only.
  //
  // We use final_bucket="private-assets" so the flow stops at the
  // copy step (no cross-bucket move), and we assert the copy
  // destination path ends with the MIME-canonical extension.
  // ============================================================
  describe("KZQ-P0-004: MIME-derived extension", () => {
    // Valid magic bytes for each supported MIME type
    const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const PNG_MAGIC = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const WEBP_MAGIC = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    const PDF_MAGIC = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35,
    ]);

    /**
     * Helper: run finalize up to the copy step and return the
     * destination path that was passed to copy(). The copy mock
     * resolves successfully, and the flow continues to delete the
     * temp object and call the complete RPC.
     */
    async function runFinalizeUntilCopy(row: Record<string, unknown>): Promise<string> {
      mockRpc.mockResolvedValueOnce({ data: { ok: true, row }, error: null });
      mockList.mockResolvedValueOnce({
        data: [{ name: "test", metadata: { size: row.declared_size } }],
        error: null,
      });
      mockCreateSignedUrl.mockResolvedValueOnce({
        data: { signedUrl: "https://supabase.co/signed/test" },
        error: null,
      });

      const magicBytes = (
        row.declared_mime_type === "image/jpeg" ? JPEG_MAGIC
        : row.declared_mime_type === "image/png" ? PNG_MAGIC
        : row.declared_mime_type === "image/webp" ? WEBP_MAGIC
        : PDF_MAGIC
      );
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => magicBytes.buffer.slice(0, magicBytes.byteLength),
      });
      vi.stubGlobal("fetch", fetchMock);

      // KZQ-P0-005-c: audit-start RPC (record_storage_operation_started)
      // returns the operation ID string. Must succeed before copy.
      mockRpc.mockResolvedValueOnce({ data: "audit-op-1", error: null });
      mockCopy.mockResolvedValueOnce({ error: null });
      // KZQ-P0-005-c/d: audit-complete RPC (complete_storage_operation)
      // must succeed so the saga doesn't compensate-delete the final object.
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      mockRemove.mockResolvedValue({ data: null, error: null });
      mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

      const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
      await finalizeTempUpload({
        uploadToken: "abc12345-1234-1234-1234-123456789abc",
      });

      vi.unstubAllGlobals();

      // copy was called with (source, destination); return destination
      expect(mockCopy).toHaveBeenCalledTimes(1);
      return mockCopy.mock.calls[0][1] as string;
    }

    it("uses .jpg from MIME even when filename has .jpeg", async () => {
      const destPath = await runFinalizeUntilCopy({
        ...validClaimRow,
        final_bucket: "private-assets",
        declared_filename: "photo.jpeg",
        declared_mime_type: "image/jpeg",
      });
      expect(destPath).toMatch(/\.jpg$/);
      expect(destPath).not.toMatch(/\.jpeg$/);
    });

    it("uses .jpg from MIME when filename has wrong extension (.html)", async () => {
      // An attacker might name a JPEG file "evil.html" to try to get
      // an HTML object served. The two-stage path previously used
      // getExtensionFromFilename(declared_filename) which would have
      // produced "html". Now it uses the verified MIME → ".jpg".
      const destPath = await runFinalizeUntilCopy({
        ...validClaimRow,
        final_bucket: "private-assets",
        declared_filename: "evil.html",
        declared_mime_type: "image/jpeg",
      });
      expect(destPath).toMatch(/\.jpg$/);
      expect(destPath).not.toMatch(/\.html$/);
    });

    it("uses .jpg from MIME when filename has no extension", async () => {
      const destPath = await runFinalizeUntilCopy({
        ...validClaimRow,
        final_bucket: "private-assets",
        declared_filename: "noextension",
        declared_mime_type: "image/jpeg",
      });
      expect(destPath).toMatch(/\.jpg$/);
    });

    it("uses .jpg from MIME when filename has double extension", async () => {
      // e.g. "archive.pdf.jpg" — old code took the last extension
      // (".jpg"); new code still produces ".jpg" from MIME, so the
      // behavior is consistent regardless of how many dots the
      // filename has.
      const destPath = await runFinalizeUntilCopy({
        ...validClaimRow,
        final_bucket: "private-assets",
        declared_filename: "archive.pdf.jpg",
        declared_mime_type: "image/jpeg",
      });
      expect(destPath).toMatch(/\.jpg$/);
    });

    it("uses .png from MIME for PNG files", async () => {
      const destPath = await runFinalizeUntilCopy({
        ...validClaimRow,
        final_bucket: "private-assets",
        declared_filename: "screenshot.png",
        declared_mime_type: "image/png",
      });
      expect(destPath).toMatch(/\.png$/);
    });

    it("uses .webp from MIME for WebP files", async () => {
      const destPath = await runFinalizeUntilCopy({
        ...validClaimRow,
        final_bucket: "private-assets",
        declared_filename: "image.webp",
        declared_mime_type: "image/webp",
      });
      expect(destPath).toMatch(/\.webp$/);
    });

    it("uses .pdf from MIME for PDF files", async () => {
      const destPath = await runFinalizeUntilCopy({
        ...validClaimRow,
        final_bucket: "private-assets",
        declared_filename: "catalog.pdf",
        declared_mime_type: "application/pdf",
      });
      expect(destPath).toMatch(/\.pdf$/);
    });

    it("ignores filename extension completely — MIME is the sole source", async () => {
      // Even if the filename says ".png", the verified MIME says
      // "image/jpeg", so the final object is ".jpg". (In practice the
      // magic bytes check would reject a PNG-content file claiming to
      // be JPEG, but this test isolates the extension-derivation
      // logic: the filename extension is NEVER used for the path.)
      const destPath = await runFinalizeUntilCopy({
        ...validClaimRow,
        final_bucket: "private-assets",
        declared_filename: "misnamed.png",
        declared_mime_type: "image/jpeg",
      });
      expect(destPath).toMatch(/\.jpg$/);
      expect(destPath).not.toMatch(/\.png$/);
    });
  });

  // ============================================================
  // KZQ-P0-005-b: Unified final path generation (static contract)
  // ------------------------------------------------------------
  // Both upload paths MUST share the same final-object path
  // generation logic so they cannot drift. This is enforced by a
  // source-level contract: the two-stage service IMPORTS
  // generatePrivateStoragePath / generatePublicStoragePath from
  // storage-upload.ts rather than redefining them, and it derives
  // the extension via the shared getExtensionForMimeType (same as
  // the single-stage path does through validateUploadFile).
  //
  // If a future change re-introduces an inline path builder in
  // two-phase-upload.ts, these tests will fail and force the
  // author to either reuse the shared function or explicitly
  // justify the divergence.
  // ============================================================
  describe("KZQ-P0-005-b: final path generation is shared, not duplicated", () => {
    const TWO_PHASE_SRC = "lib/services/two-phase-upload.ts";
    const SINGLE_STAGE_SRC = "lib/services/storage-upload.ts";

    it("two-phase-upload.ts IMPORTS generatePrivateStoragePath / generatePublicStoragePath (no local redefinition)", async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(TWO_PHASE_SRC, "utf8");

      // Import statement must reference the shared service module.
      expect(src).toMatch(
        /import\s*\{[^}]*\bgeneratePrivateStoragePath\b[^}]*\}\s*from\s*["']@\/lib\/services\/storage-upload["']/,
      );
      expect(src).toMatch(
        /import\s*\{[^}]*\bgeneratePublicStoragePath\b[^}]*\}\s*from\s*["']@\/lib\/services\/storage-upload["']/,
      );

      // Must NOT redefine the functions locally — drift would appear
      // as a local `function generatePrivateStoragePath` declaration.
      expect(src).not.toMatch(
        /function\s+generatePrivateStoragePath\s*\(/,
      );
      expect(src).not.toMatch(
        /function\s+generatePublicStoragePath\s*\(/,
      );
    });

    it("storage-upload.ts EXPORTS both path generators (single source of truth)", async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(SINGLE_STAGE_SRC, "utf8");

      expect(src).toMatch(
        /export\s+function\s+generatePrivateStoragePath\s*\(/,
      );
      expect(src).toMatch(
        /export\s+function\s+generatePublicStoragePath\s*\(/,
      );
    });

    it("two-stage finalize calls the shared generators (no inline path string building)", async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(TWO_PHASE_SRC, "utf8");

      // Both branches of the bucket decision must invoke the shared
      // generator functions. We anchor on the function-call syntax
      // so an inline `${finalCategory}/${uuid}.${ext}` template
      // would fail this assertion.
      expect(src).toMatch(
        /generatePrivateStoragePath\(\s*finalCategory/,
      );
      expect(src).toMatch(
        /generatePublicStoragePath\(\s*finalCategory/,
      );
    });

    it("two-stage derives ext from shared getExtensionForMimeType (same source as single-stage)", async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(TWO_PHASE_SRC, "utf8");

      // KZQ-P0-004: ext must come from MIME, not filename.
      // KZQ-P0-005-a/b: single-stage gets ext via validateUploadFile
      // (which calls getExtensionForMimeType internally); two-stage
      // calls getExtensionForMimeType directly because validation
      // already happened at authorize time. Both share the SAME
      // mapping. Verify the import + call site.
      expect(src).toMatch(
        /import\s*\{[^}]*\bgetExtensionForMimeType\b[^}]*\}\s*from\s*["']@\/lib\/validation\/storage["']/,
      );
      expect(src).toMatch(
        /getExtensionForMimeType\(declaredMimeType\)/,
      );
    });

    it("both paths produce the same {category}/{uuid}.{ext} shape for the same inputs", async () => {
      // Behavioral parity: feed the same category + ext through the
      // shared generators used by each path. UUIDs differ per call
      // but the path SHAPE (top-folder + uuid + ext) must match.
      const { generatePrivateStoragePath, generatePublicStoragePath } =
        await import("@/lib/services/storage-upload");

      const privatePath = generatePrivateStoragePath("products", ".jpg");
      const publicPath = generatePublicStoragePath("products", ".jpg");
      expect(publicPath).not.toBeNull();

      // Shape: "products/<uuid>.jpg"
      const privateMatch = privatePath.match(
        /^products\/[0-9a-f-]{36}\.jpg$/,
      );
      const publicMatch = publicPath?.match(
        /^products\/[0-9a-f-]{36}\.jpg$/,
      );
      expect(privateMatch).not.toBeNull();
      expect(publicMatch).not.toBeNull();
    });
  });

  // ============================================================
  // KZQ-P0-005-c: Unified audit-start (fail-closed saga)
  // ------------------------------------------------------------
  // The two-stage finalize path now shares the SAME fail-closed
  // audit saga as the single-stage path. It creates a pending
  // admin_storage_operations row (via record_storage_operation_started
  // RPC) BEFORE the object is moved to its final path, and completes
  // it (via complete_storage_operation RPC) AFTER the move succeeds.
  //
  // These tests verify the saga behavior with mocked Supabase:
  //   1. audit-start failure → finalize aborts (no copy)
  //   2. copy failure → audit marked as failed
  //   3. audit-complete failure after successful copy → compensates
  //      by deleting the final object + returns error
  //   4. successful saga → both audit RPCs called, finalize succeeds
  // ============================================================
  describe("KZQ-P0-005-c: unified audit-start saga", () => {
    const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const privateRow = {
      id: "abc12345-1234-1234-1234-123456789abc",
      object_path: "temp/abc12345-1234-1234-1234-123456789abc/test.jpg",
      declared_mime_type: "image/jpeg",
      declared_size: 1024,
      declared_filename: "test.jpg",
      final_bucket: "private-assets",
      final_category: "products",
      actor_id: "admin-uuid-1",
      actor_role: "admin",
    };

    /**
     * Helper: mock the pre-audit steps (claim, list, signed URL,
     * magic bytes fetch) so the flow reaches audit-start.
     */
    function mockPreAuditSteps(row: Record<string, unknown>) {
      mockRpc.mockResolvedValueOnce({ data: { ok: true, row }, error: null });
      mockList.mockResolvedValueOnce({
        data: [{ name: "test", metadata: { size: row.declared_size } }],
        error: null,
      });
      mockCreateSignedUrl.mockResolvedValueOnce({
        data: { signedUrl: "https://supabase.co/signed/test" },
        error: null,
      });
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => JPEG_MAGIC.buffer.slice(0, JPEG_MAGIC.byteLength),
      });
      vi.stubGlobal("fetch", fetchMock);
    }

    it("audit-start failure → finalize aborts before copy (fail-closed)", async () => {
      mockPreAuditSteps(privateRow);
      // audit-start RPC returns error
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: "rpc down" } });
      // failFinalize RPC
      mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

      const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
      const result = await finalizeTempUpload({
        uploadToken: "abc12345-1234-1234-1234-123456789abc",
      });
      vi.unstubAllGlobals();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("ADMIN_WRITE_FAILED");
      }
      // copy MUST NOT have been called (fail-closed)
      expect(mockCopy).not.toHaveBeenCalled();
    });

    it("copy failure → audit marked as failed before compensation", async () => {
      mockPreAuditSteps(privateRow);
      // audit-start succeeds, returns operation ID
      mockRpc.mockResolvedValueOnce({ data: "audit-op-fail", error: null });
      // copy fails
      mockCopy.mockResolvedValueOnce({ error: { message: "storage error" } });
      // audit-complete(false) — must be called
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      // failFinalize RPC
      mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
      // NOTE: enqueueStorageCleanup is mocked at module level (vi.mock) and
      // does NOT call client.rpc, so no RPC mock is needed for it here.
      // Adding an unconsumed mockResolvedValueOnce would bleed into the
      // next test because vi.clearAllMocks() only clears history, not
      // the mock implementation queue.

      const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
      const result = await finalizeTempUpload({
        uploadToken: "abc12345-1234-1234-1234-123456789abc",
      });
      vi.unstubAllGlobals();

      expect(result.ok).toBe(false);
      expect(result.code).toBe("COPY_FAILED");
      // Verify audit-complete(false) was called via RPC
      const completeCall = mockRpc.mock.calls.find(
        (call) => call[0] === "complete_storage_operation",
      );
      expect(completeCall).toBeDefined();
      expect(completeCall![1]).toMatchObject({
        p_operation_id: "audit-op-fail",
        p_success: false,
      });
    });

    it("audit-complete failure after successful copy → compensates by deleting final object", async () => {
      mockPreAuditSteps(privateRow);
      // audit-start succeeds
      mockRpc.mockResolvedValueOnce({ data: "audit-op-comp", error: null });
      // copy succeeds
      mockCopy.mockResolvedValueOnce({ error: null });
      // audit-complete(true) FAILS
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: "rpc down" } });
      // compensate: remove the final object from private-assets
      mockRemove.mockResolvedValueOnce({ data: null, error: null });
      // failFinalize RPC
      mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
      // NOTE: enqueueStorageCleanup is mocked at module level (vi.mock) and
      // does NOT call client.rpc, so no RPC mock is needed for it here.

      const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
      const result = await finalizeTempUpload({
        uploadToken: "abc12345-1234-1234-1234-123456789abc",
      });
      vi.unstubAllGlobals();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("ADMIN_WRITE_FAILED");
      }
      // The final object MUST have been removed (compensation)
      // remove is called as remove([path]) so call[0] is the path array
      const removeCalls = mockRemove.mock.calls;
      expect(removeCalls.length).toBeGreaterThanOrEqual(1);
      // At least one remove call targets the final object path
      const finalObjectRemove = removeCalls.find(
        (call) => Array.isArray(call[0]) && call[0].some((p: string) => p.startsWith("products/")),
      );
      expect(finalObjectRemove).toBeDefined();
    });

    it("successful saga → audit-start and audit-complete both called", async () => {
      mockPreAuditSteps(privateRow);
      // audit-start succeeds, returns operation ID
      mockRpc.mockResolvedValueOnce({ data: "audit-op-ok", error: null });
      // copy succeeds
      mockCopy.mockResolvedValueOnce({ error: null });
      // audit-complete(true) succeeds
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      // temp delete
      mockRemove.mockResolvedValue({ data: null, error: null });
      // complete RPC
      mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });

      const { finalizeTempUpload } = await import("@/lib/services/two-phase-upload");
      const result = await finalizeTempUpload({
        uploadToken: "abc12345-1234-1234-1234-123456789abc",
      });
      vi.unstubAllGlobals();

      expect(result.ok).toBe(true);
      // Verify audit-start was called with correct params
      const startCall = mockRpc.mock.calls.find(
        (call) => call[0] === "record_storage_operation_started",
      );
      expect(startCall).toBeDefined();
      expect(startCall![1]).toMatchObject({
        p_action: "storage.upload",
        p_bucket: "private-assets",
        p_actor_id: "admin-uuid-1",
        p_actor_role: "admin",
      });
      // Verify audit-complete(true) was called
      const completeCall = mockRpc.mock.calls.find(
        (call) => call[0] === "complete_storage_operation",
      );
      expect(completeCall).toBeDefined();
      expect(completeCall![1]).toMatchObject({
        p_operation_id: "audit-op-ok",
        p_success: true,
      });
    });
  });
});
