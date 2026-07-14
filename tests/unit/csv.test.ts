import { describe, expect, it } from "vitest";
import { inquiriesToCsv } from "@/lib/services/inquiries/csv";
import type { Inquiry } from "@/types/database";

function inquiry(overrides: Partial<Inquiry> = {}): Inquiry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "中文,客户",
    company: '公司"名称',
    country: null,
    phone: null,
    wechat: null,
    email: null,
    whatsapp: null,
    interested_product: "防火板\n规格",
    quantity: null,
    message: '=HYPERLINK("https://evil.test")',
    status: "new",
    language: "zh",
    source: "direct",
    channel: null,
    page_url: null,
    referrer: null,
    product_id: null,
    product_slug: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    is_read: false,
    read_at: null,
    notes: null,
    assignee: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("CSV export", () => {
  it("uses a UTF-8 BOM and safely quotes Chinese, commas, quotes and newlines", () => {
    const csv = inquiriesToCsv([inquiry()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"中文,客户"');
    expect(csv).toContain('"公司""名称"');
    expect(csv).toContain('"防火板\n规格"');
  });

  it("neutralizes formula injection", () => {
    expect(inquiriesToCsv([inquiry()])).toContain("'=HYPERLINK");
  });
});
