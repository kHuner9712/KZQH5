/**
 * Product Assets [id] admin API (Section 4).
 *   PATCH   /api/admin/product-assets/[id]   -> update metadata
 *   DELETE  /api/admin/product-assets/[id]   -> delete with cleanup
 *
 * Both require expectedUpdatedAt (optimistic lock).
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import {
  deleteProductAsset,
  updateProductAssetMetadata,
} from "@/lib/services/admin-product-asset-write";
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
 * PATCH /api/admin/product-assets/[id]
 * Update metadata (non-storage fields). Does NOT change source ref or
 * publish state.
 *
 * Body:
 *   {
 *     "expectedUpdatedAt": string,  // required (optimistic lock)
 *     "payload": { ...Partial<ProductAssetPayload> },
 *     "accessLevel"?: "public"|"private",
 *     "sourceType"?: ...
 *   }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const guard = await requireAdminWrite<Record<string, unknown>>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body;
  const expectedUpdatedAt = body.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const rawPayload = body.payload;
  if (!rawPayload || typeof rawPayload !== "object") {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const p = rawPayload as Record<string, unknown>;

  // Validate asset_type if present
  if (p.asset_type !== undefined) {
    if (
      typeof p.asset_type !== "string" ||
      !VALID_ASSET_TYPES.includes(p.asset_type as ProductAssetType)
    ) {
      return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
    }
  }

  const accessLevel =
    typeof p.access_level === "string"
      ? (p.access_level as ProductAssetAccessLevel)
      : undefined;
  if (accessLevel && !VALID_ACCESS_LEVELS.includes(accessLevel)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const sourceType =
    typeof p.source_type === "string"
      ? (p.source_type as ProductAssetSourceType)
      : null;
  if (sourceType && !VALID_SOURCE_TYPES.includes(sourceType)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const payload = {
    product_id: typeof p.product_id === "string" ? p.product_id : undefined,
    asset_type: typeof p.asset_type === "string" ? (p.asset_type as ProductAssetType) : undefined,
    catalog_topic_id:
      typeof p.catalog_topic_id === "string" ? p.catalog_topic_id : undefined,
    title_cn: typeof p.title_cn === "string" ? p.title_cn : undefined,
    title_en: typeof p.title_en === "string" ? p.title_en : undefined,
    description_cn: typeof p.description_cn === "string" ? p.description_cn : undefined,
    description_en: typeof p.description_en === "string" ? p.description_en : undefined,
    cover_image_url: typeof p.cover_image_url === "string" ? p.cover_image_url : undefined,
    published_at: typeof p.published_at === "string" ? p.published_at : undefined,
    content_hash: typeof p.content_hash === "string" ? p.content_hash : undefined,
    sort_order: typeof p.sort_order === "number" ? p.sort_order : undefined,
    is_published: typeof p.is_published === "boolean" ? p.is_published : undefined,
  };

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      id,
      updatedAt: new Date().toISOString(),
    });
  }

  const result = await updateProductAssetMetadata(
    guard.client,
    {
      id,
      payload,
      expectedUpdatedAt,
      accessLevel,
      sourceType,
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

/**
 * DELETE /api/admin/product-assets/[id]
 * Atomically delete the row + enqueue published/source objects for cleanup.
 *
 * Body:
 *   { "expectedUpdatedAt": string }  // required (optimistic lock)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const guard = await requireAdminWrite<Record<string, unknown>>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body;
  const expectedUpdatedAt = body.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true, id });
  }

  const result = await deleteProductAsset(
    guard.client,
    { id, expectedUpdatedAt },
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
  return NextResponse.json({ success: true, id: result.data.id });
}
