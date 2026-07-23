import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";

describe("buildLocalizedMetadata — indexing robots rules", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("outputs noindex when indexing is disabled (default)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/products",
      title: "Products",
      description: "desc",
    });
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  it("outputs noindex when indexing is explicitly 'false'", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "false");
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/products",
      title: "Products",
      description: "desc",
    });
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  it("outputs index,follow when indexing is enabled", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "true");
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/products",
      title: "Products",
      description: "desc",
    });
    expect(m.robots).toEqual({ index: true, follow: true });
  });

  it("outputs noindex when 'TRUE' is set (case-sensitive)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "TRUE");
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/products",
      title: "Products",
      description: "desc",
    });
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  it("defaults to noindex in demo mode", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/products",
      title: "Products",
      description: "desc",
    });
    expect(m.robots).toEqual({ index: false, follow: false });
  });
});

describe("buildLocalizedMetadata — title still has single KZQ suffix", () => {
  it("does not produce duplicate '| KZQ | KZQ'", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    const m = buildLocalizedMetadata({
      locale: "zh",
      path: "/about",
      title: "关于我们 | KZQ",
      description: "desc",
    });
    // The title is cleaned to "关于我们"; the root layout template appends
    // "| KZQ" exactly once. The metadata title itself is just the cleaned string.
    expect(m.title).toBe("关于我们");
    // Ensure the metadata object does not contain a double brand suffix.
    expect(JSON.stringify(m.title)).not.toContain("KZQ | KZQ");
  });
});
