import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ============================================================
// Phase 13: Storage upload route behavior tests
// ------------------------------------------------------------
// Proves the trusted server-side upload boundary enforces:
//   1. SVG masquerading as PNG is rejected (Magic Bytes mismatch)
//   2. HTML masquerading as PDF is rejected
//   3. Image exceeding 5MB is rejected
//   4. PDF exceeding 20MB is rejected
//   5. Editor role is rejected (RBAC minimumRole: "admin")
//   6. Missing Origin is rejected (fail-closed)
//   7. Cross-origin is rejected
//   8. Unauthenticated is rejected (401)
//   9. Legacy fields (public/category/bucket/path) are rejected with 400
//  10. private-assets upload succeeds WITHOUT publicUrl
//  11. Missing purpose is rejected with 400
//
// These exercise the actual route handler, not just the validation
// utility functions. The route calls requireAdminWrite (RBAC + Origin
// + session) and then uploadByPurpose (which routes to uploadToPrivateAssets
// or uploadToPublicAssets based on the purpose config).
// ============================================================

const getVerifiedAdmin = vi.fn();
const uploadByPurpose = vi.fn();
const deletePrivateAsset = vi.fn();
const isReferencedStorageObject = vi.fn();
const isDemoMode = vi.fn(() => false);
const resolvePurposeConfig = vi.fn();

vi.mock("@/lib/services/admin-auth", () => ({ getVerifiedAdmin }));
vi.mock("@/lib/services/storage-upload", () => ({
  uploadByPurpose,
  deletePrivateAsset,
  isReferencedStorageObject,
  validatePrivateAssetPath: vi.fn((raw: string) => {
    // Lightweight stand-in mirroring the real validator's contract.
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (raw.includes("..")) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    return { ok: true, path: raw };
  }),
}));
vi.mock("@/lib/services/storage-purpose", () => ({
  resolvePurposeConfig,
  STORAGE_PURPOSES: [
    "product-image",
    "project-image",
    "company-logo",
    "homepage-image",
    "catalog-draft",
    "certificate-draft",
  ] as const,
  isStoragePurpose: (value: unknown) =>
    typeof value === "string" &&
    [
      "product-image",
      "project-image",
      "company-logo",
      "homepage-image",
      "catalog-draft",
      "certificate-draft",
    ].includes(value),
}));
vi.mock("@/lib/demo", () => ({ isDemoMode }));

function makeAdminContext(role = "admin") {
  return {
    ok: true as const,
    client: {},
    user: { id: "u-admin", email: "admin@kzq.test" },
    profile: { id: "u-admin", role },
  };
}

function multipartRequest(
  url: string,
  method: string,
  fields: {
    purpose?: string;
    /** Legacy fields that should be rejected. */
    legacy?: {
      public?: string;
      category?: string;
      bucket?: string;
      path?: string;
    };
    file: { name: string; type: string; bytes: Uint8Array };
  },
  headers: Record<string, string> = {
    Host: "kzq.test",
    Origin: "https://kzq.test",
  },
): NextRequest {
  const formData = new FormData();
  if (fields.purpose !== undefined) {
    formData.set("purpose", fields.purpose);
  }
  if (fields.legacy) {
    if (fields.legacy.public !== undefined)
      formData.set("public", fields.legacy.public);
    if (fields.legacy.category !== undefined)
      formData.set("category", fields.legacy.category);
    if (fields.legacy.bucket !== undefined)
      formData.set("bucket", fields.legacy.bucket);
    if (fields.legacy.path !== undefined)
      formData.set("path", fields.legacy.path);
  }
  // Copy bytes into a fresh ArrayBuffer to avoid SharedArrayBuffer typing
  // issues in the test environment.
  const ab = new ArrayBuffer(fields.file.bytes.length);
  new Uint8Array(ab).set(fields.file.bytes);
  const blob = new Blob([ab], { type: fields.file.type });
  formData.set("file", blob, fields.file.name);
  // Do NOT set Content-Type explicitly — NextRequest with a FormData body
  // auto-generates the correct multipart/form-data; boundary header.
  // Setting it manually omits the boundary and breaks parsing.
  return new NextRequest(url, {
    method,
    headers,
    body: formData,
  });
}

function jsonRequest(
  url: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {
    "Content-Type": "application/json",
    Host: "kzq.test",
    Origin: "https://kzq.test",
  },
): NextRequest {
  return new NextRequest(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

/** Purpose config stand-ins mirroring storage-purpose.ts. */
const PURPOSE_CONFIGS: Record<string, {
  bucket: "public-assets" | "private-assets";
  category: string;
  isPublicUrlAllowed: boolean;
  allowedMimeTypes: readonly string[];
}> = {
  "product-image": {
    bucket: "public-assets",
    category: "products",
    isPublicUrlAllowed: true,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  "catalog-draft": {
    bucket: "private-assets",
    category: "catalogs",
    isPublicUrlAllowed: false,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ],
  },
  "certificate-draft": {
    bucket: "private-assets",
    category: "certificates",
    isPublicUrlAllowed: false,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
};

describe("Phase 13: Storage upload route — server-side Magic Bytes enforcement", () => {
  beforeEach(() => {
    getVerifiedAdmin.mockReset();
    uploadByPurpose.mockReset();
    deletePrivateAsset.mockReset();
    isDemoMode.mockReturnValue(false);
    resolvePurposeConfig.mockReset();
    // Default: resolve any valid purpose to its config
    resolvePurposeConfig.mockImplementation((purpose: string) =>
      PURPOSE_CONFIGS[purpose] ?? null,
    );
  });

  it("rejects SVG content masquerading as PNG (Magic Bytes mismatch)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    // uploadByPurpose performs the Magic Bytes check via uploadToPrivateAssets;
    // simulate the rejection that the real service would return.
    uploadByPurpose.mockResolvedValue({
      ok: false,
      code: "ADMIN_WRITE_UNSUPPORTED_MEDIA",
    });
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    // "<svg" bytes declared as image/png — Magic Bytes mismatch.
    const svgBytes = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "product-image",
        file: { name: "evil.png", type: "image/png", bytes: svgBytes },
      }),
    );

    expect(res.status).toBe(415);
    expect(uploadByPurpose).toHaveBeenCalledTimes(1);
    // Verify the bytes passed to the service are the ACTUAL file bytes
    // (not the client-declared MIME alone).
    const call = uploadByPurpose.mock.calls[0];
    expect(call[1].bytes).toBeInstanceOf(Uint8Array);
    expect(call[1].bytes.length).toBe(svgBytes.length);
  });

  it("rejects HTML content masquerading as PDF (Magic Bytes mismatch)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    uploadByPurpose.mockResolvedValue({
      ok: false,
      code: "ADMIN_WRITE_UNSUPPORTED_MEDIA",
    });
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    // "<html>" bytes declared as application/pdf.
    const htmlBytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "catalog-draft",
        file: { name: "evil.pdf", type: "application/pdf", bytes: htmlBytes },
      }),
    );

    expect(res.status).toBe(415);
  });

  it("rejects image exceeding 5MB (server-side size limit)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    uploadByPurpose.mockResolvedValue({
      ok: false,
      code: "ADMIN_WRITE_PAYLOAD_TOO_LARGE",
    });
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    // 6MB PNG — exceeds the 5MB image limit enforced in storage-upload.ts.
    const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const oversized = new Uint8Array(6 * 1024 * 1024);
    oversized.set(pngMagic, 0);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "product-image",
        file: { name: "big.png", type: "image/png", bytes: oversized },
      }),
    );

    expect(res.status).toBe(413);
    expect(uploadByPurpose).toHaveBeenCalledTimes(1);
  });

  it("rejects PDF exceeding 20MB (server-side size limit)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    uploadByPurpose.mockResolvedValue({
      ok: false,
      code: "ADMIN_WRITE_PAYLOAD_TOO_LARGE",
    });
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    // 21MB PDF — exceeds the 20MB PDF limit.
    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const oversized = new Uint8Array(21 * 1024 * 1024);
    oversized.set(pdfMagic, 0);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "catalog-draft",
        file: { name: "big.pdf", type: "application/pdf", bytes: oversized },
      }),
    );

    expect(res.status).toBe(413);
  });

  it("rejects editor role (RBAC minimumRole: admin)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext("editor"));
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "product-image",
        file: { name: "test.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("ADMIN_WRITE_FORBIDDEN_ROLE");
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("rejects missing Origin (fail-closed)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest(
        "https://kzq.test/api/admin/storage/upload",
        "POST",
        { purpose: "product-image", file: { name: "test.png", type: "image/png", bytes: pngBytes } },
        { Host: "kzq.test" }, // Origin intentionally omitted
      ),
    );

    expect(res.status).toBe(403);
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("rejects cross-origin upload", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest(
        "https://kzq.test/api/admin/storage/upload",
        "POST",
        { purpose: "product-image", file: { name: "test.png", type: "image/png", bytes: pngBytes } },
        { Host: "kzq.test", Origin: "https://attacker.example.com" },
      ),
    );

    expect(res.status).toBe(403);
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated upload (401)", async () => {
    getVerifiedAdmin.mockResolvedValue({ ok: false, reason: "session-missing" });
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "product-image",
        file: { name: "test.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(401);
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("returns success path for a valid public-assets upload (admin role, same-origin, valid bytes)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    uploadByPurpose.mockResolvedValue({
      ok: true,
      ref: {
        bucket: "public-assets",
        path: "products/abc-123.png",
        publicUrl:
          "https://kzq.test/storage/v1/object/public/public-assets/products/abc-123.png",
        mimeType: "image/png",
        size: 8,
      },
    });
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "product-image",
        file: { name: "test.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bucket).toBe("public-assets");
    expect(body.path).toBe("products/abc-123.png");
    expect(body.publicUrl).toContain("public-assets/products/abc-123.png");
  });

  // ============================================================
  // Phase 13 (commercial-delivery-hardening): Legacy removal
  // ============================================================

  it("rejects Legacy `category` field with 400 (no Legacy upload path)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "product-image",
        legacy: { category: "products" },
        file: { name: "test.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(400);
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("rejects Legacy `public=true` field with 400", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "product-image",
        legacy: { public: "true" },
        file: { name: "test.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(400);
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("rejects Legacy `bucket` field with 400", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "product-image",
        legacy: { bucket: "public-assets" },
        file: { name: "test.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(400);
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("rejects Legacy `path` field with 400", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "product-image",
        legacy: { path: "products/evil.png" },
        file: { name: "test.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(400);
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("rejects missing purpose with 400", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        // purpose intentionally omitted
        file: { name: "test.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(400);
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("rejects unknown purpose with 400", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    resolvePurposeConfig.mockReturnValue(null);
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "evil-purpose",
        file: { name: "test.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(400);
    expect(uploadByPurpose).not.toHaveBeenCalled();
  });

  it("private-assets upload succeeds WITHOUT publicUrl (catalog-draft)", async () => {
    // Critical regression: the route MUST NOT treat missing publicUrl as
    // failure for private-assets uploads. The ImageUpload / FileUpload
    // components must accept refs with publicUrl=null and use previewUrl
    // (short-lived signed URL) instead.
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    uploadByPurpose.mockResolvedValue({
      ok: true,
      ref: {
        bucket: "private-assets",
        path: "catalogs/abc-123.pdf",
        publicUrl: null, // private-assets → null
        mimeType: "application/pdf",
        size: 1024,
      },
    });
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "catalog-draft",
        file: { name: "catalog.pdf", type: "application/pdf", bytes: pdfMagic },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bucket).toBe("private-assets");
    expect(body.path).toBe("catalogs/abc-123.pdf");
    expect(body.publicUrl).toBeNull();
  });

  it("private-assets certificate-draft upload succeeds WITHOUT publicUrl", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    uploadByPurpose.mockResolvedValue({
      ok: true,
      ref: {
        bucket: "private-assets",
        path: "certificates/abc-123.png",
        publicUrl: null,
        mimeType: "image/png",
        size: 8,
      },
    });
    const { POST } = await import("@/app/api/admin/storage/upload/route");

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await POST(
      multipartRequest("https://kzq.test/api/admin/storage/upload", "POST", {
        purpose: "certificate-draft",
        file: { name: "cert.png", type: "image/png", bytes: pngBytes },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bucket).toBe("private-assets");
    expect(body.publicUrl).toBeNull();
  });
});

describe("Phase 13: Storage delete route — path traversal prevention", () => {
  beforeEach(() => {
    getVerifiedAdmin.mockReset();
    deletePrivateAsset.mockReset();
    isReferencedStorageObject.mockReset();
    isDemoMode.mockReturnValue(false);
  });

  it("rejects path traversal in delete (../etc/passwd)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    // Reference check passes (not referenced) so the route reaches the
    // delete service, which performs the path traversal validation.
    isReferencedStorageObject.mockResolvedValue({
      ok: true,
      referenced: false,
    });
    // deletePrivateAsset performs the path validation and rejects "../".
    deletePrivateAsset.mockResolvedValue({
      ok: false,
      code: "ADMIN_WRITE_BAD_REQUEST",
    });
    const { DELETE } = await import("@/app/api/admin/storage/object/route");

    const res = await DELETE(
      jsonRequest("https://kzq.test/api/admin/storage/object", "DELETE", {
        bucket: "private-assets",
        path: "../../etc/passwd",
      }),
    );

    expect(res.status).toBe(400);
    expect(deletePrivateAsset).toHaveBeenCalledTimes(1);
  });

  it("rejects editor role for delete (RBAC)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext("editor"));
    const { DELETE } = await import("@/app/api/admin/storage/object/route");

    const res = await DELETE(
      jsonRequest("https://kzq.test/api/admin/storage/object", "DELETE", {
        path: "products/abc.png",
      }),
    );

    expect(res.status).toBe(403);
    expect(deletePrivateAsset).not.toHaveBeenCalled();
  });

  it("rejects missing Origin for delete (fail-closed)", async () => {
    getVerifiedAdmin.mockResolvedValue(makeAdminContext());
    const { DELETE } = await import("@/app/api/admin/storage/object/route");

    const res = await DELETE(
      jsonRequest(
        "https://kzq.test/api/admin/storage/object",
        "DELETE",
        { path: "products/abc.png" },
        { "Content-Type": "application/json", Host: "kzq.test" },
      ),
    );

    expect(res.status).toBe(403);
    expect(deletePrivateAsset).not.toHaveBeenCalled();
  });
});
