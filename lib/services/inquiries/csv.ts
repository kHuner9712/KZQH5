import type { Inquiry } from "@/types/database";

function safeCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const columns: Array<{ label: string; value: (row: Inquiry) => unknown }> = [
  { label: "创建时间", value: (row) => row.created_at },
  { label: "状态", value: (row) => row.status },
  { label: "已读", value: (row) => row.is_read ? "是" : "否" },
  { label: "语言", value: (row) => row.language },
  { label: "来源", value: (row) => row.source },
  { label: "渠道", value: (row) => row.channel },
  { label: "姓名", value: (row) => row.name },
  { label: "公司", value: (row) => row.company },
  { label: "国家或地区", value: (row) => row.country },
  { label: "手机", value: (row) => row.phone },
  { label: "微信", value: (row) => row.wechat },
  { label: "Email", value: (row) => row.email },
  { label: "WhatsApp", value: (row) => row.whatsapp },
  { label: "产品", value: (row) => row.interested_product },
  { label: "产品清单", value: (row) => (row.inquiry_items || []).map((item) => {
    const name = item.product_name_cn || item.product_name_en || item.product_slug || "已删除产品";
    return `${name}${item.product_slug ? ` [${item.product_slug}]` : ""}${item.quantity ? ` × ${item.quantity}` : ""}`;
  }).join(" | ") },
  { label: "产品 ID", value: (row) => row.product_id },
  { label: "产品 Slug", value: (row) => row.product_slug },
  { label: "数量", value: (row) => row.quantity },
  { label: "留言", value: (row) => row.message },
  { label: "负责人", value: (row) => row.assignee },
  { label: "备注", value: (row) => row.notes },
  { label: "页面 URL", value: (row) => row.page_url },
  { label: "Referrer", value: (row) => row.referrer },
  { label: "utm_source", value: (row) => row.utm_source },
  { label: "utm_medium", value: (row) => row.utm_medium },
  { label: "utm_campaign", value: (row) => row.utm_campaign },
  { label: "utm_content", value: (row) => row.utm_content },
  { label: "utm_term", value: (row) => row.utm_term },
];

export function inquiriesToCsv(rows: Inquiry[]): string {
  const header = columns.map((column) => safeCell(column.label)).join(",");
  const body = rows.map((row) => columns.map((column) => safeCell(column.value(row))).join(","));
  return `\uFEFF${[header, ...body].join("\r\n")}`;
}
