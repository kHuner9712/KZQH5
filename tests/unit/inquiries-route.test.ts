import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const submitInquiry = vi.fn();
const notifyNewInquiry = vi.fn();

vi.mock("@/lib/services/inquiries/submission", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/services/inquiries/submission")
    >();
  return { ...actual, submitInquiry };
});
vi.mock("@/lib/services/inquiries/notifications", () => ({ notifyNewInquiry }));
vi.mock("@/lib/services/rate-limit", () => ({
  getInquiryRateLimiter: () => ({
    check: async () => ({ allowed: true, remaining: 4, retryAfterSeconds: 60 }),
  }),
}));

function request(body: unknown): NextRequest {
  return new NextRequest("https://kzq.test/api/inquiries", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept-Language": "en" },
    body: JSON.stringify(body),
  });
}

describe("public inquiry route", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
    submitInquiry.mockReset();
    notifyNewInquiry.mockReset();
  });

  it("silently accepts a honeypot without writing", async () => {
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(request({ company_website: "bot" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, id: null });
    expect(submitInquiry).not.toHaveBeenCalled();
  });

  it("returns a localized 400 for a nonexistent product", async () => {
    const { InquiryProductUnavailableError } = await import(
      "@/lib/services/inquiries/submission"
    );
    submitInquiry.mockRejectedValue(new InquiryProductUnavailableError());
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(
      request({
        locale: "en",
        name: "Buyer",
        email: "buyer@example.com",
        interested_product: "Board",
        privacy_accepted: true,
        items: [
          {
            product_id: "11111111-1111-4111-8111-111111111111",
            quantity: "10",
          },
        ],
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("no longer available");
    expect(notifyNewInquiry).not.toHaveBeenCalled();
  });
});
