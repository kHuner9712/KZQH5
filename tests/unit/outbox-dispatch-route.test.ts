import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const processInquiryOutbox = vi.fn();

vi.mock("@/lib/services/inquiries/outbox-processor", () => ({
  processInquiryOutbox,
}));

const VALID_SECRET = "test-dispatch-secret-0123456789-absolutely-long-enough";

function dispatchRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("https://kzq.test/api/internal/outbox/dispatch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });
}

describe("POST /api/internal/outbox/dispatch — fail-closed dispatcher entrypoint", () => {
  beforeEach(() => {
    processInquiryOutbox.mockReset();
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", VALID_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 when OUTBOX_DISPATCH_SECRET is missing (fail-closed)", async () => {
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", "");
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest({}, { Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("dispatcher_disabled");
    expect(processInquiryOutbox).not.toHaveBeenCalled();
  });

  it("returns 503 when OUTBOX_DISPATCH_SECRET is too short (<16 chars)", async () => {
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", "short");
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest({}, { Authorization: "Bearer short" }),
    );
    expect(response.status).toBe(503);
    expect(processInquiryOutbox).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(dispatchRequest({}));
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe("missing_or_malformed_authorization");
    expect(processInquiryOutbox).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is not Bearer scheme", async () => {
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest({}, { Authorization: `Basic ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(401);
    expect(processInquiryOutbox).not.toHaveBeenCalled();
  });

  it("returns 401 when Bearer token is empty", async () => {
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest({}, { Authorization: "Bearer " }),
    );
    expect(response.status).toBe(401);
    expect(processInquiryOutbox).not.toHaveBeenCalled();
  });

  it("returns 403 when Bearer token does not match (timing-safe)", async () => {
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest({}, { Authorization: "Bearer wrong-secret-value-here" }),
    );
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.error).toBe("forbidden");
    expect(processInquiryOutbox).not.toHaveBeenCalled();
  });

  it("returns 400 when body is not valid JSON", async () => {
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const request = new NextRequest(
      "https://kzq.test/api/internal/outbox/dispatch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_SECRET}`,
        },
        body: "{not valid json",
      },
    );
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(processInquiryOutbox).not.toHaveBeenCalled();
  });

  it("returns 200 and coarse counters on successful dispatch", async () => {
    processInquiryOutbox.mockResolvedValue({
      initialized: 1,
      claimed: 2,
      sent: 2,
      failed: 0,
      deadLettered: 0,
    });
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(json.processed).toBe(true);
    expect(json.result).toMatchObject({
      initialized: 1,
      claimed: 2,
      sent: 2,
      failed: 0,
      deadLettered: 0,
    });
    // The route now passes (batchSize, { signal }) — Section 11 方案 B.
    expect(processInquiryOutbox).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("clamps batchSize to default when missing", async () => {
    processInquiryOutbox.mockResolvedValue({
      initialized: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      deadLettered: 0,
    });
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest({}, { Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(200);
    // Default batch size is 10.
    expect(processInquiryOutbox).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("clamps batchSize to MAX_BATCH_SIZE when too large", async () => {
    processInquiryOutbox.mockResolvedValue({
      initialized: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      deadLettered: 0,
    });
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest(
        { batchSize: 9999 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    // MAX_BATCH_SIZE = 50.
    expect(processInquiryOutbox).toHaveBeenCalledWith(
      50,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("clamps negative batchSize to default", async () => {
    processInquiryOutbox.mockResolvedValue({
      initialized: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      deadLettered: 0,
    });
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest(
        { batchSize: -5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    expect(processInquiryOutbox).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns 500 with fixed error string when processor throws", async () => {
    processInquiryOutbox.mockRejectedValue(new Error("PostGRES select * from inquiries"));
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("dispatch_failed");
    // Never leak raw SQL / PII.
    expect(JSON.stringify(json)).not.toContain("inquiries");
    expect(JSON.stringify(json)).not.toContain("POSTGRES");
  });

  it("returns 504 with fixed coarse code when processor throws AbortError (Section 11)", async () => {
    // Simulate the AbortController firing during processInquiryOutbox:
    // the processor sees signal.aborted and the in-flight adapter.send
    // throws an AbortError that bubbles up to the route.
    const abortError = new Error("The user aborted a request.");
    abortError.name = "AbortError";
    processInquiryOutbox.mockRejectedValue(abortError);
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(504);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("dispatch_timeout");
    // Never leak the underlying error message.
    expect(JSON.stringify(json)).not.toContain("aborted");
  });

  it("passes an AbortSignal that is NOT yet aborted on normal dispatch (Section 11)", async () => {
    processInquiryOutbox.mockResolvedValue({
      initialized: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      deadLettered: 0,
    });
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    const callArgs = processInquiryOutbox.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs[1]).toBeDefined();
    const signal = (callArgs[1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);
  });

  it("response body never includes inquiry PII even when processor returns counters", async () => {
    processInquiryOutbox.mockResolvedValue({
      initialized: 1,
      claimed: 1,
      sent: 1,
      failed: 0,
      deadLettered: 0,
    });
    const { POST } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await POST(
      dispatchRequest(
        { batchSize: 5 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    const json = await response.json();
    const serialized = JSON.stringify(json);
    // Counter-only response: no inquiry ids, no provider response bodies,
    // no lock tokens, no delivery row ids.
    expect(serialized).not.toMatch(/inquiry[_-]?id/i);
    expect(serialized).not.toMatch(/lock[_-]?token/i);
    expect(serialized).not.toMatch(/delivery[_-]?id/i);
    expect(serialized).not.toMatch(/provider_message_id/i);
  });

  it("GET method returns 405", async () => {
    const { GET } = await import("@/app/api/internal/outbox/dispatch/route");
    const response = await GET();
    expect(response.status).toBe(405);
  });
});

/**
 * Verify the route is exported with the right Next.js runtime directives
 * so it is never statically optimized or cached.
 */
describe("POST /api/internal/outbox/dispatch — Next.js runtime directives", () => {
  it("route module exports dynamic and revalidate constants", async () => {
    const mod = await import("@/app/api/internal/outbox/dispatch/route");
    expect(mod.dynamic).toBe("force-dynamic");
    expect(mod.revalidate).toBe(0);
    expect(mod.runtime).toBe("nodejs");
  });
});
