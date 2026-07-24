import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import { listInquiries } from "@/lib/repositories/inquiries";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";
import { inquiryFiltersFromSearchParams } from "@/lib/services/inquiries/admin-filters";
import {
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import { UUID_PATTERN } from "@/lib/services/http-security";
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

interface InquiryPatchBody {
  id?: string;
  status?: InquiryStatus;
  is_read?: boolean;
  notes?: string;
  assignee?: string;
  expected_updated_at?: string | null;
}

export async function PATCH(request: NextRequest) {
  // Migrated from isSameSiteRequest (fail-open for missing Origin) to
  // requireAdminWrite (fail-closed). This enforces:
  //   1. Valid admin session (401 if missing)
  //   2. RBAC: minimum role "admin" (403 if editor/viewer/unknown)
  //   3. Origin present AND same-origin (403 if missing/cross-origin)
  //   4. Sec-Fetch-Site same-origin/none/absent (403 if cross-site/same-site)
  //   5. application/json Content-Type (415 if not)
  //   6. Body size <= 16KB (413 if exceeded)
  //   7. JSON parse success (400 if malformed)
  const guard = await requireAdminWrite<InquiryPatchBody>(request, {
    maxBytes: 16 * 1024,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body;
  if (!body.id || !UUID_PATTERN.test(body.id)) {
    return NextResponse.json({ error: "询盘 ID 无效" }, { status: 400 });
  }
  if (body.status && !validStatuses.has(body.status)) {
    return NextResponse.json({ error: "状态无效" }, { status: 400 });
  }

  // Phase 3: expected_updated_at is REQUIRED for inquiry updates (optimistic
  // locking). The caller MUST prove they saw a recent version before modifying.
  // Missing => 400. Invalid => 400. Stale => 409 (from RPC).
  if (body.expected_updated_at == null || body.expected_updated_at === "") {
    return NextResponse.json(
      { error: "expected_updated_at 为必填字段" },
      { status: 400 },
    );
  }
  if (typeof body.expected_updated_at !== "string") {
    return NextResponse.json({ error: "expected_updated_at 格式不正确" }, { status: 400 });
  }
  const ts = body.expected_updated_at.trim();
  if (Number.isNaN(Date.parse(ts))) {
    return NextResponse.json({ error: "expected_updated_at 格式不正确" }, { status: 400 });
  }
  const expectedUpdatedAt: string = ts;

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
    // Phase 13: use transactional RPC for atomic business write + audit.
    // Actor info comes from the server-verified admin session.
    const { data, error } = await guard.client.rpc("update_inquiry_with_audit", {
      p_id: body.id,
      p_patch: patch,
      p_expected_updated_at: expectedUpdatedAt,
      p_actor_id: guard.user.id,
      p_actor_email: guard.user.email ?? null,
      p_actor_role: guard.profile.role ?? null,
    });

    if (error) {
      const errorCode = error.code;
      if (errorCode === "40P01" || errorCode === "40001" || errorCode === "23505") {
        return NextResponse.json(
          { error: "该询盘已被其他人更新，请刷新后重试" },
          { status: 409 },
        );
      }
      if (errorCode === "P0002") {
        return NextResponse.json({ error: "询盘不存在" }, { status: 404 });
      }
      console.error(
        "Admin inquiry update failed:",
        "code:" + (errorCode ?? "unknown"),
      );
      return NextResponse.json({ error: "更新询盘失败" }, { status: 500 });
    }

    revalidatePath("/admin");
    revalidatePath("/admin/inquiries");
    return NextResponse.json({ success: true, inquiry: data });
  } catch (error) {
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
