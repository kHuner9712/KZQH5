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

const VALID_SUBMISSION_ID = "11111111-1111-4111-8111-111111111111";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    locale: "en",
    name: "Buyer",
    email: "buyer@example.com",
    interested_product: "Board",
    privacy_accepted: true,
    ...overrides,
  };
}

describe("Phase 5: inquiry idempotency route", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
    submitInquiry.mockReset();
    notifyNewInquiry.mockReset();
    // The route calls notifyNewInquiry(...).catch(...) as fire-and-forget,
    // so the mock MUST return a Promise (vi.fn() returns undefined by default
    // which would crash on .catch). Default to a resolved promise.
    notifyNewInquiry.mockResolvedValue(undefined);
  });

  it("rejects a malformed client_submission_id with 400", async () => {
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(
      request(validBody({ client_submission_id: "not-a-uuid" })),
    );
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toMatch(/client_submission_id/i);
    expect(submitInquiry).not.toHaveBeenCalled();
  });

  it("passes a valid client_submission_id through to submitInquiry", async () => {
    submitInquiry.mockResolvedValue({
      inquiry: { id: "inq-1", created_at: "2026-01-01T00:00:00Z" },
      submittedProductCount: 0,
      idempotent: false,
      outboxId: "outbox-1",
    });
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(
      request(validBody({ client_submission_id: VALID_SUBMISSION_ID })),
    );
    expect(response.status).toBe(200);
    expect(submitInquiry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      VALID_SUBMISSION_ID,
    );
  });

  it("returns idempotent=true and skips notification on a duplicate submission", async () => {
    // First call writes the inquiry; second call (same submission id) is
    // treated as an idempotent hit by the RPC and returns idempotent=true.
    submitInquiry.mockResolvedValue({
      inquiry: { id: "inq-existing", created_at: "2026-01-01T00:00:00Z" },
      submittedProductCount: 1,
      idempotent: true,
      outboxId: null,
    });
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(
      request(validBody({ client_submission_id: VALID_SUBMISSION_ID })),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      success: true,
      id: "inq-existing",
      idempotent: true,
    });
    // MUST NOT notify again — the original submit already did.
    expect(notifyNewInquiry).not.toHaveBeenCalled();
  });

  it("notifies exactly once on a fresh (non-idempotent) submit", async () => {
    submitInquiry.mockResolvedValue({
      inquiry: { id: "inq-new", created_at: "2026-01-01T00:00:00Z" },
      submittedProductCount: 0,
      idempotent: false,
      outboxId: "outbox-new",
    });
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(
      request(validBody({ client_submission_id: VALID_SUBMISSION_ID })),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      success: true,
      id: "inq-new",
      idempotent: false,
    });
    // Notification is fire-and-forget; we only need to know it was called.
    // Wait one microtask for the void promise to schedule.
    await Promise.resolve();
    expect(notifyNewInquiry).toHaveBeenCalledTimes(1);
  });

  it("notification failure does NOT change the success response", async () => {
    // The route uses fire-and-forget with .catch(() => {}), so even a
    // rejection inside notifyNewInquiry must not surface to the client.
    notifyNewInquiry.mockRejectedValue(new Error("webhook down"));
    submitInquiry.mockResolvedValue({
      inquiry: { id: "inq-ok", created_at: "2026-01-01T00:00:00Z" },
      submittedProductCount: 0,
      idempotent: false,
      outboxId: "outbox-ok",
    });
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(
      request(validBody({ client_submission_id: VALID_SUBMISSION_ID })),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    // Drain the microtask queue so the rejected promise is observed by the
    // .catch handler (otherwise Node may emit an unhandledRejection).
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("notification timeout does not block the response", async () => {
    // Simulate a slow notification that resolves after 3s. The route must
    // return immediately (fire-and-forget) without waiting.
    notifyNewInquiry.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 3000)),
    );
    submitInquiry.mockResolvedValue({
      inquiry: { id: "inq-fast", created_at: "2026-01-01T00:00:00Z" },
      submittedProductCount: 0,
      idempotent: false,
      outboxId: "outbox-fast",
    });
    const { POST } = await import("@/app/api/inquiries/route");
    const start = Date.now();
    const response = await POST(
      request(validBody({ client_submission_id: VALID_SUBMISSION_ID })),
    );
    const elapsed = Date.now() - start;
    expect(response.status).toBe(200);
    // The response must return well before the 3s notification completes.
    // (Use a generous 1500ms ceiling to avoid CI flakiness.)
    expect(elapsed).toBeLessThan(1500);
    // Drain the pending timer so vitest can exit cleanly.
    await new Promise((resolve) => setTimeout(resolve, 3100));
  });

  it("submitInquiry RPC error does not surface raw error text to the client", async () => {
    const sensitive = new Error("Postgres error: select * from secret_table");
    submitInquiry.mockRejectedValue(sensitive);
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(
      request(validBody({ client_submission_id: VALID_SUBMISSION_ID })),
    );
    expect(response.status).toBe(500);
    const json = await response.json();
    // The error message must be the fixed localized string, never the raw
    // Postgres text which could leak schema/PII.
    expect(json.error).not.toContain("secret_table");
    expect(json.error).not.toContain("Postgres");
  });

  it("does not generate a server-side submission id when client omits it", async () => {
    // Backward compatibility: a legacy client that doesn't send
    // client_submission_id must still be accepted, but submitInquiry is
    // called with null (non-idempotent path).
    submitInquiry.mockResolvedValue({
      inquiry: { id: "inq-legacy", created_at: "2026-01-01T00:00:00Z" },
      submittedProductCount: 0,
      idempotent: false,
      outboxId: "outbox-legacy",
    });
    const { POST } = await import("@/app/api/inquiries/route");
    const response = await POST(request(validBody()));
    expect(response.status).toBe(200);
    expect(submitInquiry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
    );
  });
});

describe("Phase 5: inquiry_outbox idempotency contract (repository layer)", () => {
  it("createInquiryWithItems passes clientSubmissionId through to the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        inquiry: { id: "inq-1" },
        idempotent: false,
        outbox_id: "out-1",
      },
      error: null,
    });
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminSupabaseClient: () => ({ rpc }),
    }));
    // Re-import to pick up the mocked client.
    vi.resetModules();
    const { createInquiryWithItems } = await import(
      "@/lib/repositories/inquiries"
    );
    await createInquiryWithItems(
      { name: "x" } as never,
      [],
      VALID_SUBMISSION_ID,
    );
    expect(rpc).toHaveBeenCalledWith(
      "create_inquiry_with_items",
      expect.objectContaining({
        p_client_submission_id: VALID_SUBMISSION_ID,
      }),
    );
    vi.doUnmock("@/lib/supabase/admin");
    vi.resetModules();
  });

  it("createInquiryWithItems throws on malformed RPC payload", async () => {
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminSupabaseClient: () => ({
        rpc: vi.fn().mockResolvedValue({
          data: { not_the_expected_shape: true },
          error: null,
        }),
      }),
    }));
    vi.resetModules();
    const { createInquiryWithItems } = await import(
      "@/lib/repositories/inquiries"
    );
    await expect(
      createInquiryWithItems({ name: "x" } as never, [], null),
    ).rejects.toThrow(/malformed/i);
    vi.doUnmock("@/lib/supabase/admin");
    vi.resetModules();
  });

  it("createInquiryWithItems surfaces idempotent=true when RPC returns it", async () => {
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminSupabaseClient: () => ({
        rpc: vi.fn().mockResolvedValue({
          data: {
            inquiry: { id: "existing-inq" },
            idempotent: true,
            outbox_id: null,
          },
          error: null,
        }),
      }),
    }));
    vi.resetModules();
    const { createInquiryWithItems } = await import(
      "@/lib/repositories/inquiries"
    );
    const result = await createInquiryWithItems(
      { name: "x" } as never,
      [],
      VALID_SUBMISSION_ID,
    );
    expect(result.idempotent).toBe(true);
    expect(result.outboxId).toBeNull();
    expect(result.inquiry.id).toBe("existing-inq");
    vi.doUnmock("@/lib/supabase/admin");
    vi.resetModules();
  });
});
