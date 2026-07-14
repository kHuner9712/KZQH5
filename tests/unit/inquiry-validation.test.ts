import { describe, expect, it } from "vitest";
import { validateInquiryInput } from "@/lib/services/inquiries/validation";
import type { InquiryInput, InquiryListItemInput } from "@/types/database";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";

function input(overrides: Partial<InquiryInput> = {}): InquiryInput {
  return {
    locale: "zh",
    name: "测试客户",
    phone: "13800000000",
    interested_product: "防火板",
    privacy_accepted: true,
    ...overrides,
  };
}

function item(id = PRODUCT_ID): InquiryListItemInput {
  return {
    product_id: id,
    slug: "client-forged-slug",
    name_cn: "客户端伪造名称",
    name_en: "Forged",
    cover_image_url: "https://attacker.invalid/a.jpg",
    quantity: "20",
  };
}

describe("Chinese inquiry validation", () => {
  it("accepts name with a phone", () => {
    expect(validateInquiryInput(input(), "zh").success).toBe(true);
  });

  it("accepts name with WeChat", () => {
    expect(
      validateInquiryInput(input({ phone: "", wechat: "wechat-id" }), "zh")
        .success,
    ).toBe(true);
  });

  it.each([
    ["missing contact", { phone: "", wechat: "" }],
    ["missing product", { interested_product: "" }],
    ["missing privacy", { privacy_accepted: false }],
  ])("rejects %s", (_name, overrides) => {
    expect(validateInquiryInput(input(overrides), "zh").success).toBe(false);
  });
});

describe("English inquiry validation", () => {
  const english = (overrides: Partial<InquiryInput> = {}) =>
    input({
      locale: "en",
      name: "Buyer",
      phone: "",
      email: "buyer@example.com",
      interested_product: "Fire board",
      ...overrides,
    });

  it("accepts Email", () => {
    expect(validateInquiryInput(english(), "en").success).toBe(true);
  });

  it("accepts WhatsApp", () => {
    expect(
      validateInquiryInput(
        english({ email: "", whatsapp: "+1 555 0100" }),
        "en",
      ).success,
    ).toBe(true);
  });

  it.each([
    ["both contacts missing", { email: "", whatsapp: "" }],
    ["invalid email", { email: "invalid" }],
  ])("rejects %s", (_name, overrides) => {
    expect(validateInquiryInput(english(overrides), "en").success).toBe(false);
  });

  it("adds destination port and trade term to the message", () => {
    const result = validateInquiryInput(
      english({
        destination_port: "Rotterdam",
        trade_term: "CIF",
        message: "Need samples",
      }),
      "en",
    );
    expect(result.success && result.record.message).toContain(
      "[Destination Port] Rotterdam",
    );
    expect(result.success && result.record.message).toContain(
      "[Trade Term] CIF",
    );
  });
});

describe("common inquiry protection", () => {
  it("deduplicates products without trusting client snapshots", () => {
    const result = validateInquiryInput(
      input({ items: [item(), item()] }),
      "zh",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.items).toEqual([{ product_id: PRODUCT_ID, quantity: "20" }]);
  });

  it("rejects over 30 products and invalid UUIDs", () => {
    const tooMany = Array.from({ length: 31 }, (_, index) =>
      item(`${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`),
    );
    expect(validateInquiryInput(input({ items: tooMany }), "zh").success).toBe(
      false,
    );
    expect(
      validateInquiryInput(input({ items: [item("not-a-uuid")] }), "zh")
        .success,
    ).toBe(false);
  });

  it("truncates long fields and blocks URL spam", () => {
    const truncated = validateInquiryInput(
      input({ company: "x".repeat(500) }),
      "zh",
    );
    expect(truncated.success && truncated.record.company?.length).toBe(200);
    expect(
      validateInquiryInput(
        input({
          message: "https://a.test https://b.test https://c.test",
        }),
        "zh",
      ).success,
    ).toBe(false);
  });
});
