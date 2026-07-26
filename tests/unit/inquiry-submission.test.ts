import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InquiryCreateRecord } from "@/lib/services/inquiries/validation";

const getLatestProductsForInquiry = vi.fn();
const createInquiryWithItems = vi.fn();

vi.mock("@/lib/repositories/products", () => ({ getLatestProductsForInquiry }));
vi.mock("@/lib/repositories/inquiries", () => ({ createInquiryWithItems }));

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";

function record(): InquiryCreateRecord {
  return {
    name: "Buyer",
    company: null,
    country: null,
    phone: "13800000000",
    wechat: null,
    email: null,
    whatsapp: null,
    interested_product: "Forged client name",
    quantity: "10",
    message: null,
    status: "new",
    language: "zh",
    source: "direct",
    channel: null,
    page_url: null,
    referrer: null,
    product_id: PRODUCT_ID,
    product_slug: "forged",
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    is_read: false,
    read_at: null,
    notes: null,
    assignee: null,
  };
}

describe("inquiry product integrity", () => {
  beforeEach(() => {
    getLatestProductsForInquiry.mockReset();
    createInquiryWithItems.mockReset();
  });

  it("builds every snapshot from the published database product", async () => {
    getLatestProductsForInquiry.mockResolvedValue([
      {
        id: PRODUCT_ID,
        slug: "database-slug",
        name_cn: "数据库产品名",
        name_en: "Database Product",
        cover_image_url: null,
      },
    ]);
    createInquiryWithItems.mockResolvedValue({
      inquiry: {
        ...record(),
        id: "22222222-2222-4222-8222-222222222222",
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      },
      idempotent: false,
      outboxId: "outbox-1",
    });
    const { submitInquiry } = await import(
      "@/lib/services/inquiries/submission"
    );
    await submitInquiry(record(), [{ product_id: PRODUCT_ID, quantity: "10" }]);
    expect(createInquiryWithItems).toHaveBeenCalledWith(
      expect.objectContaining({
        interested_product: "数据库产品名",
        product_slug: "database-slug",
      }),
      [
        expect.objectContaining({
          product_id: PRODUCT_ID,
          product_slug: "database-slug",
          product_name_cn: "数据库产品名",
        }),
      ],
      null,
    );
  });

  it("rejects a nonexistent or unpublished product before any write", async () => {
    getLatestProductsForInquiry.mockResolvedValue([]);
    const { InquiryProductUnavailableError, submitInquiry } = await import(
      "@/lib/services/inquiries/submission"
    );
    await expect(
      submitInquiry(record(), [{ product_id: PRODUCT_ID, quantity: "" }]),
    ).rejects.toBeInstanceOf(InquiryProductUnavailableError);
    expect(createInquiryWithItems).not.toHaveBeenCalled();
  });

  it("allows a manual product inquiry without product IDs", async () => {
    const manual = { ...record(), product_id: null, product_slug: null };
    createInquiryWithItems.mockResolvedValue({
      inquiry: {
        ...manual,
        id: "22222222-2222-4222-8222-222222222222",
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      },
      idempotent: false,
      outboxId: "outbox-2",
    });
    const { submitInquiry } = await import(
      "@/lib/services/inquiries/submission"
    );
    await submitInquiry(manual, []);
    expect(getLatestProductsForInquiry).not.toHaveBeenCalled();
    expect(createInquiryWithItems).toHaveBeenCalledWith(manual, [], null);
  });
});
