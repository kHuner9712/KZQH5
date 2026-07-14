import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCALE,
  isLocale,
  localeFromPathname,
  localePath,
  pathWithoutLocale,
  switchLocalePath,
} from "@/lib/i18n/config";
import { localizedValue } from "@/lib/i18n/content";
import {
  buildLocalizedMetadata,
  localizedAlternates,
} from "@/lib/i18n/metadata";

describe("locale routing", () => {
  it("recognizes supported locales", () => {
    expect(DEFAULT_LOCALE).toBe("zh");
    expect(isLocale("zh")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });

  it("builds and removes locale prefixes", () => {
    expect(localePath("zh", "/products/a")).toBe("/products/a");
    expect(localePath("en", "/products/a")).toBe("/en/products/a");
    expect(pathWithoutLocale("/en/products/a")).toBe("/products/a");
    expect(localeFromPathname("/en/products/a")).toBe("en");
    expect(localeFromPathname("/products/a")).toBe("zh");
  });

  it("preserves query strings and hashes while switching either direction", () => {
    expect(switchLocalePath("/products?q=防火板&category=board", "en")).toBe(
      "/en/products?q=防火板&category=board",
    );
    expect(switchLocalePath("/en/products?q=fire%20board&page=2", "zh")).toBe(
      "/products?q=fire%20board&page=2",
    );
    expect(switchLocalePath("/en?utm_source=wechat#top", "zh")).toBe(
      "/?utm_source=wechat#top",
    );
  });
});

describe("localized content and metadata", () => {
  it("falls back between English and Chinese content", () => {
    const source = { title_cn: "防火板", title_en: "" };
    expect(localizedValue<string>(source, "title", "en")).toBe("防火板");
    expect(
      localizedValue<string>(
        { title_cn: "", title_en: "Fire board" },
        "title",
        "zh",
      ),
    ).toBe("Fire board");
  });

  it("generates canonical and hreflang URLs", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.com/");
    const metadata = buildLocalizedMetadata({
      locale: "en",
      path: "/products/a",
      title: "Product A",
      description: "Description",
    });
    expect(metadata.alternates?.canonical).toBe(
      "https://example.com/en/products/a",
    );
    expect(metadata.alternates?.languages).toEqual({
      "zh-CN": "https://example.com/products/a",
      en: "https://example.com/en/products/a",
      "x-default": "https://example.com/products/a",
    });
    expect(localizedAlternates("/products/a").en).toBe(
      "https://example.com/en/products/a",
    );
    vi.unstubAllEnvs();
  });
});
