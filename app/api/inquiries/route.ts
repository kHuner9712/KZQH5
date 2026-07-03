import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/demo";
import type { InquiryInput } from "@/types/database";

// ============================================================
// 询盘提交接口（匿名可访问）
// 使用 service_role 写入，避免暴露 anon 写权限问题，并跳过 RLS
// 防滥用：
//   1. 服务端 honeypot 检测（honeypot / company_website 字段）
//   2. 内存级 IP + User-Agent 限流（10 分钟内最多 5 次）
//   3. message 垃圾内容基础判断（URL 数量过多拒绝）
//   4. 字段校验：name 必填、email 格式、email/whatsapp 至少一个、长度限制
// 注意：Vercel serverless 环境中内存限流不是强一致，仅作为第一层保护
// ============================================================

// ---------- 内存级限流 ----------
interface RateLimitEntry {
  count: number;
  firstRequestAt: number;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 分钟
const RATE_LIMIT_MAX = 5; // 最多 5 次
const rateLimitMap = new Map<string, RateLimitEntry>();

// 定期清理过期条目，避免内存无限增长（每次调用时惰性清理）
function cleanExpiredRateLimitEntries(now: number): void {
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.firstRequestAt > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }
}

function checkRateLimit(ip: string, userAgent: string): boolean {
  const now = Date.now();
  cleanExpiredRateLimitEntries(now);
  const key = `${ip}::${userAgent.slice(0, 100)}`;
  const entry = rateLimitMap.get(key);
  if (!entry) {
    rateLimitMap.set(key, { count: 1, firstRequestAt: now });
    return true;
  }
  // 窗口已过，重置
  if (now - entry.firstRequestAt > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, firstRequestAt: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

// 获取客户端 IP（兼容 Vercel 转发头）
function getClientIP(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    return xff.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

// ---------- message 垃圾内容基础判断 ----------
function isSpammyMessage(message: string): boolean {
  // URL 数量过多视为垃圾内容（匹配 http:// https:// www. 等）
  const urlMatches = message.match(/https?:\/\//gi) || [];
  const wwwMatches = message.match(/www\./gi) || [];
  const totalUrls = urlMatches.length + wwwMatches.length;
  return totalUrls >= 3;
}

export async function POST(request: NextRequest) {
  // ---------- 限流检查 ----------
  const ip = getClientIP(request);
  const userAgent = request.headers.get("user-agent") || "";
  if (!checkRateLimit(ip, userAgent)) {
    return NextResponse.json(
      { success: false, error: "提交过于频繁，请稍后再试" },
      { status: 429 }
    );
  }

  let body: InquiryInput & { honeypot?: string; company_website?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "请求体格式错误" },
      { status: 400 }
    );
  }

  // ---------- 服务端 honeypot 检测 ----------
  // honeypot 或 company_website 有值 → 垃圾机器人
  // 返回 success: true 让机器人以为成功，但不写入数据库
  const honeypotValue = (body.honeypot || body.company_website || "").trim();
  if (honeypotValue) {
    return NextResponse.json({ success: true, id: null });
  }

  // ---------- 基础字段校验 ----------
  const name = (body.name || "").trim();
  if (!name) {
    return NextResponse.json(
      { success: false, error: "姓名不能为空" },
      { status: 400 }
    );
  }

  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return NextResponse.json(
      { success: false, error: "邮箱格式不正确" },
      { status: 400 }
    );
  }

  // 至少留一种联系方式
  if (!body.email && !body.whatsapp) {
    return NextResponse.json(
      { success: false, error: "请至少填写邮箱或 WhatsApp 之一" },
      { status: 400 }
    );
  }

  // ---------- 字段长度限制（防止滥用） + message 垃圾判断 ----------
  const sanitize = (v: string | undefined, max: number) =>
    (v || "").slice(0, max);

  const messageRaw = sanitize(body.message, 2000);
  if (messageRaw && isSpammyMessage(messageRaw)) {
    return NextResponse.json(
      { success: false, error: "留言内容包含过多链接，请检查后重试" },
      { status: 400 }
    );
  }

  const payload = {
    name: sanitize(name, 100),
    company: sanitize(body.company, 200),
    country: sanitize(body.country, 100),
    email: sanitize(body.email, 200),
    whatsapp: sanitize(body.whatsapp, 50),
    interested_product: sanitize(body.interested_product, 300),
    quantity: sanitize(body.quantity, 100),
    message: messageRaw,
    status: "new" as const,
    source: "h5",
  };

  // ---------- Demo 模式：不写入 Supabase，直接返回成功 ----------
  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      id: `demo-inquiry-${Date.now()}`,
      demo: true,
    });
  }

  try {
    const supabase = createAdminSupabaseClient();
    const { data, error } = await supabase
      .from("inquiries")
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      console.error("写入询盘失败:", error);
      return NextResponse.json(
        { success: false, error: "提交失败，请稍后重试" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, id: data?.id });
  } catch (err) {
    console.error("询盘接口异常:", err);
    return NextResponse.json(
      { success: false, error: "服务异常，请稍后重试" },
      { status: 500 }
    );
  }
}

// 禁止 GET
export async function GET() {
  return NextResponse.json(
    { success: false, error: "Method Not Allowed" },
    { status: 405 }
  );
}
