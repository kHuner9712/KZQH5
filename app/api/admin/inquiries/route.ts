import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import { listInquiries, updateInquiry } from "@/lib/repositories/inquiries";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";
import { inquiryFiltersFromSearchParams } from "@/lib/services/inquiries/admin-filters";
import {
  isSameOrigin,
  readJsonBody,
  UUID_PATTERN,
} from "@/lib/services/http-security";
import type { InquiryStatus } from "@/types/database";

const validStatuses = new Set<InquiryStatus>(["new", "contacted", "closed"]);

export async function GET(request: NextRequest) {
  const admin = await getVerifiedAdmin();
  if (!admin)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await listInquiries(
      admin.client,
      inquiryFiltersFromSearchParams(request.nextUrl.searchParams),
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error(
      "Admin inquiry list failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "读取询盘失败" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await getVerifiedAdmin();
  if (!admin)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    id?: string;
    status?: InquiryStatus;
    is_read?: boolean;
    notes?: string;
    assignee?: string;
  };
  const parsed = await readJsonBody<typeof body>(request, 16 * 1024);
  if (!parsed.ok) {
    const error =
      parsed.status === 413
        ? "请求内容过大"
        : parsed.status === 415
          ? "仅接受 JSON 请求"
          : "请求格式错误";
    return NextResponse.json({ error }, { status: parsed.status });
  }
  body = parsed.value;
  if (!body.id || !UUID_PATTERN.test(body.id)) {
    return NextResponse.json({ error: "询盘 ID 无效" }, { status: 400 });
  }
  if (body.status && !validStatuses.has(body.status)) {
    return NextResponse.json({ error: "状态无效" }, { status: 400 });
  }

  const patch: {
    status?: InquiryStatus;
    is_read?: boolean;
    read_at?: string | null;
    notes?: string | null;
    assignee?: string | null;
  } = {};
  if (body.status) patch.status = body.status;
  if (typeof body.is_read === "boolean") {
    patch.is_read = body.is_read;
    patch.read_at = body.is_read ? new Date().toISOString() : null;
  }
  if (typeof body.notes === "string")
    patch.notes = body.notes.trim().slice(0, 4000) || null;
  if (typeof body.assignee === "string")
    patch.assignee = body.assignee.trim().slice(0, 200) || null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
  }

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      inquiry: { id: body.id, ...patch },
    });
  }

  try {
    const inquiry = await updateInquiry(admin.client, body.id, patch);
    return NextResponse.json({ success: true, inquiry });
  } catch (error) {
    console.error(
      "Admin inquiry update failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "更新询盘失败" }, { status: 500 });
  }
}
