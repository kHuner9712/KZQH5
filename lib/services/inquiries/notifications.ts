import type { Inquiry } from "@/types/database";

const NOTIFICATION_TIMEOUT_MS = 5000;

async function fetchWithTimeout(
  input: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFICATION_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
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
  ].filter(Boolean).join("; ");

  const productItems = (inquiry.inquiry_items || []).map((item, index) => {
    const name = item.product_name_cn || item.product_name_en || item.product_slug || "已删除产品";
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
  return input.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] || character);
}

async function sendWeCom(inquiry: Inquiry): Promise<void> {
  const webhook = process.env.INQUIRY_WECOM_WEBHOOK_URL;
  if (!webhook) return;
  const response = await fetchWithTimeout(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content: `**KZQ 新询盘**\n>${lines(inquiry).join("\n>")}` },
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`WeCom HTTP ${response.status}`);
}

async function sendEmail(inquiry: Inquiry): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.INQUIRY_NOTIFICATION_FROM;
  const to = process.env.INQUIRY_NOTIFICATION_TO;
  if (!apiKey || !from || !to) return;

  const content = lines(inquiry);
  const response = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: to.split(",").map((address) => address.trim()).filter(Boolean),
      subject: `[KZQ] 新询盘 - ${inquiry.name}`,
      text: content.join("\n"),
      html: `<h2>KZQ 新询盘</h2>${content.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}`,
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Email HTTP ${response.status}`);
}

export async function notifyNewInquiry(inquiry: Inquiry): Promise<void> {
  const adapters = [
    { name: "wecom", run: () => sendWeCom(inquiry) },
    { name: "email", run: () => sendEmail(inquiry) },
  ];
  const results = await Promise.allSettled(adapters.map((adapter) => adapter.run()));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      // 不记录 webhook、API key 或完整响应正文，避免密钥进入日志。
      console.error(`Inquiry notification failed (${adapters[index].name}):`,
        result.reason instanceof Error ? result.reason.message : "unknown error");
    }
  });
}
