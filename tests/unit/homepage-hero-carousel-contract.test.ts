import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("homepage hero carousel contract", () => {
  it("uses a viewport-height hero with autoplay, reduced-motion and swipe support", () => {
    const component = source("components/public/HomeHeroCarousel.tsx");
    expect(component).toContain("100svh");
    expect(component).toContain("AUTOPLAY_MS = 6000");
    expect(component).toContain("prefers-reduced-motion: reduce");
    expect(component).toContain("onTouchStart");
    expect(component).toContain("onTouchEnd");
    expect(component).toContain("mobileImageUrl");
  });

  it("renders CMS slides and retains the default artwork fallback", () => {
    const page = source("components/public/pages/HomePage.tsx");
    expect(page).toContain("homepageContent?.hero_slides");
    expect(page).toContain("HOME_HERO_ARTWORK");
    expect(page).toContain("HomeHeroCarousel");
    expect(page).toContain("certificates_section_title");
    expect(page).toContain("projects_section_title");
    expect(page).toContain("bottom_cta_button_text");
  });

  it("reuses the trusted homepage-image upload path in the admin CMS", () => {
    const admin = source("app/admin/(protected)/homepage/page.tsx");
    expect(admin).toContain('purpose="homepage-image"');
    expect(admin).toContain("desktop_image_url");
    expect(admin).toContain("mobile_image_url");
    expect(admin).toContain("最多配置 5 张轮播图");
  });

  it("validates slides at the API boundary before the transactional RPC", () => {
    const route = source("app/api/admin/homepage/route.ts");
    expect(route).toContain("validateHomeHeroSlideArray");
    expect(route).toContain("saveHomepageContentV2");
    expect(route).toContain("requireAdminWrite");
  });
});
