import { NextRequest, NextResponse } from "next/server";
import { recordAnalyticsEvent } from "@/lib/repositories/analytics";
import { validateAnalyticsEvent } from "@/lib/services/analytics/validation";
import { getAnalyticsRateLimiter } from "@/lib/services/rate-limit";

const MAX_BODY_BYTES = 8 * 1024;

function ephemeralRateKey(request: NextRequest): string {
  // 只用于当前进程的短时限流；不会写入数据库、日志或事件记录。
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ success: false, error: "Payload too large" }, { status: 413 });
  }
  const rate = await getAnalyticsRateLimiter().check(ephemeralRateKey(request));
  if (!rate.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many events" },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
    );
  }

  let raw = "";
  try {
    raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return NextResponse.json({ success: false, error: "Payload too large" }, { status: 413 });
    }
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }
  const validation = validateAnalyticsEvent(body);
  if (!validation.success) {
    return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
  }

  try {
    await recordAnalyticsEvent(validation.event);
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Analytics event insert failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ success: false, error: "Service unavailable" }, { status: 503 });
  }
}

export function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405 });
}
