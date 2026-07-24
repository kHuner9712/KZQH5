import { describe, expect, it } from "vitest";
import {
  STORAGE_PURPOSES,
  isStoragePurpose,
  resolvePurposeConfig,
} from "@/lib/services/storage-purpose";

// ============================================================
// Phase 15: Storage Purpose → Bucket 服务端映射
// ------------------------------------------------------------
// Proves:
//   1. STORAGE_PURPOSES contains exactly the 6 known purposes
//   2. isStoragePurpose accepts the 6 known purposes, rejects others
//   3. resolvePurposeConfig returns null for unknown purpose
//   4. Catalog / certificate purposes map to private-assets
//   5. Catalog / certificate purposes do NOT allow public URLs
//   6. Catalog purpose allows PDF MIME; others do NOT
//   7. Image purposes (product / project / company / homepage) map
//      to public-assets and allow public URLs
//   8. resolvePurposeConfig returns the same shape for every purpose
//   9. No purpose returns bucket='evil-bucket' (whitelist enforced)
//  10. certificate-draft only allows image MIME (no PDF)
//  11. catalog-draft allows image/jpeg, image/png, image/webp, application/pdf
//  12. Each purpose has a non-empty category string
//  13. Each purpose has a non-empty allowedMimeTypes array
// ============================================================

describe("Phase 15: Storage Purpose → Bucket mapping", () => {
  describe("STORAGE_PURPOSES whitelist", () => {
    it("contains exactly the 6 known purposes", () => {
      expect(STORAGE_PURPOSES).toEqual([
        "product-image",
        "project-image",
        "company-logo",
        "homepage-image",
        "catalog-draft",
        "certificate-draft",
      ]);
      expect(STORAGE_PURPOSES.length).toBe(6);
    });
  });

  describe("isStoragePurpose", () => {
    it.each([
      "product-image",
      "project-image",
      "company-logo",
      "homepage-image",
      "catalog-draft",
      "certificate-draft",
    ] as const)("accepts known purpose '%s'", (purpose) => {
      expect(isStoragePurpose(purpose)).toBe(true);
    });

    it.each([
      "",
      "unknown",
      "products",
      "projects",
      "catalog",
      "certificate",
      "private-assets",
      "public-assets",
      null,
      undefined,
      123,
      {},
      [],
      "PRODUCT-IMAGE",
      "product_image",
    ])("rejects unknown value %j", (value) => {
      expect(isStoragePurpose(value)).toBe(false);
    });
  });

  describe("resolvePurposeConfig", () => {
    it("returns null for unknown purpose", () => {
      expect(resolvePurposeConfig("unknown")).toBeNull();
      expect(resolvePurposeConfig(null)).toBeNull();
      expect(resolvePurposeConfig(undefined)).toBeNull();
      expect(resolvePurposeConfig(123)).toBeNull();
      expect(resolvePurposeConfig({})).toBeNull();
      expect(resolvePurposeConfig([])).toBeNull();
    });

    it("returns the same shape (PurposeConfig) for every purpose", () => {
      for (const purpose of STORAGE_PURPOSES) {
        const config = resolvePurposeConfig(purpose);
        expect(config).not.toBeNull();
        expect(typeof config!.bucket).toBe("string");
        expect(typeof config!.category).toBe("string");
        expect(typeof config!.isPublicUrlAllowed).toBe("boolean");
        expect(Array.isArray(config!.allowedMimeTypes)).toBe(true);
      }
    });

    it("catalog-draft maps to private-assets", () => {
      const config = resolvePurposeConfig("catalog-draft");
      expect(config).not.toBeNull();
      expect(config!.bucket).toBe("private-assets");
      expect(config!.category).toBe("catalogs");
    });

    it("certificate-draft maps to private-assets", () => {
      const config = resolvePurposeConfig("certificate-draft");
      expect(config).not.toBeNull();
      expect(config!.bucket).toBe("private-assets");
      expect(config!.category).toBe("certificates");
    });

    it("catalog-draft does NOT allow public URLs", () => {
      const config = resolvePurposeConfig("catalog-draft");
      expect(config!.isPublicUrlAllowed).toBe(false);
    });

    it("certificate-draft does NOT allow public URLs", () => {
      const config = resolvePurposeConfig("certificate-draft");
      expect(config!.isPublicUrlAllowed).toBe(false);
    });

    it.each([
      "product-image",
      "project-image",
      "company-logo",
      "homepage-image",
    ] as const)(
      "image purpose '%s' maps to public-assets and allows public URLs",
      (purpose) => {
        const config = resolvePurposeConfig(purpose);
        expect(config!.bucket).toBe("public-assets");
        expect(config!.isPublicUrlAllowed).toBe(true);
      },
    );

    it("catalog-draft allows image/jpeg, image/png, image/webp, application/pdf", () => {
      const config = resolvePurposeConfig("catalog-draft");
      expect(config!.allowedMimeTypes).toEqual([
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
      ]);
    });

    it("certificate-draft only allows image MIME (no PDF)", () => {
      const config = resolvePurposeConfig("certificate-draft");
      expect(config!.allowedMimeTypes).toEqual([
        "image/jpeg",
        "image/png",
        "image/webp",
      ]);
      expect(config!.allowedMimeTypes).not.toContain("application/pdf");
    });

    it("no purpose returns an unknown bucket (whitelist enforced)", () => {
      for (const purpose of STORAGE_PURPOSES) {
        const config = resolvePurposeConfig(purpose);
        expect(config!.bucket === "public-assets" || config!.bucket === "private-assets").toBe(true);
      }
    });

    it.each(STORAGE_PURPOSES as readonly unknown[])(
      "purpose '%s' has a non-empty category string",
      (purpose) => {
        const config = resolvePurposeConfig(purpose);
        expect(config!.category.length).toBeGreaterThan(0);
      },
    );

    it.each(STORAGE_PURPOSES as readonly unknown[])(
      "purpose '%s' has a non-empty allowedMimeTypes array",
      (purpose) => {
        const config = resolvePurposeConfig(purpose);
        expect(config!.allowedMimeTypes.length).toBeGreaterThan(0);
      },
    );
  });
});
