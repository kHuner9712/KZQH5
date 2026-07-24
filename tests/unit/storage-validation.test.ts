import { describe, expect, it } from "vitest";
import {
  extractFileExtension,
  generateStoragePath,
  IMAGE_ALLOWED_MIME,
  IMAGE_MAX_SIZE,
  PUBLIC_ASSETS_ALLOWED_MIME,
  PUBLIC_ASSETS_MAX_SIZE,
  sanitizeStoragePath,
  validateFileUpload,
  validateFileSize,
  validateMimeExtensionConsistency,
  validateMimeType,
  verifyMagicBytes,
} from "@/lib/validation/storage";

// ============================================================
// Phase 4: Storage validation tests
//
// Covers:
//   1. MIME type validation (allowlist, SVG rejection)
//   2. File size validation (limits, edge cases)
//   3. Magic bytes verification (all supported types + spoofing)
//   4. Path sanitization (traversal prevention)
//   5. MIME ↔ extension consistency
//   6. Full upload validation pipeline
//   7. Storage path generation
// ============================================================

describe("Phase 4: storage validation", () => {
  // ----------------------------------------------------------
  // 1. MIME type validation
  // ----------------------------------------------------------
  describe("validateMimeType", () => {
    it("accepts allowed MIME types", () => {
      for (const mime of PUBLIC_ASSETS_ALLOWED_MIME) {
        expect(validateMimeType(mime, PUBLIC_ASSETS_ALLOWED_MIME)).toEqual({ ok: true });
      }
    });

    it("rejects SVG (stored XSS risk)", () => {
      const result = validateMimeType("image/svg+xml", PUBLIC_ASSETS_ALLOWED_MIME);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("image/svg+xml");
    });

    it("rejects HTML", () => {
      const result = validateMimeType("text/html", PUBLIC_ASSETS_ALLOWED_MIME);
      expect(result.ok).toBe(false);
    });

    it("rejects empty MIME", () => {
      const result = validateMimeType("", PUBLIC_ASSETS_ALLOWED_MIME);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("缺少");
    });

    it("rejects undefined MIME", () => {
      const result = validateMimeType(undefined as unknown as string, PUBLIC_ASSETS_ALLOWED_MIME);
      expect(result.ok).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(validateMimeType("APPLICATION/PDF", PUBLIC_ASSETS_ALLOWED_MIME)).toEqual({ ok: true });
      expect(validateMimeType("Image/JPEG", PUBLIC_ASSETS_ALLOWED_MIME)).toEqual({ ok: true });
    });
  });

  // ----------------------------------------------------------
  // 2. File size validation
  // ----------------------------------------------------------
  describe("validateFileSize", () => {
    it("accepts sizes within limit", () => {
      expect(validateFileSize(1, PUBLIC_ASSETS_MAX_SIZE)).toEqual({ ok: true });
      expect(validateFileSize(PUBLIC_ASSETS_MAX_SIZE, PUBLIC_ASSETS_MAX_SIZE)).toEqual({ ok: true });
    });

    it("rejects sizes exceeding limit", () => {
      const result = validateFileSize(PUBLIC_ASSETS_MAX_SIZE + 1, PUBLIC_ASSETS_MAX_SIZE);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("50MB");
    });

    it("rejects zero or negative sizes", () => {
      expect(validateFileSize(0, PUBLIC_ASSETS_MAX_SIZE).ok).toBe(false);
      expect(validateFileSize(-1, PUBLIC_ASSETS_MAX_SIZE).ok).toBe(false);
    });

    it("rejects NaN and Infinity", () => {
      expect(validateFileSize(NaN, PUBLIC_ASSETS_MAX_SIZE).ok).toBe(false);
      expect(validateFileSize(Infinity, PUBLIC_ASSETS_MAX_SIZE).ok).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 3. Magic bytes verification
  // ----------------------------------------------------------
  describe("verifyMagicBytes", () => {
    it("verifies PDF magic bytes (%PDF-)", () => {
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
      expect(verifyMagicBytes(bytes, "application/pdf")).toEqual({ ok: true });
    });

    it("verifies JPEG magic bytes (FF D8 FF)", () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(verifyMagicBytes(bytes, "image/jpeg")).toEqual({ ok: true });
    });

    it("verifies PNG magic bytes (89 50 4E 47...)", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(verifyMagicBytes(bytes, "image/png")).toEqual({ ok: true });
    });

    it("verifies WebP magic bytes (RIFF....WEBP)", () => {
      // RIFF + 4 size bytes + WEBP
      const bytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // "RIFF"
        0x00, 0x00, 0x00, 0x00, // file size (placeholder)
        0x57, 0x45, 0x42, 0x50, // "WEBP"
      ]);
      expect(verifyMagicBytes(bytes, "image/webp")).toEqual({ ok: true });
    });

    it("rejects HTML content with PDF MIME type (spoofing)", () => {
      // "<html>" bytes
      const bytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);
      const result = verifyMagicBytes(bytes, "application/pdf");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("不匹配");
    });

    it("rejects JavaScript content with image/jpeg MIME type (spoofing)", () => {
      // "var " bytes
      const bytes = new Uint8Array([0x76, 0x61, 0x72, 0x20]);
      const result = verifyMagicBytes(bytes, "image/jpeg");
      expect(result.ok).toBe(false);
    });

    it("rejects PNG content with JPEG MIME type", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = verifyMagicBytes(bytes, "image/jpeg");
      expect(result.ok).toBe(false);
    });

    it("rejects SVG content masquerading as PNG (magic bytes mismatch)", () => {
      // "<svg" bytes — an SVG file declared as image/png
      const svgBytes = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c]);
      const result = verifyMagicBytes(svgBytes, "image/png");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("不匹配");
    });

    it("rejects SVG content masquerading as PDF (magic bytes mismatch)", () => {
      // "<svg" bytes — an SVG file declared as application/pdf
      const svgBytes = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x3e]);
      const result = verifyMagicBytes(svgBytes, "application/pdf");
      expect(result.ok).toBe(false);
    });

    it("rejects EXE content masquerading as JPEG (PE header)", () => {
      // MZ header (Windows PE executable) declared as image/jpeg
      const exeBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      const result = verifyMagicBytes(exeBytes, "image/jpeg");
      expect(result.ok).toBe(false);
    });

    it("rejects WebP with wrong format tag (RIFF but not WEBP at offset 8)", () => {
      // RIFF + 4 size bytes + WAVE (not WEBP)
      const bytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // "RIFF"
        0x00, 0x00, 0x00, 0x00, // file size
        0x57, 0x41, 0x56, 0x45, // "WAVE" (wrong format)
      ]);
      const result = verifyMagicBytes(bytes, "image/webp");
      expect(result.ok).toBe(false);
    });

    it("rejects content shorter than 4 bytes", () => {
      const bytes = new Uint8Array([0x25, 0x50]);
      const result = verifyMagicBytes(bytes, "application/pdf");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("过短");
    });

    it("rejects empty bytes", () => {
      const bytes = new Uint8Array([]);
      const result = verifyMagicBytes(bytes, "application/pdf");
      expect(result.ok).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 4. Path sanitization
  // ----------------------------------------------------------
  describe("sanitizeStoragePath", () => {
    it("accepts normal folder names", () => {
      expect(sanitizeStoragePath("products")).toBe("products");
      expect(sanitizeStoragePath("products/images")).toBe("products/images");
    });

    it("strips leading/trailing slashes", () => {
      expect(sanitizeStoragePath("/products/")).toBe("products");
      expect(sanitizeStoragePath("///products///")).toBe("products");
    });

    it("strips whitespace", () => {
      expect(sanitizeStoragePath("  products  ")).toBe("products");
    });

    it("removes path traversal segments", () => {
      expect(sanitizeStoragePath("../etc/passwd")).toBeNull();
      expect(sanitizeStoragePath("products/../../../etc")).toBeNull();
      expect(sanitizeStoragePath("../../secret")).toBeNull();
    });

    it("removes null bytes", () => {
      const result = sanitizeStoragePath("products\0/evil");
      // The null byte is removed, but "evil" may not match the allowed char set
      // Actually "evil" matches [a-zA-Z0-9._-] so it should be "products/evil"
      // Wait, the null byte is between "products" and "/evil"
      // After removing \0: "products/evil" → "products/evil"
      expect(result).toBe("products/evil");
    });

    it("removes backslashes", () => {
      expect(sanitizeStoragePath("products\\evil")).toBe("productsevil");
    });

    it("rejects empty input", () => {
      expect(sanitizeStoragePath("")).toBeNull();
      expect(sanitizeStoragePath("   ")).toBeNull();
    });

    it("rejects input that is only slashes and dots", () => {
      expect(sanitizeStoragePath("/././.")).toBeNull();
      expect(sanitizeStoragePath("..")).toBeNull();
      expect(sanitizeStoragePath(".")).toBeNull();
    });

    it("allows dots within segment names", () => {
      expect(sanitizeStoragePath("products.v2/images")).toBe("products.v2/images");
    });

    it("rejects segments with special characters", () => {
      // Segments with semicolons, spaces, etc. cause the entire path
      // to be rejected (conservative — we don't silently filter).
      expect(sanitizeStoragePath("products; evil/images")).toBeNull();
      expect(sanitizeStoragePath("products/evil name")).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 5. MIME ↔ extension consistency
  // ----------------------------------------------------------
  describe("validateMimeExtensionConsistency", () => {
    it("accepts matching MIME and extension", () => {
      expect(validateMimeExtensionConsistency("application/pdf", ".pdf")).toEqual({ ok: true });
      expect(validateMimeExtensionConsistency("image/jpeg", ".jpg")).toEqual({ ok: true });
      expect(validateMimeExtensionConsistency("image/jpeg", ".jpeg")).toEqual({ ok: true });
      expect(validateMimeExtensionConsistency("image/png", ".png")).toEqual({ ok: true });
      expect(validateMimeExtensionConsistency("image/webp", ".webp")).toEqual({ ok: true });
    });

    it("rejects mismatched MIME and extension", () => {
      const result = validateMimeExtensionConsistency("application/pdf", ".jpg");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("pdf");
      expect(result.error).toContain("jpg");
    });

    it("accepts when either is missing (can't cross-validate)", () => {
      expect(validateMimeExtensionConsistency("", ".pdf")).toEqual({ ok: true });
      expect(validateMimeExtensionConsistency("application/pdf", "")).toEqual({ ok: true });
    });
  });

  // ----------------------------------------------------------
  // 6. Full upload validation pipeline
  // ----------------------------------------------------------
  describe("validateFileUpload", () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const htmlBytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);

    it("accepts valid PDF upload", () => {
      const result = validateFileUpload({
        mimeType: "application/pdf",
        size: 1024 * 1024,
        filename: "catalog.pdf",
        bytes: pdfBytes,
        allowedMime: PUBLIC_ASSETS_ALLOWED_MIME,
        maxSize: PUBLIC_ASSETS_MAX_SIZE,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts valid JPEG upload", () => {
      const result = validateFileUpload({
        mimeType: "image/jpeg",
        size: 500 * 1024,
        filename: "photo.jpg",
        bytes: jpegBytes,
        allowedMime: IMAGE_ALLOWED_MIME,
        maxSize: IMAGE_MAX_SIZE,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts valid PNG upload", () => {
      const result = validateFileUpload({
        mimeType: "image/png",
        size: 2 * 1024 * 1024,
        filename: "image.png",
        bytes: pngBytes,
        allowedMime: IMAGE_ALLOWED_MIME,
        maxSize: IMAGE_MAX_SIZE,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts valid WebP upload", () => {
      const result = validateFileUpload({
        mimeType: "image/webp",
        size: 800 * 1024,
        filename: "image.webp",
        bytes: webpBytes,
        allowedMime: IMAGE_ALLOWED_MIME,
        maxSize: IMAGE_MAX_SIZE,
      });
      expect(result.ok).toBe(true);
    });

    it("rejects HTML file with spoofed PDF MIME type", () => {
      const result = validateFileUpload({
        mimeType: "application/pdf",
        size: 1024,
        filename: "evil.pdf",
        bytes: htmlBytes,
        allowedMime: PUBLIC_ASSETS_ALLOWED_MIME,
        maxSize: PUBLIC_ASSETS_MAX_SIZE,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("不匹配");
    });

    it("rejects SVG (not in allowlist)", () => {
      const result = validateFileUpload({
        mimeType: "image/svg+xml",
        size: 1024,
        filename: "logo.svg",
        bytes: new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
        allowedMime: PUBLIC_ASSETS_ALLOWED_MIME,
        maxSize: PUBLIC_ASSETS_MAX_SIZE,
      });
      expect(result.ok).toBe(false);
    });

    it("rejects SVG content masquerading as PNG via full pipeline (magic bytes)", () => {
      // SVG bytes with a .png extension and image/png MIME type.
      // MIME allowlist passes, size passes, but magic bytes FAIL.
      const svgBytes = new Uint8Array([
        0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c,
        0x6e, 0x73, 0x3d, 0x22, 0x68, 0x74, 0x74, 0x70,
      ]);
      const result = validateFileUpload({
        mimeType: "image/png",
        size: 2048,
        filename: "evil-logo.png",
        bytes: svgBytes,
        allowedMime: IMAGE_ALLOWED_MIME,
        maxSize: IMAGE_MAX_SIZE,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("不匹配");
    });

    it("rejects oversized image (above IMAGE_MAX_SIZE)", () => {
      const result = validateFileUpload({
        mimeType: "image/png",
        size: IMAGE_MAX_SIZE + 1,
        filename: "huge.png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        allowedMime: IMAGE_ALLOWED_MIME,
        maxSize: IMAGE_MAX_SIZE,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("10MB");
    });

    it("rejects oversized PDF (above PUBLIC_ASSETS_MAX_SIZE)", () => {
      const result = validateFileUpload({
        mimeType: "application/pdf",
        size: PUBLIC_ASSETS_MAX_SIZE + 1,
        filename: "huge.pdf",
        bytes: pdfBytes,
        allowedMime: PUBLIC_ASSETS_ALLOWED_MIME,
        maxSize: PUBLIC_ASSETS_MAX_SIZE,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("50MB");
    });

    it("rejects folder traversal in generated storage path", () => {
      const path = generateStoragePath("../../../etc/passwd", ".pdf");
      expect(path).toBeNull();
    });

    it("rejects null-byte injection in folder name", () => {
      const path = generateStoragePath("products\0/../../etc", ".pdf");
      expect(path).toBeNull();
    });

    it("rejects oversized file", () => {
      const result = validateFileUpload({
        mimeType: "application/pdf",
        size: PUBLIC_ASSETS_MAX_SIZE + 1,
        filename: "huge.pdf",
        bytes: pdfBytes,
        allowedMime: PUBLIC_ASSETS_ALLOWED_MIME,
        maxSize: PUBLIC_ASSETS_MAX_SIZE,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("50MB");
    });

    it("rejects MIME/extension mismatch", () => {
      const result = validateFileUpload({
        mimeType: "application/pdf",
        size: 1024,
        filename: "file.jpg", // extension doesn't match MIME
        bytes: pdfBytes,
        allowedMime: PUBLIC_ASSETS_ALLOWED_MIME,
        maxSize: PUBLIC_ASSETS_MAX_SIZE,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("不匹配");
    });
  });

  // ----------------------------------------------------------
  // 7. Storage path generation
  // ----------------------------------------------------------
  describe("generateStoragePath", () => {
    it("generates a safe path with sanitized folder", () => {
      const path = generateStoragePath("products", ".pdf");
      expect(path).toMatch(/^products\/\d+-[a-z0-9]+\.pdf$/);
    });

    it("handles nested folders", () => {
      const path = generateStoragePath("products/images", ".jpg");
      expect(path).toMatch(/^products\/images\/\d+-[a-z0-9]+\.jpg$/);
    });

    it("returns null for path traversal folder", () => {
      expect(generateStoragePath("../etc", ".pdf")).toBeNull();
      expect(generateStoragePath("..", ".pdf")).toBeNull();
    });

    it("returns null for empty folder", () => {
      expect(generateStoragePath("", ".pdf")).toBeNull();
      expect(generateStoragePath("   ", ".pdf")).toBeNull();
    });

    it("sanitizes extension", () => {
      const path = generateStoragePath("products", ".PDF");
      expect(path).toMatch(/\.pdf$/);
    });

    it("handles missing extension dot", () => {
      const path = generateStoragePath("products", "pdf");
      expect(path).toMatch(/\.pdf$/);
    });
  });

  // ----------------------------------------------------------
  // 8. extractFileExtension
  // ----------------------------------------------------------
  describe("extractFileExtension", () => {
    it("extracts extension from filename", () => {
      expect(extractFileExtension("catalog.pdf")).toBe(".pdf");
      expect(extractFileExtension("photo.JPG")).toBe(".jpg");
      expect(extractFileExtension("image.webp")).toBe(".webp");
    });

    it("extracts extension from URL with query string", () => {
      expect(extractFileExtension("https://example.com/img/photo.jpg?v=1")).toBe(".jpg");
    });

    it("extracts extension from URL with hash", () => {
      expect(extractFileExtension("https://example.com/img/photo.png#section")).toBe(".png");
    });

    it("returns empty string for no extension", () => {
      expect(extractFileExtension("noextension")).toBe("");
      expect(extractFileExtension("")).toBe("");
    });
  });

  // ----------------------------------------------------------
  // 9. Constants
  // ----------------------------------------------------------
  describe("constants", () => {
    it("PUBLIC_ASSETS_ALLOWED_MIME excludes SVG", () => {
      expect(PUBLIC_ASSETS_ALLOWED_MIME).not.toContain("image/svg+xml");
    });

    it("PUBLIC_ASSETS_ALLOWED_MIME includes PDF, JPEG, PNG, WebP", () => {
      expect(PUBLIC_ASSETS_ALLOWED_MIME).toContain("application/pdf");
      expect(PUBLIC_ASSETS_ALLOWED_MIME).toContain("image/jpeg");
      expect(PUBLIC_ASSETS_ALLOWED_MIME).toContain("image/png");
      expect(PUBLIC_ASSETS_ALLOWED_MIME).toContain("image/webp");
    });

    it("IMAGE_ALLOWED_MIME is a subset of PUBLIC_ASSETS_ALLOWED_MIME", () => {
      for (const mime of IMAGE_ALLOWED_MIME) {
        expect(PUBLIC_ASSETS_ALLOWED_MIME).toContain(mime);
      }
    });

    it("PUBLIC_ASSETS_MAX_SIZE is 50MB", () => {
      expect(PUBLIC_ASSETS_MAX_SIZE).toBe(50 * 1024 * 1024);
    });

    it("IMAGE_MAX_SIZE is 10MB", () => {
      expect(IMAGE_MAX_SIZE).toBe(10 * 1024 * 1024);
    });
  });
});
