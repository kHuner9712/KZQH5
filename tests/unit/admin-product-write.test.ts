import { describe, expect, it, beforeEach, vi } from "vitest";

// Reset the media URL allowlist cache before each test so env changes apply.
vi.mock("@/lib/services/http-security", () => ({
  UUID_PATTERN:
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
}));

import { validateProductPayload as validateProduct } from "@/lib/services/admin-product-write";

describe("validateProductPayload (Phase 2 field validation)", () => {
  beforeEach(() => {
    // Ensure no MEDIA_CDN_DOMAINS leak between tests.
    delete process.env.MEDIA_CDN_DOMAINS;
  });

  function validBase() {
    return {
      name_cn: "测试产品",
      name_en: "Test Product",
      slug: "test-product",
      category_id: "11111111-1111-4111-8111-111111111111",
      subcategory_id: null,
      summary_cn: "摘要",
      summary_en: "summary",
      description_cn: "描述",
      description_en: "desc",
      material_cn: "材料",
      material_en: "material",
      size: "1220x2440",
      fire_rating: "B级",
      eco_grade: "E0级",
      price_display_cn: "请联系销售",
      price_display_en: "Contact for quotation",
      moq: "1托",
      packaging_cn: "木箱",
      packaging_en: "wooden crate",
      logistics_cn: "海运",
      logistics_en: "sea freight",
      application_cn: "应用",
      application_en: "application",
      video_url: null,
      cover_image_url: null,
      is_featured: false,
      is_published: false,
      sort_order: 0,
    };
  }

  it("accepts a valid minimal payload", () => {
    const result = validateProduct(validBase());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBeNull();
      expect(result.value.product.name_cn).toBe("测试产品");
      expect(result.value.images).toEqual([]);
    }
  });

  it("accepts a valid UUID id for update", () => {
    const result = validateProduct({
      ...validBase(),
      id: "22222222-2222-4222-8222-222222222222",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("22222222-2222-4222-8222-222222222222");
    }
  });

  it("rejects an invalid id", () => {
    const result = validateProduct({ ...validBase(), id: "not-a-uuid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "id")).toBe(true);
    }
  });

  it("rejects empty name_cn", () => {
    const result = validateProduct({ ...validBase(), name_cn: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "name_cn")).toBe(true);
    }
  });

  it("rejects an invalid slug", () => {
    const result = validateProduct({ ...validBase(), slug: "Invalid Slug!" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "slug")).toBe(true);
    }
  });

  it("rejects non-boolean is_published", () => {
    const result = validateProduct({ ...validBase(), is_published: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "is_published")).toBe(true);
    }
  });

  it("rejects non-integer sort_order", () => {
    const result = validateProduct({ ...validBase(), sort_order: "zero" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "sort_order")).toBe(true);
    }
  });

  it("rejects negative sort_order", () => {
    const result = validateProduct({ ...validBase(), sort_order: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "sort_order")).toBe(true);
    }
  });

  it("rejects javascript: video_url", () => {
    const result = validateProduct({
      ...validBase(),
      video_url: "javascript:alert(1)",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "video_url")).toBe(true);
    }
  });

  it("rejects protocol-relative cover_image_url", () => {
    const result = validateProduct({
      ...validBase(),
      cover_image_url: "//evil.example.com/x.png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "cover_image_url")).toBe(true);
    }
  });

  it("rejects public HTTP image url", () => {
    const result = validateProduct({
      ...validBase(),
      cover_image_url: "http://evil.example.com/x.png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "cover_image_url")).toBe(true);
    }
  });

  it("accepts relative path image url", () => {
    const result = validateProduct({
      ...validBase(),
      cover_image_url: "/images/product/test.jpg",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects images array with too many items", () => {
    const images = Array.from({ length: 41 }, (_, i) => ({
      image_url: `/img/${i}.jpg`,
      alt_cn: null,
      alt_en: null,
      sort_order: i,
    }));
    const result = validateProduct({ ...validBase(), images });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "images")).toBe(true);
    }
  });

  it("rejects image with empty image_url", () => {
    const result = validateProduct({
      ...validBase(),
      images: [{ image_url: "", alt_cn: null, alt_en: null, sort_order: 0 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "images[0].image_url")).toBe(true);
    }
  });

  it("rejects image with javascript: url", () => {
    const result = validateProduct({
      ...validBase(),
      images: [{ image_url: "javascript:alert(1)", alt_cn: null, alt_en: null, sort_order: 0 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "images[0].image_url")).toBe(true);
    }
  });

  it("rejects keywords_cn that is not an array", () => {
    const result = validateProduct({ ...validBase(), keywords_cn: "not-an-array" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "keywords_cn")).toBe(true);
    }
  });

  it("rejects schema_extra that is not an object", () => {
    const result = validateProduct({ ...validBase(), schema_extra: "string" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "schema_extra")).toBe(true);
    }
  });

  it("rejects faq_cn that is not an array", () => {
    const result = validateProduct({ ...validBase(), faq_cn: { q: "a" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "faq_cn")).toBe(true);
    }
  });

  it("rejects non-object body", () => {
    const result = validateProduct("not an object");
    expect(result.ok).toBe(false);
  });

  it("accumulates multiple field errors", () => {
    const result = validateProduct({
      ...validBase(),
      name_cn: "",
      slug: "BAD SLUG",
      is_published: "yes",
      sort_order: -5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.errors.map((e) => e.field);
      expect(fields).toContain("name_cn");
      expect(fields).toContain("slug");
      expect(fields).toContain("is_published");
      expect(fields).toContain("sort_order");
    }
  });
});
