import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";

describe("/robots.txt route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disallows all crawling when indexing is disabled (default)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.com");
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", disallow: "/" });
    // sitemap must NOT be advertised when indexing is off
    expect(result.sitemap).toBeUndefined();
  });

  it("disallows all crawling when indexing is 'false'", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.com");
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", disallow: "/" });
    expect(result.sitemap).toBeUndefined();
  });

  it("allows crawling and advertises sitemap when indexing is 'true'", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com");
    const result = robots();
    expect(result.rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api"],
    });
    expect(result.sitemap).toBe("https://h5.kzqdecor.com/sitemap.xml");
  });

  it("does NOT enable indexing when 'TRUE' is set (case-sensitive)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "TRUE");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.com");
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", disallow: "/" });
    expect(result.sitemap).toBeUndefined();
  });
});
