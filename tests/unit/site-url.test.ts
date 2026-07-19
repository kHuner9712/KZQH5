import { afterEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/utils";

describe("siteUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses HTTPS production root as-is", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com");
    vi.stubEnv("NODE_ENV", "production");
    expect(siteUrl("/products")).toBe("https://h5.kzqdecor.com/products");
    expect(siteUrl("/en/products")).toBe("https://h5.kzqdecor.com/en/products");
  });

  it("strips trailing slash from base", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com/");
    expect(siteUrl("/products")).toBe("https://h5.kzqdecor.com/products");
    expect(siteUrl()).toBe("https://h5.kzqdecor.com");
  });

  it("strips multiple trailing slashes from base", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com///");
    expect(siteUrl("/products")).toBe("https://h5.kzqdecor.com/products");
  });

  it("defensively strips trailing /en if misconfigured", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com/en");
    expect(siteUrl("/products")).toBe("https://h5.kzqdecor.com/products");
    expect(siteUrl("/en/products")).toBe("https://h5.kzqdecor.com/en/products");
  });

  it("defensively strips trailing /zh if misconfigured", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com/zh");
    expect(siteUrl("/products")).toBe("https://h5.kzqdecor.com/products");
  });

  it("preserves Chinese page path (no /en prefix)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com");
    expect(siteUrl("/products/some-slug")).toBe(
      "https://h5.kzqdecor.com/products/some-slug",
    );
  });

  it("preserves English /en page path", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com");
    expect(siteUrl("/en/products/some-slug")).toBe(
      "https://h5.kzqdecor.com/en/products/some-slug",
    );
  });

  it("preserves query string in path", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com");
    expect(siteUrl("/products?category=fireboard&page=2")).toBe(
      "https://h5.kzqdecor.com/products?category=fireboard&page=2",
    );
  });

  it("preserves product slug path", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com");
    expect(siteUrl("/products/b-grade-fire-resistant-board")).toBe(
      "https://h5.kzqdecor.com/products/b-grade-fire-resistant-board",
    );
  });

  it("falls back to localhost when NEXT_PUBLIC_SITE_URL is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(siteUrl("/products")).toBe("http://localhost:3000/products");
    expect(siteUrl()).toBe("http://localhost:3000");
  });

  it("allows http://localhost in development without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    vi.stubEnv("NODE_ENV", "development");
    expect(siteUrl("/products")).toBe("http://localhost:3000/products");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("allows http://localhost in production without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    vi.stubEnv("NODE_ENV", "production");
    expect(siteUrl("/products")).toBe("http://localhost:3000/products");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("allows http://127.0.0.1 in production without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3000");
    vi.stubEnv("NODE_ENV", "production");
    expect(siteUrl("/products")).toBe("http://127.0.0.1:3000/products");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns when production base is http:// and not localhost", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://h5.kzqdecor.com");
    vi.stubEnv("NODE_ENV", "production");
    expect(siteUrl("/products")).toBe("http://h5.kzqdecor.com/products");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("NEXT_PUBLIC_SITE_URL");
  });

  it("does not warn in development even if base is http:// and not localhost", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://staging.example.com");
    vi.stubEnv("NODE_ENV", "development");
    expect(siteUrl("/products")).toBe("http://staging.example.com/products");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("handles empty path argument", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com");
    expect(siteUrl()).toBe("https://h5.kzqdecor.com");
    expect(siteUrl("")).toBe("https://h5.kzqdecor.com");
  });

  it("does not strip /en that appears in the middle of base", () => {
    // 仅剥离末尾的 /en，不应破坏 base 中间的 /en 路径
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://h5.kzqdecor.com/en/v2");
    expect(siteUrl("/products")).toBe("https://h5.kzqdecor.com/en/v2/products");
  });
});
