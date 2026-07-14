import { describe, expect, it, vi } from "vitest";
import { createNotificationAdapters } from "@/lib/services/inquiries/notifications";
import type { Inquiry } from "@/types/database";

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

function jsonResponse(status = 200): Response {
  return new Response("{}", {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("notification adapters", () => {
  it("is a no-op when environment configuration is absent", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapters = createNotificationAdapters(
      {},
      { fetch: fetchMock, timeoutMs: 10 },
    );
    expect(adapters.every((adapter) => !adapter.configured)).toBe(true);
    await Promise.all(adapters.map((adapter) => adapter.send(inquiry)));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends configured WeCom and Resend notifications", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse());
    const adapters = createNotificationAdapters(
      {
        wecomWebhookUrl: "https://wecom.invalid/secret",
        resendApiKey: "re_secret",
        resendFrom: "from@example.com",
        resendTo: "to@example.com",
      },
      { fetch: fetchMock, timeoutMs: 50 },
    );
    await Promise.all(adapters.map((adapter) => adapter.send(inquiry)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 500])("rejects HTTP %s", async (status) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(status));
    const [wecom] = createNotificationAdapters(
      {
        wecomWebhookUrl: "https://wecom.invalid/secret",
      },
      { fetch: fetchMock, timeoutMs: 50 },
    );
    await expect(wecom.send(inquiry)).rejects.toThrow(`HTTP ${status}`);
  });

  it("rejects non-JSON responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("OK", { status: 200 }));
    const [wecom] = createNotificationAdapters(
      {
        wecomWebhookUrl: "https://wecom.invalid/secret",
      },
      { fetch: fetchMock, timeoutMs: 50 },
    );
    await expect(wecom.send(inquiry)).rejects.toThrow("Non-JSON response");
  });

  it("aborts a timed-out request", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const [wecom] = createNotificationAdapters(
      {
        wecomWebhookUrl: "https://wecom.invalid/secret",
      },
      { fetch: fetchMock, timeoutMs: 5 },
    );
    await expect(wecom.send(inquiry)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
