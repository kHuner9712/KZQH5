import type { Locale } from "@/lib/i18n/config";
import type { InquiryInput, InquiryStatus } from "@/types/database";

export interface ValidatedInquiryItem {
  product_id: string;
  slug: string;
  name_cn: string;
  name_en: string | null;
  cover_image_url: string | null;
  quantity: string;
}

export interface InquiryCreateRecord {
  [key: string]: unknown;
  name: string;
  company: string | null;
  country: string | null;
  phone: string | null;
  wechat: string | null;
  email: string | null;
  whatsapp: string | null;
  interested_product: string;
  quantity: string | null;
  message: string | null;
  status: InquiryStatus;
  language: Locale;
  source: string | null;
  channel: string | null;
  page_url: string | null;
  referrer: string | null;
  product_id: string | null;
  product_slug: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  is_read: boolean;
  read_at: string | null;
  notes: string | null;
  assignee: string | null;
}

const copy = {
  zh: {
    name: "姓名不能为空",
    contact: "请至少填写手机号或微信号之一",
    product: "请填写感兴趣产品",
    email: "邮箱格式不正确",
    privacy: "请阅读并同意隐私政策",
    productContext: "产品上下文格式不正确",
    spam: "留言内容包含过多链接，请检查后重试",
  },
  en: {
    name: "Name is required.",
    contact: "Please provide an email address or WhatsApp number.",
    product: "Please specify the product you are interested in.",
    email: "Please enter a valid email address.",
    privacy: "Please read and agree to the Privacy Policy.",
    productContext: "The product context is invalid.",
    spam: "The message contains too many links. Please review it and try again.",
  },
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function value(input: unknown, maximum: number): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().slice(0, maximum);
  return trimmed || null;
}

function hasTooManyLinks(message: string): boolean {
  return (
    (message.match(/https?:\/\//gi) || []).length +
    (message.match(/www\./gi) || []).length
  ) >= 3;
}

function buildMessage(input: InquiryInput): string | null {
  const message = value(input.message, 2000);
  if (input.locale !== "en") return message;

  const details: string[] = [];
  const destinationPort = value(input.destination_port, 120);
  const tradeTerm = value(input.trade_term, 80);
  if (destinationPort) details.push(`[Destination Port] ${destinationPort}`);
  if (tradeTerm) details.push(`[Trade Term] ${tradeTerm}`);
  if (!details.length) return message;
  if (message) details.push(`[Message]\n${message}`);
  return details.join("\n").slice(0, 2000);
}

export type InquiryValidationResult =
  | { success: true; record: InquiryCreateRecord; items: ValidatedInquiryItem[] }
  | { success: false; error: string };

export function validateInquiryInput(
  input: InquiryInput,
  locale: Locale,
  allowMockProductIds = false
): InquiryValidationResult {
  const messages = copy[locale];
  const name = value(input.name, 100);
  const phone = value(input.phone, 50);
  const wechat = value(input.wechat, 100);
  const email = value(input.email, 200);
  const whatsapp = value(input.whatsapp, 50);
  const interestedProduct = value(input.interested_product, 300);
  const productId = value(input.product_id, 36);
  const message = buildMessage({ ...input, locale });
  const rawItems = Array.isArray(input.items) ? input.items.slice(0, 30) : [];
  const items: ValidatedInquiryItem[] = [];
  for (const item of rawItems) {
    const itemId = value(item?.product_id, 36);
    const slug = value(item?.slug, 200);
    const nameCn = value(item?.name_cn, 300);
    if (!itemId || (!UUID_PATTERN.test(itemId) && !(allowMockProductIds && itemId.startsWith("mock-"))) || !slug || !nameCn) {
      return { success: false, error: messages.productContext };
    }
    if (items.some((existing) => existing.product_id === itemId)) continue;
    items.push({
      product_id: itemId,
      slug,
      name_cn: nameCn,
      name_en: value(item.name_en, 300),
      cover_image_url: value(item.cover_image_url, 1000),
      quantity: value(item.quantity, 100) || "",
    });
  }

  if (!name) return { success: false, error: messages.name };
  if (locale === "zh" && !phone && !wechat) {
    return { success: false, error: messages.contact };
  }
  if (locale === "en" && !email && !whatsapp) {
    return { success: false, error: messages.contact };
  }
  if (!interestedProduct) return { success: false, error: messages.product };
  if (email && !EMAIL_PATTERN.test(email)) {
    return { success: false, error: messages.email };
  }
  if (input.privacy_accepted !== true) {
    return { success: false, error: messages.privacy };
  }
  if (productId && !UUID_PATTERN.test(productId)) {
    return { success: false, error: messages.productContext };
  }
  if (message && hasTooManyLinks(message)) {
    return { success: false, error: messages.spam };
  }

  return {
    success: true,
    items,
    record: {
      name,
      company: value(input.company, 200),
      country: value(input.country, 100),
      phone,
      wechat,
      email,
      whatsapp,
      interested_product: interestedProduct,
      quantity: value(input.quantity, 100),
      message,
      status: "new",
      language: locale,
      source: value(input.source, 80) || "direct",
      channel: value(input.channel, 80),
      page_url: value(input.page_url, 1000),
      referrer: value(input.referrer, 1000),
      product_id: productId,
      product_slug: value(input.product_slug, 200),
      utm_source: value(input.utm_source, 200),
      utm_medium: value(input.utm_medium, 200),
      utm_campaign: value(input.utm_campaign, 200),
      utm_content: value(input.utm_content, 200),
      utm_term: value(input.utm_term, 200),
      is_read: false,
      read_at: null,
      notes: null,
      assignee: null,
    },
  };
}
