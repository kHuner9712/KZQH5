import { describe, expect, it } from "vitest";
import {
  isUuid,
  validateOptionalUuid,
  validateUuid,
} from "@/lib/validation/admin-write";
import { validateProductPayload } from "@/lib/services/admin-product-write";

const PRODUCT_ID = "33333333-3333-3333-3333-333333333301";
const CATEGORY_ID = "11111111-1111-1111-1111-111111111101";
const SUBCATEGORY_ID = "22222222-2222-2222-2222-222222222201";

describe("admin PostgreSQL UUID validation", () => {
  it("accepts canonical PostgreSQL UUID values without RFC version bits", () => {
    expect(isUuid(PRODUCT_ID)).toBe(true);
    expect(validateUuid("id", PRODUCT_ID)).toEqual({
      ok: true,
      value: PRODUCT_ID,
    });
    expect(validateOptionalUuid("category_id", CATEGORY_ID)).toEqual({
      ok: true,
      value: CATEGORY_ID,
    });
  });

  it("still rejects malformed or non-hex identifiers", () => {
    for (const value of [
      "33333333333333333333333333333301",
      "33333333-3333-3333-3333-33333333330z",
      "33333333-3333-3333-3333-333333333301-extra",
      "not-a-uuid",
      "",
    ]) {
      expect(isUuid(value)).toBe(false);
    }
  });

  it("allows an existing seeded product and taxonomy IDs through the write validator", () => {
    const result = validateProductPayload({
      id: PRODUCT_ID,
      expected_updated_at: "2026-08-03T00:00:00.000Z",
      name_cn: "竹炭木饰面板",
      name_en: "Bamboo-Charcoal Veneer Panel",
      slug: "bamboo-charcoal-veneer-panel",
      category_id: CATEGORY_ID,
      subcategory_id: SUBCATEGORY_ID,
      summary_cn: null,
      summary_en: null,
      description_cn: null,
      description_en: null,
      material_cn: null,
      material_en: null,
      size: null,
      fire_rating: null,
      eco_grade: null,
      price_display_cn: null,
      price_display_en: null,
      moq: null,
      packaging_cn: null,
      packaging_en: null,
      logistics_cn: null,
      logistics_en: null,
      application_cn: null,
      application_en: null,
      video_url: null,
      cover_image_url: null,
      is_featured: false,
      is_published: true,
      sort_order: 0,
      seo_title_cn: null,
      seo_title_en: null,
      seo_description_cn: null,
      seo_description_en: null,
      geo_summary_cn: null,
      geo_summary_en: null,
      keywords_cn: null,
      keywords_en: null,
      search_aliases: null,
      schema_extra: null,
      faq_cn: null,
      faq_en: null,
      images: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(PRODUCT_ID);
      expect(result.value.product.category_id).toBe(CATEGORY_ID);
      expect(result.value.product.subcategory_id).toBe(SUBCATEGORY_ID);
    }
  });
});
