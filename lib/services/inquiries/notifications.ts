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
 *
 * Adapters that do NOT support idempotency keys (e.g. WeCom webhook)
 * should document that duplicate sends are still possible.
 */
export interface NotificationSendContext {
  eventId: string;
  lockToken: string;
  attempt: number;
}

/**
 * Result of NotificationAdapter.send.
 *
 * providerMessageId is captured when the provider returns one
 * (e.g. Resend message id) and recorded on the outbox event via
 * mark_inquiry_outbox_sent. Adapters that don't expose a message id
 * (e.g. WeCom webhook) return undefined.
 */
export interface NotificationSendResult {
  providerMessageId?: string;
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
 * Throws the same errors as postJson on non-2xx / non-JSON responses.
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
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

export function createNotificationAdapters(
  config: NotificationConfig,
  runtime: NotificationRuntime = defaultRuntime,
): NotificationAdapter[] {
  const wecom: NotificationAdapter = {
    name: "wecom",
    configured: Boolean(config.wecomWebhookUrl),
    // WeCom webhook does NOT support an idempotency key, so duplicate
    // sends are possible if the parent outbox event is retried
    // (at-least-once). Documented as a known limitation.
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
      const response = await postJsonWithResponse(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: config.resendFrom,
            to: config.resendTo
              .split(",")
              .map((address) => address.trim())
              .filter(Boolean),
            subject: `[KZQ] 新询盘 - ${inquiry.name}`,
            text: content.join("\n"),
            html: `<h2>KZQ 新询盘</h2>${content.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}`,
            // Resend supports an `idempotency_key` for duplicate
            // suppression. Use the outbox event id when available.
            ...(context?.eventId
              ? { idempotency_key: `kzq-outbox-${context.eventId}` }
              : {}),
          }),
          cache: "no-store",
        },
        runtime,
      );
      // Resend returns { id: "re_xxx" } on success.
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
