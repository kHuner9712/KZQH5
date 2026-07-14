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

export interface NotificationAdapter {
  name: "wecom" | "email";
  configured: boolean;
  send(inquiry: Inquiry): Promise<void>;
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
    if (text) {
      try {
        JSON.parse(text);
      } catch {
        throw new Error("Invalid JSON response");
      }
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
    async send(inquiry) {
      if (!config.wecomWebhookUrl) return;
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
    },
  };

  const email: NotificationAdapter = {
    name: "email",
    configured: Boolean(
      config.resendApiKey && config.resendFrom && config.resendTo,
    ),
    async send(inquiry) {
      if (!config.resendApiKey || !config.resendFrom || !config.resendTo)
        return;
      const content = lines(inquiry);
      await postJson(
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
          }),
          cache: "no-store",
        },
        runtime,
      );
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
