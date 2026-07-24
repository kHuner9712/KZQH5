import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { notifyNewInquiry } from "@/lib/services/inquiries/notifications";
import { submitInquiry } from "@/lib/services/inquiries/submission";
import { InquiryProductUnavailableError } from "@/lib/services/inquiries/submission";
import { validateInquiryInput } from "@/lib/services/inquiries/validation";
import {
  ephemeralRateKey,
  readJsonBody,
  UUID_PATTERN,
} from "@/lib/services/http-security";
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
    submissionId: "client_submission_id 格式不正确",
  },
  en: {
    rate: "Too many submissions. Please try again later.",
    json: "Invalid request body.",
    failed: "Submission failed. Please try again later.",
    server: "Service unavailable. Please try again later.",
    unavailable:
      "One or more selected products are no longer available. Refresh the list and try again.",
    type: "The request must use JSON.",
    large: "The payload is too large.",
    submissionId: "client_submission_id is malformed.",
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

  // Phase 5: idempotency. The browser generates a UUID per user-initiated
  // submit and reuses it across network retries. We validate strictly: if the
  // field is present it MUST be a UUID, otherwise we reject. We do NOT
  // generate one server-side because that would defeat retry reuse.
  let clientSubmissionId: string | null = null;
  if (body.client_submission_id !== undefined && body.client_submission_id !== null) {
    const candidate =
      typeof body.client_submission_id === "string"
        ? body.client_submission_id.trim()
        : "";
    if (!UUID_PATTERN.test(candidate)) {
      return NextResponse.json(
        { success: false, error: messages[locale].submissionId },
        { status: 400 },
      );
    }
    clientSubmissionId = candidate;
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
    const result = await submitInquiry(
      validation.record,
      validation.items,
      clientSubmissionId,
    );

    // Phase 5: never notify twice for the same inquiry. On an idempotent hit
    // (same client_submission_id already stored), skip the in-process
    // notification entirely — the original submit already triggered it.
    //
    // The Outbox row written in the same transaction is the canonical
    // guarantee of at-least-once delivery. The in-process call below is a
    // best-effort fast path; its failure cannot change the success result
    // because notifyNewInquiry uses Promise.allSettled and never rejects.
    if (!result.idempotent) {
      // Fire-and-forget with a guard so an unhandled rejection can never
      // crash the process. The Outbox remains the source of truth.
      void notifyNewInquiry(result.inquiry).catch(() => {
        /* swallowed: outbox will retry */
      });
    }

    return NextResponse.json({
      success: true,
      id: result.inquiry.id,
      submittedProductCount: result.submittedProductCount,
      idempotent: result.idempotent,
    });
  } catch (error) {
    if (error instanceof InquiryProductUnavailableError) {
      return NextResponse.json(
        { success: false, error: messages[locale].unavailable },
        { status: 400 },
      );
    }
    // Log a fixed coarse cause only — never the raw Supabase error which may
    // contain SQL text / parameter values / PII from the inquiry record.
    const causeName =
      error instanceof Error ? error.name : typeof error === "string" ? error : "UnknownError";
    console.error(`INQUIRY_SUBMIT_FAILED code=${causeName}`);
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
