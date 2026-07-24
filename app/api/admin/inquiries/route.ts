import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import { listInquiries, updateInquiry } from "@/lib/repositories/inquiries";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";
import { logAdminAction } from "@/lib/services/admin-audit";
import { inquiryFiltersFromSearchParams } from "@/lib/services/inquiries/admin-filters";
import {
  isSameSiteRequest,
  readJsonBody,
  UUID_PATTERN,
} from "@/lib/services/http-security";
import type { InquiryStatus } from "@/types/database";

const validStatuses = new Set<InquiryStatus>(["new", "contacted", "closed"]);

export async function GET(request: NextRequest) {
  const admin = await getVerifiedAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isSameSiteRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    id?: string;
    status?: InquiryStatus;
    is_read?: boolean;
    notes?: string;
    assignee?: string;
    expected_updated_at?: string | null;
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

  // Phase 3: validate expected_updated_at if present (optimistic locking).
  let expectedUpdatedAt: string | null = null;
  if (body.expected_updated_at != null && body.expected_updated_at !== "") {
    if (typeof body.expected_updated_at !== "string") {
      return NextResponse.json({ error: "expected_updated_at 格式不正确" }, { status: 400 });
    }
    const ts = body.expected_updated_at.trim();
    if (Number.isNaN(Date.parse(ts))) {
      return NextResponse.json({ error: "expected_updated_at 格式不正确" }, { status: 400 });
    }
    expectedUpdatedAt = ts;
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
    const inquiry = await updateInquiry(admin.client, body.id, patch, expectedUpdatedAt);

    // Phase 3: audit log (best-effort, never blocks the response).
    void logAdminAction(admin.client, {
      id: admin.user.id,
      email: admin.user.email,
      role: admin.profile.role,
    }, {
      action: "inquiry.update",
      targetType: "inquiry",
      targetId: body.id,
      summary: `Updated inquiry ${body.id}: ${Object.keys(patch).join(", ")}`,
    });

    revalidatePath("/admin");
    revalidatePath("/admin/inquiries");
    return NextResponse.json({ success: true, inquiry });
  } catch (error) {
    // Phase 3: detect optimistic lock conflict (stale updated_at).
    const errorCode = (error as Error & { code?: string }).code;
    if (errorCode === "40P01" || errorCode === "40001" || errorCode === "23505") {
      return NextResponse.json(
        { error: "该询盘已被其他人更新，请刷新后重试" },
        { status: 409 },
      );
    }
    console.error(
      "Admin inquiry update failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "更新询盘失败" }, { status: 500 });
  }
}
