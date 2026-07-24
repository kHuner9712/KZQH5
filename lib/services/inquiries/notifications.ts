import type { Inquiry } from "@/types/database";

const NOTIFICATION_TIMEOUT_MS = 5000;

export interface NotificationRuntime {
  fetch: typeof fetch;
  timeoutMs: number;
}

export interface NotificationConfig {
  wecomWebhookUrl?: string;
  resendApiKey?: string;
  resendFrom?: string;
  resendTo?: string;
}

/**
 * Context passed to NotificationAdapter.send so providers that
 * support an idempotency key can use the outbox event id for it.
 *
 * - eventId: the inquiry_outbox.id (stable across retries)
 * - lockToken: the per-claim lock_token (changes on each claim)
 * - attempt: 1-based attempt number for this delivery
 * - provider: the provider name ('email' | 'wecom') for this delivery
 *
 * Adapters that do NOT support idempotency keys (e.g. WeCom webhook)
 * should document that duplicate sends are still possible.
 */
export interface NotificationSendContext {
  eventId: string;
  lockToken: string;
  attempt: number;
  provider: "email" | "wecom";
}

/**
 * Result of NotificationAdapter.send.
 *
 * providerMessageId is captured when the provider returns one
 * (e.g. Resend message id) and recorded on the delivery row via
 * mark_delivery_sent. Adapters that don't expose a message id
 * (e.g. WeCom webhook) return undefined.
 */
export interface NotificationSendResult {
  providerMessageId?: string;
}

/**
 * Error classification for the outbox processor.
 * - 'retryable': transient failure (network, 429, 5xx, concurrent 409)
 *   — the processor advances attempts and schedules retry.
 * - 'permanent': non-retryable failure (invalid 409, malformed request)
 *   — the processor forces dead_letter immediately.
 */
export type NotificationErrorKind = "retryable" | "permanent";

export class NotificationError extends Error {
  readonly kind: NotificationErrorKind;
  readonly code: string;
  constructor(kind: NotificationErrorKind, code: string, message?: string) {
    super(message || code);
    this.name = "NotificationError";
    this.kind = kind;
    this.code = code;
  }
}

export interface NotificationAdapter {
  name: "wecom" | "email";
  configured: boolean;
  send(
    inquiry: Inquiry,
    context?: NotificationSendContext,
  ): Promise<NotificationSendResult>;
}

const defaultRuntime: NotificationRuntime = {
  fetch,
  timeoutMs: NOTIFICATION_TIMEOUT_MS,
};

/**
 * HTTP error with status code + response body so adapters can
 * classify 409 (concurrent vs invalid) and other status codes.
 */
class NotificationHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;
  constructor(status: number, bodyText: string) {
    super(`HTTP ${status}`);
    this.name = "NotificationHttpError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

async function postJson(
  url: string,
  init: RequestInit,
  runtime: NotificationRuntime,
): Promise<void> {
  await postJsonWithResponse(url, init, runtime);
}

/**
 * Same contract as postJson, but returns the parsed JSON body so the
 * caller can extract a provider message id (e.g. Resend's `id` field).
 * Throws NotificationHttpError on non-2xx so callers can classify.
 */
async function postJsonWithResponse(
  url: string,
  init: RequestInit,
  runtime: NotificationRuntime,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const response = await runtime.fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new NotificationHttpError(response.status, bodyText);
    }
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (text && !contentType.toLowerCase().includes("application/json")) {
      throw new Error("Non-JSON response");
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid JSON response");
    }
  } finally {
    clearTimeout(timer);
  }
}

function lines(inquiry: Inquiry): string[] {
  const utm = [
    inquiry.utm_source && `source=${inquiry.utm_source}`,
    inquiry.utm_medium && `medium=${inquiry.utm_medium}`,
    inquiry.utm_campaign && `campaign=${inquiry.utm_campaign}`,
    inquiry.utm_content && `content=${inquiry.utm_content}`,
    inquiry.utm_term && `term=${inquiry.utm_term}`,
  ]
    .filter(Boolean)
    .join("; ");
  const productItems = (inquiry.inquiry_items || []).map((item, index) => {
    const name =
      item.product_name_cn ||
      item.product_name_en ||
      item.product_slug ||
      "已删除产品";
    return `${index + 1}. ${name}${item.quantity ? ` × ${item.quantity}` : ""}`;
  });

  return [
    `时间: ${inquiry.created_at}`,
    `语言: ${inquiry.language}`,
    `来源: ${inquiry.source || "-"}${inquiry.channel ? ` / ${inquiry.channel}` : ""}`,
    `姓名: ${inquiry.name}`,
    `公司: ${inquiry.company || "-"}`,
    `手机: ${inquiry.phone || "-"}`,
    `微信: ${inquiry.wechat || "-"}`,
    `Email: ${inquiry.email || "-"}`,
    `WhatsApp: ${inquiry.whatsapp || "-"}`,
    `国家或地区: ${inquiry.country || "-"}`,
    `产品: ${inquiry.interested_product || "-"}`,
    `数量: ${inquiry.quantity || "-"}`,
    ...(productItems.length ? ["产品清单:", ...productItems] : []),
    `留言: ${inquiry.message || "-"}`,
    `页面 URL: ${inquiry.page_url || "-"}`,
    `UTM: ${utm || "-"}`,
  ];
}

function escapeHtml(input: string): string {
  return input.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] || character,
  );
}

/**
 * Build the Resend Idempotency-Key for a given delivery.
 *
 * Format: `kzq/inquiry/{eventId}/email`
 * - Stable across retries of the SAME delivery (same eventId + same provider)
 * - Different per provider (email vs wecom use different keys)
 * - Does NOT include the lock_token (which changes per claim)
 * - Max length well under Resend's 256-char limit
 */
export function buildResendIdempotencyKey(eventId: string): string {
  return `kzq/inquiry/${eventId}/email`;
}

/**
 * Classify a Resend HTTP error.
 *
 * - 409 with "concurrent" in the body → retryable
 *   (a parallel request with the same key is in flight)
 * - 409 without "concurrent" → permanent
 *   (idempotency-key mismatch / invalid request — retrying won't help)
 * - 429 / 5xx → retryable
 * - 4xx (other) → permanent
 */
function classifyResendError(error: unknown): NotificationError {
  if (error instanceof NotificationHttpError) {
    const body = error.bodyText.toLowerCase();
    if (error.status === 409) {
      if (body.includes("concurrent")) {
        return new NotificationError(
          "retryable",
          "RESEND_409_CONCURRENT",
        );
      }
      return new NotificationError(
        "permanent",
        "RESEND_409_INVALID",
      );
    }
    if (error.status === 429 || error.status >= 500) {
      return new NotificationError("retryable", `RESEND_${error.status}`);
    }
    return new NotificationError("permanent", `RESEND_${error.status}`);
  }
  // Network / timeout / abort — retryable.
  const code =
    error instanceof Error ? error.name : "RESEND_UNKNOWN";
  return new NotificationError("retryable", code);
}

export function createNotificationAdapters(
  config: NotificationConfig,
  runtime: NotificationRuntime = defaultRuntime,
): NotificationAdapter[] {
  const wecom: NotificationAdapter = {
    name: "wecom",
    configured: Boolean(config.wecomWebhookUrl),
    // WeCom webhook does NOT support an idempotency key, so duplicate
    // sends are possible if the parent outbox event is retried
    // (at-least-once). The per-provider delivery model ensures that
    // a SUCCEEDED wecom delivery is never re-invoked even if another
    // provider (email) fails and the parent event retries.
    async send(inquiry) {
      if (!config.wecomWebhookUrl) return {};
      await postJson(
        config.wecomWebhookUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msgtype: "markdown",
            markdown: {
              content: `**KZQ 新询盘**\n>${lines(inquiry).join("\n>")}`,
            },
          }),
          cache: "no-store",
        },
        runtime,
      );
      // WeCom webhook does not return a message id.
      return {};
    },
  };

  const email: NotificationAdapter = {
    name: "email",
    configured: Boolean(
      config.resendApiKey && config.resendFrom && config.resendTo,
    ),
    async send(inquiry, context) {
      if (!config.resendApiKey || !config.resendFrom || !config.resendTo)
        return {};
      const content = lines(inquiry);

      // Build headers. The Idempotency-Key is sent as an HTTP Header
      // (NOT in the JSON body) per Resend's API spec. The key is
      // scoped to (eventId, provider) so:
      //   - Same delivery retried → same key → Resend deduplicates
      //   - Different provider → different key → no cross-provider collision
      //   - Lock token is NOT included (changes per claim)
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      };
      if (context?.eventId) {
        headers["Idempotency-Key"] = buildResendIdempotencyKey(
          context.eventId,
        );
      }

      let response: Record<string, unknown> | null;
      try {
        response = await postJsonWithResponse(
          "https://api.resend.com/emails",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              from: config.resendFrom,
              to: config.resendTo
                .split(",")
                .map((address) => address.trim())
                .filter(Boolean),
              subject: `[KZQ] 新询盘 - ${inquiry.name}`,
              text: content.join("\n"),
              html: `<h2>KZQ 新询盘</h2>${content.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}`,
              // NOTE: idempotency_key is NOT in the body — it is sent
              // as the Idempotency-Key HTTP Header above.
            }),
            cache: "no-store",
          },
          runtime,
        );
      } catch (error) {
        // Classify and re-throw as NotificationError so the processor
        // can decide retry vs dead_letter.
        throw classifyResendError(error);
      }

      // Resend returns { id: "re_xxx" } on success — this is the
      // real provider message id, persisted to the delivery row.
      const providerMessageId =
        typeof response?.id === "string" ? response.id : undefined;
      return providerMessageId ? { providerMessageId } : {};
    },
  };

  return [wecom, email];
}

export async function notifyNewInquiry(inquiry: Inquiry): Promise<void> {
  const adapters = createNotificationAdapters({
    wecomWebhookUrl: process.env.INQUIRY_WECOM_WEBHOOK_URL,
    resendApiKey: process.env.RESEND_API_KEY,
    resendFrom: process.env.INQUIRY_NOTIFICATION_FROM,
    resendTo: process.env.INQUIRY_NOTIFICATION_TO,
  });
  const configured = adapters.filter((adapter) => adapter.configured);
  const results = await Promise.allSettled(
    configured.map((adapter) => adapter.send(inquiry)),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const reason =
        result.reason instanceof Error ? result.reason.name : "UnknownError";
      console.error(
        `Inquiry notification failed (${configured[index].name}): ${reason}`,
      );
    }
  });
}
