import { NextRequest, NextResponse } from "next/server";
import { createWechatJsSdkConfig, isWechatConfigured } from "@/lib/services/wechat/jssdk";

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
