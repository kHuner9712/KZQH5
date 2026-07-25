/**
 * Product Assets admin API (Section 4).
 *   GET    /api/admin/product-assets       -> list all assets (admin)
 *   POST   /api/admin/product-assets       -> create or update a draft
 *
 * All writes go through requireAdminWrite (admin session + RBAC "admin" +
 * same-origin + Content-Type + body size). The actual business write is
 * performed by a transactional RPC (save_product_asset_draft) that
 * enforces optimistic lock and writes audit atomically.
 *
 * The admin UI MUST call this route for writes — never the Browser
 * Supabase client. Reads (list) also go through this route so the UI no
 * longer needs the Browser Supabase client at all.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { saveProductAssetDraft } from "@/lib/services/admin-product-asset-write";
import { listAllProductAssets } from "@/lib/services/admin-product-asset-write";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";
import type {
  ProductAssetAccessLevel,
  ProductAssetSourceType,
  ProductAssetType,
} from "@/types/database";

const MAX_BODY = 256 * 1024;

function statusForCode(code: AdminWriteErrorCode): number {
  switch (code) {
    case "ADMIN_WRITE_BAD_REQUEST":
      return 400;
    case "ADMIN_WRITE_FORBIDDEN_ORIGIN":
    case "ADMIN_WRITE_FORBIDDEN_ROLE":
    case "ADMIN_WRITE_DEMO":
      return 403;
    case "ADMIN_WRITE_UNAUTHORIZED":
      return 401;
    case "ADMIN_WRITE_PAYLOAD_TOO_LARGE":
      return 413;
    case "ADMIN_WRITE_UNSUPPORTED_MEDIA":
      return 415;
    case "ADMIN_WRITE_CONFLICT":
      return 409;
    default:
      return 500;
  }
}

const VALID_ASSET_TYPES: readonly ProductAssetType[] = [
  "catalog",
  "datasheet",
  "installation",
  "certificate",
  "packaging",
  "other",
];
const VALID_ACCESS_LEVELS: readonly ProductAssetAccessLevel[] = ["public", "private"];
const VALID_SOURCE_TYPES: readonly ProductAssetSourceType[] = [
  "official",
  "self-produced",
  "licensed",
  "public-domain",
];

/**
 * GET /api/admin/product-assets
 * List all product assets (with product association) for the admin UI.
 *
 * The admin UI MUST call this route instead of reading product_assets
 * via the Browser Supabase client. Uses service_role.
 */
export async function GET() {
  const admin = await getVerifiedAdmin();
  if (!admin.ok) {
    return adminWriteError("ADMIN_WRITE_UNAUTHORIZED", 401);
  }

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      assets: [],
    });
  }

  const result = await listAllProductAssets(admin.client);
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  return NextResponse.json({
    success: true,
    assets: result.data,
  });
}

/**
 * POST /api/admin/product-assets
 * Create or update a product asset draft.
 *
 * Body:
 *   {
 *     "id"?: "<uuid>",               // null/omitted = insert
 *     "expectedUpdatedAt"?: string,  // required on update (optimistic lock)
 *     "payload": { ...ProductAssetPayload },
 *     "sourceBucket": "private-assets",
 *     "sourceObjectPath": "<server-generated path>",
 *     "mimeType"?: string,
 *     "fileSize"?: number,
 *     "sha256"?: string,
 *     "accessLevel"?: "public"|"private",
 *     "sourceType"?: "official"|...
 *   }
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<Record<string, unknown>>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body;

  // Validate required fields
  const sourceBucket = body.sourceBucket;
  if (typeof sourceBucket !== "string" || sourceBucket !== "private-assets") {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const sourceObjectPath = body.sourceObjectPath;
  if (typeof sourceObjectPath !== "string" || sourceObjectPath.trim().length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Validate payload shape
  const rawPayload = body.payload;
  if (!rawPayload || typeof rawPayload !== "object") {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const p = rawPayload as Record<string, unknown>;

  const assetType = p.asset_type;
  if (typeof assetType !== "string" || !VALID_ASSET_TYPES.includes(assetType as ProductAssetType)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const accessLevel = typeof p.access_level === "string" ? p.access_level : "private";
  if (!VALID_ACCESS_LEVELS.includes(accessLevel as ProductAssetAccessLevel)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const sourceType = typeof p.source_type === "string" ? p.source_type : null;
  if (sourceType && !VALID_SOURCE_TYPES.includes(sourceType as ProductAssetSourceType)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  // Build the validated payload
  const payload = {
    product_id: typeof p.product_id === "string" ? p.product_id : null,
    asset_type: assetType as ProductAssetType,
    catalog_topic_id: typeof p.catalog_topic_id === "string" ? p.catalog_topic_id : null,
    title_cn: typeof p.title_cn === "string" ? p.title_cn : "",
    title_en: typeof p.title_en === "string" ? p.title_en : null,
    description_cn: typeof p.description_cn === "string" ? p.description_cn : null,
    description_en: typeof p.description_en === "string" ? p.description_en : null,
    file_url: typeof p.file_url === "string" ? p.file_url : "",
    cover_image_url: typeof p.cover_image_url === "string" ? p.cover_image_url : null,
    file_size: typeof p.file_size === "number" ? p.file_size : null,
    mime_type: typeof p.mime_type === "string" ? p.mime_type : null,
    is_published: false, // Draft is never published
    sort_order: typeof p.sort_order === "number" ? p.sort_order : 0,
    published_at: typeof p.published_at === "string" ? p.published_at : null,
    content_hash: typeof p.content_hash === "string" ? p.content_hash : null,
  };

  const id = typeof body.id === "string" ? body.id : null;
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      id: id ?? `demo-${Date.now()}`,
      updatedAt: new Date().toISOString(),
    });
  }

  const result = await saveProductAssetDraft(
    guard.client,
    {
      id,
      payload,
      sourceBucket,
      sourceObjectPath,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : null,
      fileSize: typeof body.fileSize === "number" ? body.fileSize : null,
      sha256: typeof body.sha256 === "string" ? body.sha256 : null,
      expectedUpdatedAt,
      accessLevel: accessLevel as ProductAssetAccessLevel,
      sourceType: sourceType as ProductAssetSourceType | null,
    },
    {
      id: guard.user.id,
      email: guard.user.email,
      role: guard.profile.role,
    },
  );

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/products", "page");
  return NextResponse.json({
    success: true,
    id: result.data.id,
    updatedAt: result.data.updatedAt,
  });
}
