import { describe, expect, it } from "vitest";
import { findCatalogTopicAsset, findCatalogTopicAssets } from "@/lib/catalog-assets";
import { catalogTopicSections, catalogTopics } from "@/lib/catalog-topics";
import type { ProductAsset } from "@/types/database";

function asset(overrides: Partial<ProductAsset> = {}): ProductAsset {
  return {
    id: "asset-1",
    product_id: null,
    asset_type: "catalog",
    catalog_topic_id: null,
    title_cn: "测试资料",
    title_en: "Test Document",
    description_cn: null,
    description_en: null,
    file_url: "/test.pdf",
    cover_image_url: null,
    file_size: 100,
    mime_type: "application/pdf",
    published_at: null,
    content_hash: null,
    is_published: true,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("catalog topic manifest", () => {
  it("contains exactly 21 unique core topics", () => {
    expect(catalogTopics).toHaveLength(21);
    expect(new Set(catalogTopics.map((topic) => topic.id)).size).toBe(21);
  });

  it("contains complete localized copy and valid sections", () => {
    const sectionIds = new Set(catalogTopicSections.map((section) => section.id));
    for (const topic of catalogTopics) {
      expect(topic.titleCn.trim()).not.toBe("");
      expect(topic.titleEn.trim()).not.toBe("");
      expect(topic.aliases.length).toBeGreaterThan(0);
      expect(sectionIds.has(topic.section)).toBe(true);
    }
  });
});

describe("catalog asset matching", () => {
  const wallPanel = catalogTopics.find((topic) => topic.id === "wpc-wall-panel")!;

  it("prefers exact catalog_topic_id matches over legacy title matches", () => {
    const legacy = asset({ id: "legacy", title_cn: "WPC 墙板综合目录" });
    const exact = asset({ id: "exact", catalog_topic_id: "wpc-wall-panel", title_cn: "任意标题" });
    expect(findCatalogTopicAsset(wallPanel, [legacy, exact])?.id).toBe("exact");
  });

  it("supports Chinese and English legacy titles", () => {
    expect(findCatalogTopicAsset(wallPanel, [asset({ title_cn: "WPC 墙板综合目录" })])).not.toBeNull();
    expect(findCatalogTopicAsset(wallPanel, [asset({ title_cn: "其他", title_en: "WPC Wall Panel Catalog" })])).not.toBeNull();
  });

  it("does not use legacy matching when a different topic id is present", () => {
    const wrong = asset({ catalog_topic_id: "wpc-door-series", title_cn: "WPC 墙板综合目录" });
    expect(findCatalogTopicAsset(wallPanel, [wrong])).toBeNull();
  });

  it("selects the newest published version and then sort order", () => {
    const rows = [
      asset({ id: "old", catalog_topic_id: wallPanel.id, published_at: "2025-01-01", sort_order: 1 }),
      asset({ id: "new-high-sort", catalog_topic_id: wallPanel.id, published_at: "2026-01-01", sort_order: 20 }),
      asset({ id: "new-low-sort", catalog_topic_id: wallPanel.id, published_at: "2026-01-01", sort_order: 5 }),
    ];
    expect(findCatalogTopicAssets(wallPanel, rows).map((row) => row.id)).toEqual([
      "new-low-sort",
      "new-high-sort",
      "old",
    ]);
  });
});
