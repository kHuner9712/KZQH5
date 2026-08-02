import { describe, expect, it } from "vitest";
import { validateHomeHeroSlideArray } from "@/lib/validation/home-hero-slides";

function slide(overrides: Record<string, unknown> = {}) {
  return {
    id: "hero-1",
    enabled: true,
    desktop_image_url: "https://example.com/hero.webp",
    mobile_image_url: null,
    title_cn: "工程级板材",
    primary_cta_href: "/products",
    secondary_cta_href: "/contact",
    focal_x: 50,
    focal_y: 50,
    overlay_opacity: 0.42,
    ...overrides,
  };
}

describe("homepage hero slide validation", () => {
  it("accepts and sanitizes a valid slide", () => {
    const result = validateHomeHeroSlideArray([slide({ title_cn: "  工程级板材  " })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].title_cn).toBe("工程级板材");
    expect(result.value[0].primary_cta_href).toBe("/products");
  });

  it("rejects more than five slides", () => {
    const result = validateHomeHeroSlideArray(
      Array.from({ length: 6 }, (_, index) => slide({ id: `hero-${index}` })),
    );
    expect(result).toEqual({ ok: false, error: "hero_slides:too-many-items" });
  });

  it("rejects an enabled slide without a desktop image", () => {
    const result = validateHomeHeroSlideArray([slide({ desktop_image_url: "" })]);
    expect(result.ok).toBe(false);
  });

  it("rejects unsafe image protocols and external CTA links", () => {
    expect(
      validateHomeHeroSlideArray([slide({ desktop_image_url: "javascript:alert(1)" })]).ok,
    ).toBe(false);
    expect(
      validateHomeHeroSlideArray([slide({ primary_cta_href: "https://evil.example" })]).ok,
    ).toBe(false);
  });

  it("allows disabled draft slides without an image", () => {
    const result = validateHomeHeroSlideArray([
      slide({ enabled: false, desktop_image_url: "" }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("clamps focal point and overlay values", () => {
    const result = validateHomeHeroSlideArray([
      slide({ focal_x: 130, focal_y: -10, overlay_opacity: 0.99 }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].focal_x).toBe(100);
    expect(result.value[0].focal_y).toBe(0);
    expect(result.value[0].overlay_opacity).toBe(0.82);
  });
});
