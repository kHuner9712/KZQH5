import { NextRequest, NextResponse } from "next/server";
import { createWechatJsSdkConfig, isWechatConfigured } from "@/lib/services/wechat/jssdk";
import { checkRateLimitKeys } from "@/lib/services/http-security";
import { getWechatJsSdkRateLimiter } from "@/lib/services/rate-limit";

export const dynamic = "force-dynamic";

function allowedOrigin(request: NextRequest, target: URL): boolean {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  const origins = new Set([request.nextUrl.origin]);
  if (configured) {
    try { origins.add(new URL(configured).origin); } catch { /* 配置错误时仅允许当前请求域名。 */ }
  }
  return origins.has(target.origin);
}

export async function GET(request: NextRequest) {
  if (!isWechatConfigured()) return new NextResponse(null, { status: 204 });

  // Phase 6: rate limit (per IP, two-layer model). WeChat JS-SDK
  // config endpoint calls the WeChat backend API (access_token +
  // jsapi_ticket) which has a shared quota. Without rate limiting,
  // an attacker could exhaust the quota and break JS-SDK for all
  // users. Limit: 20 / 60s / IP — generous for legitimate page loads.
  const rate = await checkRateLimitKeys(request, getWechatJsSdkRateLimiter());
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "Cache-Control": "private, no-store",
        },
      },
    );
  }

  const rawUrl = request.nextUrl.searchParams.get("url");
  if (!rawUrl || rawUrl.length > 2000) {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  let target: URL;
  try { target = new URL(rawUrl); } catch { return NextResponse.json({ error: "Invalid URL" }, { status: 400 }); }
  if (!allowedOrigin(request, target)) {
    return NextResponse.json({ error: "URL origin is not allowed" }, { status: 400 });
  }
  try {
    const config = await createWechatJsSdkConfig(target.toString());
    return NextResponse.json(config, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("WeChat JS-SDK configuration failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "WeChat service unavailable" }, { status: 503 });
  }
}
