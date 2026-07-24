import { describe, expect, it } from "vitest";
import { searchProductsInMemory, normalizeProductSearch } from "@/lib/services/products/search";
import type { Product } from "@/types/database";

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    slug: "test-board",
    name_cn: "测试板材",
    name_en: "Test Board",
    summary_cn: "工程板材",
    summary_en: "Engineering board",
    description_cn: null,
    description_en: null,
    cover_image_url: null,
    video_url: null,
    category_id: "cat-1",
    subcategory_id: null,
    size: "1220×2440mm",
    material_cn: "WPC",
    material_en: "WPC",
    packaging_cn: null,
    packaging_en: null,
    logistics_cn: null,
    logistics_en: null,
    application_cn: null,
    application_en: null,
    moq: null,
    price_display_cn: null,
    price_display_en: null,
    fire_rating: "B级",
    eco_grade: "E0级",
    is_featured: false,
    is_published: true,
    sort_order: 0,
    seo_title_cn: null,
    seo_title_en: null,
    seo_description_cn: null,
    seo_description_en: null,
    geo_summary_cn: null,
    geo_summary_en: null,
    faq_cn: null,
    faq_en: null,
    search_aliases: [],
    keywords_cn: [],
    keywords_en: [],
    schema_extra: null,
    search_document: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeProductSearch", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeProductSearch("Fire, Board!")).toBe("fireboard");
  });

  it("truncates to 120 characters", () => {
    const long = "a".repeat(200);
    expect(normalizeProductSearch(long)).toHaveLength(120);
  });

  it("normalizes multiplication signs to x", () => {
    expect(normalizeProductSearch("1220×2440")).toBe("1220x2440");
    expect(normalizeProductSearch("1220＊2440")).toBe("1220x2440");
  });

  it("returns empty string for null/undefined", () => {
    expect(normalizeProductSearch(null)).toBe("");
    expect(normalizeProductSearch(undefined)).toBe("");
  });
});

describe("searchProductsInMemory — public status filtering", () => {
  it("excludes unpublished products from results", () => {
    const products = [
      makeProduct({ id: "pub", slug: "pub", is_published: true }),
      makeProduct({ id: "draft", slug: "draft", is_published: false }),
    ];
    const result = searchProductsInMemory(products, { page: 1, pageSize: 24 });
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe("pub");
  });

  it("never returns an unpublished product even when it matches the query", () => {
    const products = [
      makeProduct({
        id: "draft-fire",
        slug: "fire-board",
        name_cn: "防火板",
        is_published: false,
      }),
    ];
    const result = searchProductsInMemory(products, {
      query: "防火板",
      page: 1,
      pageSize: 24,
    });
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("returns only published products when mixed", () => {
    const products = [
      makeProduct({ id: "p1", slug: "a", is_published: true }),
      makeProduct({ id: "p2", slug: "b", is_published: false }),
      makeProduct({ id: "p3", slug: "c", is_published: true }),
    ];
    const result = searchProductsInMemory(products, { page: 1, pageSize: 24 });
    expect(result.total).toBe(2);
    expect(result.items.map((p) => p.id)).toEqual(["p1", "p3"]);
  });
});

describe("searchProductsInMemory — category and search", () => {
  it("filters by category id", () => {
    const products = [
      makeProduct({ id: "p1", category_id: "cat-a" }),
      makeProduct({ id: "p2", category_id: "cat-b" }),
    ];
    const result = searchProductsInMemory(products, {
      categoryId: "cat-a",
      page: 1,
      pageSize: 24,
    });
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe("p1");
  });

  it("matches by Chinese name", () => {
    const products = [
      makeProduct({ id: "p1", name_cn: "防火板", slug: "fire-board" }),
      makeProduct({ id: "p2", name_cn: "墙板", slug: "wall-panel" }),
    ];
    const result = searchProductsInMemory(products, {
      query: "防火",
      page: 1,
      pageSize: 24,
    });
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe("p1");
  });

  it("matches by English name", () => {
    const products = [
      makeProduct({ id: "p1", name_en: "Fire Board", slug: "fire" }),
      makeProduct({ id: "p2", name_en: "Wall Panel", slug: "wall" }),
    ];
    const result = searchProductsInMemory(products, {
      query: "fire",
      page: 1,
      pageSize: 24,
    });
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe("p1");
  });

  it("prioritises exact slug matches", () => {
    const products = [
      makeProduct({ id: "p1", name_cn: "防火板配件", slug: "accessory" }),
      makeProduct({ id: "p2", name_cn: "防火板", slug: "fire-board" }),
    ];
    const result = searchProductsInMemory(products, {
      query: "fire-board",
      page: 1,
      pageSize: 24,
    });
    expect(result.items[0].id).toBe("p2");
  });

  it("paginates results correctly", () => {
    const products = Array.from({ length: 30 }, (_, i) =>
      makeProduct({ id: `p${i}`, slug: `slug-${i}`, sort_order: i }),
    );
    const page1 = searchProductsInMemory(products, { page: 1, pageSize: 10 });
    const page2 = searchProductsInMemory(products, { page: 2, pageSize: 10 });
    expect(page1.total).toBe(30);
    expect(page1.items).toHaveLength(10);
    expect(page2.items).toHaveLength(10);
    expect(page1.items[0].id).toBe("p0");
    expect(page2.items[0].id).toBe("p10");
  });

  it("returns empty result for no matches", () => {
    const products = [makeProduct({ id: "p1", name_cn: "防火板" })];
    const result = searchProductsInMemory(products, {
      query: "不存在的产品",
      page: 1,
      pageSize: 24,
    });
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });
});
