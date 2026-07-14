import { describe, expect, it } from "vitest";
import { validateAnalyticsEvent } from "@/lib/services/analytics/validation";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("analytics validation", () => {
  it("accepts a supported event and strips unapproved query fields", () => {
    const result = validateAnalyticsEvent({
      event_name: "product_view",
      page_path: "/products/a?q=board&email=private@example.com",
      product_id: UUID,
      locale: "en",
      message: "must never be recorded",
      phone: "13800000000",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.event.page_path).toBe("/products/a?q=board");
    expect(result.event).not.toHaveProperty("message");
    expect(result.event).not.toHaveProperty("phone");
  });

  it.each([
    [{ event_name: "unknown", page_path: "/" }],
    [{ event_name: "page_view", page_path: "https://evil.test/" }],
    [{ event_name: "page_view", page_path: "//evil.test/" }],
    [
      {
        event_name: "product_view",
        page_path: "/products/a",
        product_id: "not-uuid",
      },
    ],
  ])("rejects invalid events %#", (payload) => {
    expect(validateAnalyticsEvent(payload).success).toBe(false);
  });

  it("truncates long fields and sanitizes external referrer query data", () => {
    const result = validateAnalyticsEvent({
      event_name: "page_view",
      page_path: "/",
      source: "x".repeat(500),
      referrer: "https://referrer.test/path?token=secret",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.event.source).toHaveLength(200);
    expect(result.event.referrer).toBe("https://referrer.test/path");
  });
});
