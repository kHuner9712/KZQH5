import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { InquiryInput } from "@/types/database";

// 询盘提交接口（匿名可访问）
// 使用 service_role 写入，避免暴露 anon 写权限问题，并跳过 RLS
export async function POST(request: NextRequest) {
  let body: InquiryInput;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "请求体格式错误" },
      { status: 400 }
    );
  }

  // 基础校验
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

  // 字段长度限制（防止滥用）
  const sanitize = (v: string | undefined, max: number) =>
    (v || "").slice(0, max);

  const payload = {
    name: sanitize(name, 100),
    company: sanitize(body.company, 200),
    country: sanitize(body.country, 100),
    email: sanitize(body.email, 200),
    whatsapp: sanitize(body.whatsapp, 50),
    interested_product: sanitize(body.interested_product, 300),
    quantity: sanitize(body.quantity, 100),
    message: sanitize(body.message, 2000),
    status: "new" as const,
    source: "h5",
  };

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
