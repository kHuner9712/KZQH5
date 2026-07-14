import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { notifyNewInquiry } from "@/lib/services/inquiries/notifications";
import { submitInquiry } from "@/lib/services/inquiries/submission";
import { InquiryProductUnavailableError } from "@/lib/services/inquiries/submission";
import { validateInquiryInput } from "@/lib/services/inquiries/validation";
import { ephemeralRateKey, readJsonBody } from "@/lib/services/http-security";
import { getInquiryRateLimiter } from "@/lib/services/rate-limit";
import type { InquiryInput } from "@/types/database";

const messages = {
  zh: {
    rate: "提交过于频繁，请稍后再试",
    json: "请求体格式错误",
    failed: "提交失败，请稍后重试",
    server: "服务异常，请稍后重试",
    unavailable: "询盘清单中有产品已下架或不存在，请刷新后重新提交。",
    type: "请求必须使用 JSON 格式",
    large: "请求内容过大",
  },
  en: {
    rate: "Too many submissions. Please try again later.",
    json: "Invalid request body.",
    failed: "Submission failed. Please try again later.",
    server: "Service unavailable. Please try again later.",
    unavailable:
      "One or more selected products are no longer available. Refresh the list and try again.",
    type: "The request must use JSON.",
    large: "The request payload is too large.",
  },
} as const;

function requestLocale(request: NextRequest, body?: InquiryInput): Locale {
  if (isLocale(body?.locale)) return body.locale;
  return request.headers.get("accept-language")?.toLowerCase().startsWith("en")
    ? "en"
    : "zh";
}

export async function POST(request: NextRequest) {
  const earlyLocale = requestLocale(request);
  const rateKey = ephemeralRateKey(request);
  const rate = await getInquiryRateLimiter().check(rateKey);
  if (!rate.allowed) {
    return NextResponse.json(
      { success: false, error: messages[earlyLocale].rate },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const parsed = await readJsonBody<
    InquiryInput & { honeypot?: string; company_website?: string }
  >(request, 32 * 1024);
  if (!parsed.ok) {
    const error =
      parsed.status === 413
        ? messages[earlyLocale].large
        : parsed.status === 415
          ? messages[earlyLocale].type
          : messages[earlyLocale].json;
    return NextResponse.json(
      { success: false, error },
      { status: parsed.status },
    );
  }
  let body = parsed.value;

  const locale = requestLocale(request, body);
  if ((body.honeypot || body.company_website || "").trim()) {
    return NextResponse.json({ success: true, id: null });
  }

  const demoMode = isDemoMode();
  if (demoMode && body.product_id?.startsWith("mock-")) {
    body = { ...body, product_id: undefined };
  }
  const validation = validateInquiryInput(body, locale, demoMode);
  if (!validation.success) {
    return NextResponse.json(
      { success: false, error: validation.error },
      { status: 400 },
    );
  }

  if (demoMode) {
    return NextResponse.json({
      success: true,
      id: `demo-inquiry-${Date.now()}`,
      demo: true,
      submittedProductCount: Array.isArray(body.items)
        ? new Set(body.items.map((item) => item.product_id)).size
        : 0,
    });
  }

  try {
    const result = await submitInquiry(validation.record, validation.items);
    await notifyNewInquiry(result.inquiry);
    return NextResponse.json({
      success: true,
      id: result.inquiry.id,
      submittedProductCount: result.submittedProductCount,
    });
  } catch (error) {
    if (error instanceof InquiryProductUnavailableError) {
      return NextResponse.json(
        { success: false, error: messages[locale].unavailable },
        { status: 400 },
      );
    }
    console.error(
      "Inquiry submission failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json(
      { success: false, error: messages[locale].server },
      { status: 500 },
    );
  }
}

export function GET() {
  return NextResponse.json(
    { success: false, error: "Method Not Allowed" },
    { status: 405 },
  );
}
