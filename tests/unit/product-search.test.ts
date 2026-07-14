import { describe, expect, it } from "vitest";
import { mockProducts } from "@/lib/mock-data";
import {
  normalizeProductSearch,
  searchProductsInMemory,
} from "@/lib/services/products/search";

describe("product search", () => {
  it.each([
    ["1220×2440×9", "1220x2440x9"],
    ["1220*2440*9", "1220x2440x9"],
    ["1220 x 2440 x 9", "1220x2440x9"],
    [" Fire，Board！ ", "fireboard"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeProductSearch(input)).toBe(expected);
  });

  it.each([
    ["玻镁防火板"],
    ["Magnesium Fire Board"],
    ["kzq-magnesium-fire-board-1220x2440x9"],
    ["1220*2440*9"],
  ])("finds Chinese, English, slug/model and sizes for %s", (query) => {
    const result = searchProductsInMemory(mockProducts, {
      query,
      page: 1,
      pageSize: 24,
    });
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("filters by category and subcategory", () => {
    const product = mockProducts.find((item) => item.subcategory_id);
    expect(product).toBeDefined();
    const result = searchProductsInMemory(mockProducts, {
      categoryId: product!.category_id,
      subcategoryId: product!.subcategory_id,
      page: 1,
      pageSize: 24,
    });
    expect(result.items.length).toBeGreaterThan(0);
    expect(
      result.items.every((item) => item.category_id === product!.category_id),
    ).toBe(true);
    expect(
      result.items.every(
        (item) => item.subcategory_id === product!.subcategory_id,
      ),
    ).toBe(true);
  });

  it("clamps out-of-range pagination to the last page", () => {
    const result = searchProductsInMemory(mockProducts, {
      page: 999,
      pageSize: 3,
    });
    expect(result.total).toBeGreaterThan(3);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(3);
  });
});
