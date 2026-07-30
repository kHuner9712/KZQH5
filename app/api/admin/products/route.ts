/**
 * Phase 2 admin product write endpoints.
 *
 *   GET    /api/admin/products          -> list products (paged/filtered, service_role)
 *   POST   /api/admin/products          -> create or update a product (+ images)
 *   PATCH  /api/admin/products          -> bulk update (publish/feature/category)
 *
 * GET uses requireAdminRead() (Phase 9): auth + global/per-admin rate
 * limit + RBAC (minimumRole "editor") + CSRF (isSameSiteRequest for GET).
 * It queries via the service_role client so drafts (is_published=false)
 * are visible to admins — the anon client is RLS-filtered to published
 * rows only and must NOT be used here.
 *
 * Both write endpoints go through requireAdminWrite():
 *   1. service_role admin verification (getVerifiedAdmin)
 *   2. fail-closed same-origin check
 *   3. application/json Content-Type
 *   4. 256KB max body
 *   5. JSON parse
 *
 * The product payload is then validated by validateProductPayload() and
 * persisted via the transactional save_product_with_images RPC, which
 * inserts/updates the product and replaces its images in a single
 * transaction. Partial image failure rolls back the product save.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  requireAdminWrite,
  requireAdminRead,
  adminWriteError,
} from "@/lib/services/admin-write-boundary";
import {
  bulkUpdateProducts,
  saveProductViaRpc,
  validateProductPayload,
} from "@/lib/services/admin-product-write";
import { isUuid, validateOptionalUuid } from "@/lib/validation/admin-write";
import { normalizeSearchTerm } from "@/lib/utils";
import type { Product, Category, Subcategory } from "@/types/database";

export const dynamic = "force-dynamic";

const MAX_BODY = 256 * 1024;

type StatusFilter = "all" | "published" | "draft" | "featured";
type SortKey = "default" | "updated" | "name";

function parsePage(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(1000, Math.floor(n));
}

function parsePageSize(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(100, Math.floor(n));
}

function parseStatus(raw: string | null): StatusFilter {
  if (raw === "published" || raw === "draft" || raw === "featured") return raw;
  return "all";
}

function parseSort(raw: string | null): SortKey {
  if (raw === "updated" || raw === "name") return raw;
  return "default";
}

export async function GET(request: NextRequest) {
  // Phase 9: requireAdminRead enforces auth + global/per-admin rate limit +
  // RBAC(minimum editor) + CSRF (isSameSiteRequest for GET).
  const guard = await requireAdminRead(request, { minimumRole: "editor" });
  if (!guard.ok) return guard.response;

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      products: [],
      total: 0,
      categories: [],
      subcategories: [],
    }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const url = new URL(request.url);
  const page = parsePage(url.searchParams.get("page"));
  const pageSize = parsePageSize(url.searchParams.get("pageSize"));
  const statusFilter = parseStatus(url.searchParams.get("status"));
  const sort = parseSort(url.searchParams.get("sort"));
  const categoryIdRaw = url.searchParams.get("categoryId");
  const subcategoryIdRaw = url.searchParams.get("subcategoryId");
  const categoryId = categoryIdRaw && isUuid(categoryIdRaw) ? categoryIdRaw : null;
  const subcategoryId = subcategoryIdRaw && isUuid(subcategoryIdRaw) ? subcategoryIdRaw : null;
  const safeSearch = normalizeSearchTerm(url.searchParams.get("search") ?? "");

  // Build the list + count queries with identical filters so the count
  // matches the paged rows. service_role bypasses RLS, so drafts are
  // returned when statusFilter === "draft" or "all".
  let listQuery = guard.client.from("products").select("*");
  let countQuery = guard.client
    .from("products")
    .select("id", { count: "exact", head: true });

  if (statusFilter === "published") {
    listQuery = listQuery.eq("is_published", true);
    countQuery = countQuery.eq("is_published", true);
  } else if (statusFilter === "draft") {
    listQuery = listQuery.eq("is_published", false);
    countQuery = countQuery.eq("is_published", false);
  } else if (statusFilter === "featured") {
    listQuery = listQuery.eq("is_featured", true);
    countQuery = countQuery.eq("is_featured", true);
  }

  if (categoryId) {
    listQuery = listQuery.eq("category_id", categoryId);
    countQuery = countQuery.eq("category_id", categoryId);
  }
  if (subcategoryId) {
    listQuery = listQuery.eq("subcategory_id", subcategoryId);
    countQuery = countQuery.eq("subcategory_id", subcategoryId);
  }

  if (safeSearch) {
    // normalizeSearchTerm strips % , . ( ) : and whitespace, so it is safe
    // to interpolate into the PostgREST .or() expression.
    const orExpr = `name_cn.ilike.%${safeSearch}%,name_en.ilike.%${safeSearch}%,slug.ilike.%${safeSearch}%`;
    listQuery = listQuery.or(orExpr);
    countQuery = countQuery.or(orExpr);
  }

  if (sort === "updated") {
    listQuery = listQuery.order("updated_at", { ascending: false });
  } else if (sort === "name") {
    listQuery = listQuery.order("name_cn", { ascending: true });
  } else {
    listQuery = listQuery
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
  }

  const from = (page - 1) * pageSize;
  const to = page * pageSize - 1;
  listQuery = listQuery.range(from, to);

  const [listRes, countRes, catsRes, subsRes] = await Promise.all([
    listQuery,
    countQuery,
    guard.client.from("categories").select("*").order("sort_order"),
    guard.client.from("subcategories").select("*").order("sort_order"),
  ]);

  const products = (listRes.data as Product[] | null) || [];
  const categories = (catsRes.data as Category[] | null) || [];
  const subcategories = (subsRes.data as Subcategory[] | null) || [];

  return NextResponse.json(
    {
      success: true,
      products,
      total: countRes.count || 0,
      categories,
      subcategories,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

function failStatus(code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_CONFLICT" | "ADMIN_WRITE_FAILED"): number {
  if (code === "ADMIN_WRITE_BAD_REQUEST") return 400;
  if (code === "ADMIN_WRITE_CONFLICT") return 409;
  return 500;
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<unknown>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const validated = validateProductPayload(guard.body);
  if (!validated.ok) {
    return NextResponse.json(
      { error: "ADMIN_WRITE_BAD_REQUEST", fields: validated.errors },
      { status: 400 },
    );
  }

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      id: validated.value.id ?? `demo-${Date.now()}`,
    });
  }

  const result = await saveProductViaRpc(guard.client, validated.value, {
    id: guard.user.id,
    email: guard.user.email,
    role: guard.profile.role,
  });
  if (!result.ok) {
    return adminWriteError(result.code, failStatus(result.code), { logCode: result.code });
  }

  // Phase 13: audit is now atomic with the business write via RPC.
  // No fire-and-forget logAdminAction call needed.

  revalidatePath("/admin", "layout");
  revalidatePath("/products", "page");
  revalidatePath("/", "page");
  return NextResponse.json({ success: true, id: result.id });
}

export async function PATCH(request: NextRequest) {
  const guard = await requireAdminWrite<unknown>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body as Record<string, unknown>;
  const idsRaw = body.ids;
  if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }
  const ids = idsRaw.filter(isUuid);
  if (ids.length !== idsRaw.length) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }

  // Build a whitelisted patch. Only is_published / is_featured / category_id
  // / subcategory_id are accepted in bulk mode.
  const patch: Record<string, unknown> = {};
  if (typeof body.is_published === "boolean") patch.is_published = body.is_published;
  if (typeof body.is_featured === "boolean") patch.is_featured = body.is_featured;
  if (body.category_id !== undefined) {
    const cat = validateOptionalUuid("category_id", body.category_id);
    if (!cat.ok) {
      return NextResponse.json(
        { error: "ADMIN_WRITE_BAD_REQUEST", fields: cat.errors },
        { status: 400 },
      );
    }
    patch.category_id = cat.value;
  }
  if (body.subcategory_id !== undefined) {
    const sub = validateOptionalUuid("subcategory_id", body.subcategory_id);
    if (!sub.ok) {
      return NextResponse.json(
        { error: "ADMIN_WRITE_BAD_REQUEST", fields: sub.errors },
        { status: 400 },
      );
    }
    patch.subcategory_id = sub.value;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "ADMIN_WRITE_BAD_REQUEST" }, { status: 400 });
  }

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true, count: ids.length });
  }

  const result = await bulkUpdateProducts(guard.client, ids, patch, {
    id: guard.user.id,
    email: guard.user.email,
    role: guard.profile.role,
  });
  if (!result.ok) {
    return adminWriteError(result.code, failStatus(result.code), { logCode: result.code });
  }

  // Phase 13: audit is now atomic with the business write via RPC.

  revalidatePath("/admin", "layout");
  revalidatePath("/products", "page");
  return NextResponse.json({ success: true, count: result.count });
}
