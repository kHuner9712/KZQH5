import { describe, expect, it } from "vitest";
import {
  isPlaceholderAddress,
  isPlaceholderEmail,
  isPlaceholderPhone,
  isPlaceholderWhatsApp,
  placeholderContactNotice,
  safeAddress,
  safeEmail,
  safePhone,
  safeWhatsApp,
} from "@/lib/content/placeholder-detection";

describe("isPlaceholderPhone", () => {
  it("flags empty string", () => {
    expect(isPlaceholderPhone("")).toBe(true);
  });

  it("flags null", () => {
    expect(isPlaceholderPhone(null)).toBe(true);
  });

  it("flags undefined", () => {
    expect(isPlaceholderPhone(undefined)).toBe(true);
  });

  it("flags whitespace-only", () => {
    expect(isPlaceholderPhone("   ")).toBe(true);
  });

  it("flags 0000-0000 sequence", () => {
    expect(isPlaceholderPhone("+86 138-0000-0000")).toBe(true);
  });

  it("flags 0000 0000 sequence", () => {
    expect(isPlaceholderPhone("+86 138 0000 0000")).toBe(true);
  });

  it("flags 4+ consecutive zeros (400-888-0000)", () => {
    expect(isPlaceholderPhone("+86 400-888-0000")).toBe(true);
  });

  it("flags all-zero number", () => {
    expect(isPlaceholderPhone("00000000")).toBe(true);
  });

  it("does NOT flag a real phone with only 3 consecutive zeros", () => {
    expect(isPlaceholderPhone("+86 138 0001 1234")).toBe(false);
  });

  it("does NOT flag a real phone", () => {
    expect(isPlaceholderPhone("+86 139 1234 5678")).toBe(false);
  });

  it("flags 'placeholder' marker", () => {
    expect(isPlaceholderPhone("placeholder")).toBe(true);
  });

  it("flags 'mock' marker", () => {
    expect(isPlaceholderPhone("mock-phone")).toBe(true);
  });

  it("does NOT flag 'demo' inside a real-looking number", () => {
    // 'demo' as a word boundary — "demo" alone would match, but a number
    // like "+86 3336 6636" does not contain the word "demo".
    expect(isPlaceholderPhone("+86 3336 6636")).toBe(false);
  });
});

describe("isPlaceholderEmail", () => {
  it("flags empty string", () => {
    expect(isPlaceholderEmail("")).toBe(true);
  });

  it("flags example.com domain", () => {
    expect(isPlaceholderEmail("sales@example.com")).toBe(true);
  });

  it("flags example.org domain", () => {
    expect(isPlaceholderEmail("test@example.org")).toBe(true);
  });

  it("flags kzq-demo.com domain", () => {
    expect(isPlaceholderEmail("sales@kzq-demo.com")).toBe(true);
  });

  it("flags kzq-example.com domain", () => {
    expect(isPlaceholderEmail("sales@kzq-example.com")).toBe(true);
  });

  it("flags test.com domain", () => {
    expect(isPlaceholderEmail("info@test.com")).toBe(true);
  });

  it("does NOT flag a real domain", () => {
    expect(isPlaceholderEmail("sales@kzqdecor.com")).toBe(false);
  });

  it("does NOT flag a real domain with 'example' in subdomain", () => {
    // 'example' must be the domain, not part of a subdomain
    expect(isPlaceholderEmail("user@myexample.com")).toBe(false);
  });

  it("flags invalid email format", () => {
    expect(isPlaceholderEmail("not-an-email")).toBe(true);
  });

  it("flags 'placeholder' marker", () => {
    expect(isPlaceholderEmail("placeholder@test.org")).toBe(true);
  });
});

describe("isPlaceholderWhatsApp", () => {
  it("flags 0000-0000 sequence (same as phone)", () => {
    expect(isPlaceholderWhatsApp("+86 138 0000 0000")).toBe(true);
  });

  it("does NOT flag a real WhatsApp number", () => {
    expect(isPlaceholderWhatsApp("+86 139 8765 4321")).toBe(false);
  });

  it("flags empty", () => {
    expect(isPlaceholderWhatsApp("")).toBe(true);
  });
});

describe("isPlaceholderAddress", () => {
  it("flags empty string", () => {
    expect(isPlaceholderAddress("")).toBe(true);
  });

  it("flags 'XX 区'", () => {
    expect(isPlaceholderAddress("中国浙江省杭州市 XX 区 XX 路 XX 号")).toBe(true);
  });

  it("flags 'XX区' without space", () => {
    expect(isPlaceholderAddress("杭州市XX区")).toBe(true);
  });

  it("flags 'XX 路'", () => {
    expect(isPlaceholderAddress("XX 路 1 号")).toBe(true);
  });

  it("flags 'XX 号'", () => {
    expect(isPlaceholderAddress("XX 号")).toBe(true);
  });

  it("flags 'No. XX' (English)", () => {
    expect(isPlaceholderAddress("No. XX Road, XX District, Hangzhou")).toBe(true);
  });

  it("flags 'XX Road' (English)", () => {
    expect(isPlaceholderAddress("XX Road, Hangzhou")).toBe(true);
  });

  it("flags 'XX District' (English)", () => {
    expect(isPlaceholderAddress("XX District, Hangzhou")).toBe(true);
  });

  it("does NOT flag a real Chinese address", () => {
    expect(
      isPlaceholderAddress("中国 · 广东省 · 工程级板材产业基地"),
    ).toBe(false);
  });

  it("does NOT flag a real English address", () => {
    expect(
      isPlaceholderAddress("Engineering Board Industrial Base, Guangdong, China"),
    ).toBe(false);
  });

  it("flags 'placeholder' marker", () => {
    expect(isPlaceholderAddress("placeholder address")).toBe(true);
  });
});

describe("safe* wrappers", () => {
  it("safePhone returns null for placeholder", () => {
    expect(safePhone("+86 138 0000 0000")).toBeNull();
  });

  it("safePhone returns the value for real phone", () => {
    expect(safePhone("+86 139 1234 5678")).toBe("+86 139 1234 5678");
  });

  it("safeEmail returns null for placeholder", () => {
    expect(safeEmail("sales@example.com")).toBeNull();
  });

  it("safeEmail returns the value for real email", () => {
    expect(safeEmail("sales@kzqdecor.com")).toBe("sales@kzqdecor.com");
  });

  it("safeWhatsApp returns null for placeholder", () => {
    expect(safeWhatsApp("+86 138 0000 0000")).toBeNull();
  });

  it("safeAddress returns null for placeholder", () => {
    expect(safeAddress("XX 区 XX 路")).toBeNull();
  });

  it("safeAddress returns the value for real address", () => {
    expect(safeAddress("广东省工程板材产业基地")).toBe("广东省工程板材产业基地");
  });
});

describe("placeholderContactNotice", () => {
  it("has a Chinese message", () => {
    expect(placeholderContactNotice.zh).toContain("询盘表单");
  });

  it("has an English message", () => {
    expect(placeholderContactNotice.en).toContain("inquiry form");
  });
});
