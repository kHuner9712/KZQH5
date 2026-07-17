import { describe, expect, it } from "vitest";
import { isHealthCacheControlSafe } from "@/lib/services/cache-policy";

describe("isHealthCacheControlSafe", () => {
  it("accepts no-store", () => {
    expect(isHealthCacheControlSafe("no-store")).toBe(true);
  });

  it("accepts the EdgeOne CDN rewrite public,max-age=0,must-revalidate", () => {
    expect(isHealthCacheControlSafe("public,max-age=0,must-revalidate")).toBe(
      true,
    );
  });

  it("accepts no-store combined with other directives", () => {
    expect(isHealthCacheControlSafe("no-store, no-cache")).toBe(true);
    expect(isHealthCacheControlSafe("no-cache, no-store")).toBe(true);
  });

  it("rejects missing or empty header", () => {
    expect(isHealthCacheControlSafe(null)).toBe(false);
    expect(isHealthCacheControlSafe(undefined)).toBe(false);
    expect(isHealthCacheControlSafe("")).toBe(false);
    expect(isHealthCacheControlSafe("   ")).toBe(false);
  });

  it("rejects positive max-age", () => {
    expect(isHealthCacheControlSafe("max-age=60")).toBe(false);
    expect(isHealthCacheControlSafe("public, max-age=300")).toBe(false);
    expect(isHealthCacheControlSafe("max-age=1")).toBe(false);
  });

  it("rejects positive s-maxage even when max-age=0", () => {
    expect(isHealthCacheControlSafe("max-age=0, s-maxage=600")).toBe(false);
    expect(
      isHealthCacheControlSafe("public, max-age=0, must-revalidate, s-maxage=30"),
    ).toBe(false);
  });

  it("rejects immutable even with max-age=0 and must-revalidate", () => {
    expect(
      isHealthCacheControlSafe("public, max-age=0, immutable"),
    ).toBe(false);
    expect(
      isHealthCacheControlSafe("public, max-age=0, must-revalidate, immutable"),
    ).toBe(false);
  });

  it("rejects max-age=0 without must-revalidate", () => {
    expect(isHealthCacheControlSafe("max-age=0")).toBe(false);
    expect(isHealthCacheControlSafe("public, max-age=0")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isHealthCacheControlSafe("NO-STORE")).toBe(true);
    expect(
      isHealthCacheControlSafe("Public,Max-Age=0,Must-Revalidate"),
    ).toBe(true);
    expect(isHealthCacheControlSafe("IMMUTABLE")).toBe(false);
  });

  it("rejects unknown directives without a safe combination", () => {
    expect(isHealthCacheControlSafe("public")).toBe(false);
    expect(isHealthCacheControlSafe("no-cache")).toBe(false);
    expect(isHealthCacheControlSafe("private")).toBe(false);
  });
});
