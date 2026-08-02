import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("homepage Hero asset lifecycle", () => {
  it("always converts homepage uploads to bounded WebP", () => {
    const component = source("components/admin/ImageUpload.tsx");
    expect(component).toContain('purpose === "homepage-image"');
    expect(component).toContain('canvas.toBlob(resolve, "image/webp"');
    expect(component).toContain("MAX_HOMEPAGE_IMAGE_BYTES = 700 * 1024");
    expect(component).toContain('"hero-desktop"');
    expect(component).toContain('"hero-mobile"');
  });

  it("rejects unoptimized homepage uploads at the trusted route", () => {
    const route = source("app/api/admin/storage/upload/route.ts");
    expect(route).toContain('file.type !== "image/webp"');
    expect(route).toContain("MAX_HOMEPAGE_IMAGE_BYTES");
    expect(route).toContain('purpose === "homepage-image"');
  });

  it("processes superseded desktop and mobile objects after the database save", () => {
    const route = source("app/api/admin/homepage/route.ts");
    const lifecycle = source("lib/services/homepage-hero-assets.ts");
    expect(route).toContain("processRemovedHomepageHeroAssets");
    expect(lifecycle).toContain("desktop_image_url");
    expect(lifecycle).toContain("mobile_image_url");
    expect(lifecycle).toContain("claim_storage_cleanup_object");
    expect(lifecycle).toContain("isReferencedStorageObject");
    expect(lifecycle).toContain("deletePublicAsset");
    expect(lifecycle).toContain('finalStatus: "deleted"');
  });

  it("adds homepage JSONB references to the database deletion guard", () => {
    const migration = source(
      "supabase/migrations/20260803013000_homepage_hero_asset_lifecycle.sql",
    );
    expect(migration).toContain("public.homepage_content");
    expect(migration).toContain("desktop_image_url");
    expect(migration).toContain("mobile_image_url");
    expect(migration).toContain("claim_storage_cleanup_object");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("to service_role");
  });
});
