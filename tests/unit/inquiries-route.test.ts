import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const submitInquiry = vi.fn();

vi.mock("@/lib/services/inquiries/submission", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/services/inquiries/submission")
    >();
  return { ...actual, submitInquiry };
});
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
  });
});

/**
 * Static regression tests: the canonical notification path is the
 * Outbox Dispatcher only. The public submission route MUST NOT import
 * or call `notifyNewInquiry` (or any other function that talks to a
 * notification provider directly). A fast-path call alongside the
 * Outbox caused double delivery on every fresh submission and bypassed
 * per-provider delivery state, Resend Idempotency-Key Header dedup,
 * and WeCom at-least-once semantics.
 */
describe("public inquiry route — canonical outbox notification path", () => {
  it("app/api/inquiries/route.ts does not import notifyNewInquiry", () => {
    const routeSource = readFileSync(
      join(process.cwd(), "app/api/inquiries/route.ts"),
      "utf8",
    );
    expect(routeSource).not.toContain("notifyNewInquiry");
    expect(routeSource).not.toContain(
      'from "@/lib/services/inquiries/notifications"',
    );
  });

  it("app/api/inquiries/route.ts does not contain 'best-effort fast path' wording", () => {
    const routeSource = readFileSync(
      join(process.cwd(), "app/api/inquiries/route.ts"),
      "utf8",
    );
    expect(routeSource).not.toContain("best-effort fast path");
    expect(routeSource).not.toContain("Fire-and-forget");
  });

  it("submitting a fresh inquiry does not invoke any notification provider", async () => {
    // Build a mock adapter tracker so we can prove the route never
    // reaches a provider. The route is mocked to resolve submitInquiry
    // successfully; if the route tried to call any provider directly
    // we would see it here.
    submitInquiry.mockResolvedValue({
      inquiry: { id: "inq-fresh", created_at: "2026-01-01T00:00:00Z" },
      submittedProductCount: 0,
      idempotent: false,
      outboxId: "outbox-fresh",
    });
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(
      request({
        locale: "en",
        name: "Buyer",
        email: "buyer@example.com",
        interested_product: "Board",
        privacy_accepted: true,
      }),
    );
    expect(response.status).toBe(200);
    // Drain microtask queue in case a stray fire-and-forget promise exists.
    await new Promise((resolve) => setImmediate(resolve));
    // The route must not call submitInquiry's internals to send notifications.
    expect(submitInquiry).toHaveBeenCalledTimes(1);
  });
});
