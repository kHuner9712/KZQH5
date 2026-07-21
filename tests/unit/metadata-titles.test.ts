import { describe, expect, it } from "vitest";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";

describe("buildLocalizedMetadata — title templating rules", () => {
  it("returns page-name title as a plain string (lets layout template apply)", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/documents",
      title: "产品目录与色卡",
      description: "desc",
    });
    // Plain string → root layout applies template → "产品目录与色卡 | KZQ"
    expect(typeof m.title).toBe("string");
    expect(m.title).toBe("产品目录与色卡");
  });

  it("strips trailing '| KZQ' from page-level title to avoid duplicate suffix", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/documents",
      title: "产品目录与色卡 | KZQ",
      description: "desc",
    });
    // After strip: "产品目录与色卡" → template will append "| KZQ" exactly once
    expect(m.title).toBe("产品目录与色卡");
  });

  it("strips trailing ' | KZQ ' with surrounding whitespace", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/documents",
      title: "产品目录与色卡 | KZQ   ",
      description: "desc",
    });
    expect(m.title).toBe("产品目录与色卡");
  });

  it("returns { absolute } when title already contains KZQ (bypasses template)", () => {
    const m = buildLocalizedMetadata({
      locale: "en",
      path: "/about",
      title: "About KZQ | Engineering Board Brand",
      description: "desc",
    });
    // Title contains KZQ → bypass template → final HTML title is the absolute
    // string itself, no "| KZQ" suffix appended by the layout.
    expect(typeof m.title).toBe("object");
    expect((m.title as { absolute: string }).absolute).toBe(
      "About KZQ | Engineering Board Brand",
    );
  });

  it("handles home page brand title 'KZQ | 工程级板材' as absolute", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/",
      title: "KZQ | 工程级板材·B级防火·E0环保饰面板",
      description: "desc",
    });
    expect(typeof m.title).toBe("object");
    expect((m.title as { absolute: string }).absolute).toBe(
      "KZQ | 工程级板材·B级防火·E0环保饰面板",
    );
  });

  it("preserves OG/twitter titles as the verbatim (cleaned) title", () => {
    const m = buildLocalizedMetadata({
      locale: "en",
      path: "/about",
      title: "About KZQ | Engineering Board Brand",
      description: "desc",
    });
    expect(m.openGraph?.title).toBe("About KZQ | Engineering Board Brand");
    expect(m.twitter?.title).toBe("About KZQ | Engineering Board Brand");
  });

  it("preserves OG/twitter titles for plain page names", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/documents",
      title: "产品目录与色卡",
      description: "desc",
    });
    expect(m.openGraph?.title).toBe("产品目录与色卡");
    expect(m.twitter?.title).toBe("产品目录与色卡");
  });

  it("does NOT strip KZQ from the middle of a title", () => {
    const m = buildLocalizedMetadata({
      locale: "en",
      path: "/about",
      title: "About KZQ Engineering Brand",
      description: "desc",
    });
    // KZQ present but not at end → bypasses template (absolute), no stripping
    expect(typeof m.title).toBe("object");
    expect((m.title as { absolute: string }).absolute).toBe(
      "About KZQ Engineering Brand",
    );
  });
});

describe("buildLocalizedMetadata — pages required by user spec", () => {
  it("/documents zh returns plain title for template", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/documents",
      title: "产品目录与色卡",
      description: "KZQ catalog center",
    });
    expect(m.title).toBe("产品目录与色卡");
  });

  it("/en/documents en returns plain title for template", () => {
    const m = buildLocalizedMetadata({
      locale: "en",
      path: "/documents",
      title: "Catalogs & Color Cards",
      description: "KZQ catalog center",
    });
    expect(m.title).toBe("Catalogs & Color Cards");
  });

  it("/products zh returns plain title for template", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/products",
      title: "产品中心",
      description: "KZQ products",
    });
    expect(m.title).toBe("产品中心");
  });

  it("product detail with name only returns plain title", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/products/test-slug",
      title: "GZ 系列工程板",
      description: "desc",
    });
    expect(m.title).toBe("GZ 系列工程板");
  });

  it("/projects zh returns plain title for template", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/projects",
      title: "应用案例",
      description: "KZQ projects",
    });
    expect(m.title).toBe("应用案例");
  });

  it("/certificates zh returns plain title for template", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/certificates",
      title: "测试与认证",
      description: "KZQ certificates",
    });
    expect(m.title).toBe("测试与认证");
  });

  it("home page title is absolute (no template applied)", () => {
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/",
      title: "KZQ | 工程级板材·B级防火·E0环保饰面板",
      description: "desc",
    });
    expect(typeof m.title).toBe("object");
    expect((m.title as { absolute: string }).absolute).toBe(
      "KZQ | 工程级板材·B级防火·E0环保饰面板",
    );
  });
});
