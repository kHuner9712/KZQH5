import { describe, expect, it, vi } from "vitest";
import {
  buildResendIdempotencyKey,
  createNotificationAdapters,
} from "@/lib/services/inquiries/notifications";
import type { Inquiry } from "@/types/database";

// ============================================================
// Phase 15: Resend Idempotency-Key Header contract
// ------------------------------------------------------------
// Proves:
//   1. buildResendIdempotencyKey returns kzq/inquiry/{eventId}/email
//   2. Key length is well under Resend's 256-char limit
//   3. Key is stable across retries (same eventId → same key)
//   4. Different eventIds → different keys
//   5. Email adapter sends Idempotency-Key as HTTP Header (not body)
//   6. Email adapter does NOT include idempotency_key in JSON body
//   7. WeCom adapter does NOT send Idempotency-Key header
//   8. Same delivery retried uses same key (verified via context.eventId)
//   9. Resend 409 with "concurrent" body → retryable NotificationError
//  10. Resend 409 without "concurrent" → permanent NotificationError
//  11. Resend 429 → retryable
//  12. Resend 5xx → retryable
//  13. Resend 4xx (other) → permanent
//  14. Adapter returns providerMessageId from Resend response
//  15. Email adapter still works without context (no header sent)
// ============================================================

const inquiry = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test Buyer",
  interested_product: "Board",
  language: "en",
  source: "direct",
  status: "new",
  is_read: false,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
} as Inquiry;

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonResendResponse(messageId = "re_abc123"): Response {
  return jsonResponse(JSON.stringify({ id: messageId }));
}

describe("Phase 15: Resend Idempotency-Key Header contract", () => {
  describe("buildResendIdempotencyKey", () => {
    it("returns kzq/inquiry/{eventId}/email format", () => {
      const key = buildResendIdempotencyKey("evt-123");
      expect(key).toBe("kzq/inquiry/evt-123/email");
    });

    it("key length is well under 256 chars", () => {
      // Even with a max-length UUID (36 chars), the key is short.
      const key = buildResendIdempotencyKey("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(key.length).toBeLessThan(256);
      expect(key.length).toBeLessThan(80);
    });

    it("key is stable across retries (same eventId → same key)", () => {
      const key1 = buildResendIdempotencyKey("evt-1");
      const key2 = buildResendIdempotencyKey("evt-1");
      expect(key1).toBe(key2);
    });

    it("different eventIds → different keys", () => {
      const key1 = buildResendIdempotencyKey("evt-1");
      const key2 = buildResendIdempotencyKey("evt-2");
      expect(key1).not.toBe(key2);
    });

    it("key does NOT contain the lock token", () => {
      // The lock token changes per claim; it must NOT be in the key.
      const key = buildResendIdempotencyKey("evt-1");
      expect(key).not.toMatch(/token/i);
    });
  });

  describe("email adapter", () => {
    it("sends Idempotency-Key as HTTP Header when context.eventId is set", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResendResponse());
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      await email.send(inquiry, {
        eventId: "evt-abc",
        lockToken: "lock-1",
        attempt: 1,
        provider: "email",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0]!;
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe(
        "kzq/inquiry/evt-abc/email",
      );
    });

    it("does NOT include idempotency_key in JSON body", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResendResponse());
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      await email.send(inquiry, {
        eventId: "evt-abc",
        lockToken: "lock-1",
        attempt: 1,
        provider: "email",
      });

      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.idempotency_key).toBeUndefined();
      expect(body.idempotencyKey).toBeUndefined();
    });

    it("same delivery retried uses same Idempotency-Key (stable eventId)", async () => {
      // Use mockImplementation so each call gets a FRESH Response object.
      // A Response body can only be consumed once; reusing a single instance
      // via mockResolvedValue would throw TypeError on the second .json() call.
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => jsonResendResponse());
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      // First attempt with eventId=evt-1, lockToken=A
      await email.send(inquiry, {
        eventId: "evt-1",
        lockToken: "lock-A",
        attempt: 1,
        provider: "email",
      });
      // Second attempt with same eventId=evt-1, different lockToken=B (re-claim)
      await email.send(inquiry, {
        eventId: "evt-1",
        lockToken: "lock-B",
        attempt: 2,
        provider: "email",
      });

      const [call1, call2] = fetchMock.mock.calls;
      const headers1 = new Headers(call1![1]?.headers);
      const headers2 = new Headers(call2![1]?.headers);
      expect(headers1.get("Idempotency-Key")).toBe("kzq/inquiry/evt-1/email");
      expect(headers2.get("Idempotency-Key")).toBe("kzq/inquiry/evt-1/email");
      expect(headers1.get("Idempotency-Key")).toBe(
        headers2.get("Idempotency-Key"),
      );
    });

    it("different eventIds produce different Idempotency-Key headers", async () => {
      // Fresh Response per call (see explanation in the previous test).
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => jsonResendResponse());
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      await email.send(inquiry, {
        eventId: "evt-1",
        lockToken: "lock-A",
        attempt: 1,
        provider: "email",
      });
      await email.send(inquiry, {
        eventId: "evt-2",
        lockToken: "lock-B",
        attempt: 1,
        provider: "email",
      });

      const [call1, call2] = fetchMock.mock.calls;
      const headers1 = new Headers(call1![1]?.headers);
      const headers2 = new Headers(call2![1]?.headers);
      expect(headers1.get("Idempotency-Key")).not.toBe(
        headers2.get("Idempotency-Key"),
      );
    });

    it("does NOT send Idempotency-Key header when context is missing", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResendResponse());
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      // No context — direct notifyNewInquiry path.
      await email.send(inquiry);

      const [, init] = fetchMock.mock.calls[0]!;
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBeNull();
    });

    it("returns providerMessageId from Resend response", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResendResponse("re_xyz789"));
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      const result = await email.send(inquiry, {
        eventId: "evt-1",
        lockToken: "lock-A",
        attempt: 1,
        provider: "email",
      });
      expect(result.providerMessageId).toBe("re_xyz789");
    });
  });

  describe("WeCom adapter", () => {
    it("does NOT send Idempotency-Key header (no idempotency support)", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse("{}"));
      const [wecom] = createNotificationAdapters(
        {
          wecomWebhookUrl: "https://wecom.invalid/secret",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      await wecom.send(inquiry, {
        eventId: "evt-1",
        lockToken: "lock-A",
        attempt: 1,
        provider: "wecom",
      });

      const [, init] = fetchMock.mock.calls[0]!;
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBeNull();
    });
  });

  describe("Resend error classification", () => {
    it("409 with 'concurrent' body → retryable NotificationError", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          JSON.stringify({
            message: "A concurrent request with the same idempotency key is in flight",
          }),
          409,
        ),
      );
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      await expect(
        email.send(inquiry, {
          eventId: "evt-1",
          lockToken: "lock-A",
          attempt: 1,
          provider: "email",
        }),
      ).rejects.toMatchObject({
        name: "NotificationError",
        kind: "retryable",
        code: "RESEND_409_CONCURRENT",
      });
    });

    it("409 without 'concurrent' → permanent NotificationError", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          JSON.stringify({ message: "idempotency key mismatch" }),
          409,
        ),
      );
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      await expect(
        email.send(inquiry, {
          eventId: "evt-1",
          lockToken: "lock-A",
          attempt: 1,
          provider: "email",
        }),
      ).rejects.toMatchObject({
        name: "NotificationError",
        kind: "permanent",
        code: "RESEND_409_INVALID",
      });
    });

    it("429 → retryable NotificationError", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(JSON.stringify({ message: "rate limit" }), 429),
      );
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      await expect(
        email.send(inquiry, {
          eventId: "evt-1",
          lockToken: "lock-A",
          attempt: 1,
          provider: "email",
        }),
      ).rejects.toMatchObject({
        name: "NotificationError",
        kind: "retryable",
        code: "RESEND_429",
      });
    });

    it("5xx → retryable NotificationError", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(JSON.stringify({ message: "internal" }), 503),
      );
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      await expect(
        email.send(inquiry, {
          eventId: "evt-1",
          lockToken: "lock-A",
          attempt: 1,
          provider: "email",
        }),
      ).rejects.toMatchObject({
        name: "NotificationError",
        kind: "retryable",
        code: "RESEND_503",
      });
    });

    it("4xx (other) → permanent NotificationError", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(JSON.stringify({ message: "bad request" }), 400),
      );
      const [, email] = createNotificationAdapters(
        {
          resendApiKey: "re_secret",
          resendFrom: "from@example.com",
          resendTo: "to@example.com",
        },
        { fetch: fetchMock, timeoutMs: 50 },
      );

      await expect(
        email.send(inquiry, {
          eventId: "evt-1",
          lockToken: "lock-A",
          attempt: 1,
          provider: "email",
        }),
      ).rejects.toMatchObject({
        name: "NotificationError",
        kind: "permanent",
        code: "RESEND_400",
      });
    });
  });
});
