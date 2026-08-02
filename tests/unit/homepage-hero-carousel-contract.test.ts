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
    expect(component).toContain("-mt-12");
    expect(component).toContain("lg:-mt-16");
    expect(component).toContain("AUTOPLAY_MS = 6000");
    expect(component).toContain("prefers-reduced-motion: reduce");
    expect(component).toContain("onTouchStart");
    expect(component).toContain("onTouchEnd");
    expect(component).toContain("mobileImageUrl");
  });

  it("serves upload-time optimized artwork directly and defers background slides", () => {
    const component = source("components/public/HomeHeroCarousel.tsx");
    expect(component).not.toContain('from "next/image"');
    expect(component).not.toContain("getImageProps");
    expect(component).toContain("src={slide.desktopImageUrl}");
    expect(component).toContain("srcSet={slide.mobileImageUrl}");
    expect(component).toContain("renderedIndexes");
    expect(component).toContain("NEXT_SLIDE_PRELOAD_DELAY_MS = 4500");
    expect(component).toContain("firstSlideReady");
    expect(component).toContain("if (!renderedIndexes.has(index)) return null");
    expect(component).toContain('loading="eager"');
    expect(component).toContain('fetchPriority={index === 0 ? "high" : "low"}');
  });

  it("keeps controls responsive while the selected image loads", () => {
    const component = source("components/public/HomeHeroCarousel.tsx");
    expect(component).toContain("selectedIndex");
    expect(component).toContain("selectedIndexRef");
    expect(component).toContain("pendingIndexRef");
    expect(component).toContain("onClick={() => requestSlide(index)}");
    expect(component).toContain("onClick={showPrevious}");
    expect(component).toContain("onClick={showNext}");
  });

  it("keeps explicit previous and next controls available on mobile", () => {
    const component = source("components/public/HomeHeroCarousel.tsx");
    expect(component).toContain("top-[43%]");
    expect(component).toContain("md:hidden");
    expect(component).toContain("pointer-events-auto");
  });

  it("uses a transparent homepage header and restores the dark surface after scrolling", () => {
    const desktop = source("components/public/DesktopHeader.tsx");
    const mobile = source("components/public/MobileHeader.tsx");
    for (const header of [desktop, mobile]) {
      expect(header).toContain('pathname === "/"');
      expect(header).toContain("transparentAtTop");
      expect(header).toContain("bg-transparent");
      expect(header).toContain("window.scrollY");
      expect(header).toContain("backdrop-blur-xl");
    }
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
