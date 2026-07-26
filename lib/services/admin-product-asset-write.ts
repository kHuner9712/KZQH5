/**
 * Product Asset admin write service (Section 4).
 *
 * Trusted server-side boundary for all product_assets CRUD operations.
 * The admin UI MUST call the /api/admin/product-assets/* routes which
 * in turn call these functions — never the Browser Supabase client.
 *
 * Every write goes through a transactional RPC that:
 *   - enforces optimistic lock (expected_updated_at required)
 *   - writes audit in the same transaction (no best-effort audit)
 *   - enqueues replaced/old storage objects for cleanup atomically
 *
 * Errors are classified into coarse-grained AdminWriteErrorCode values;
 * SQL / internal details are never forwarded to the client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ProductAsset } from "@/types/database";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import {
  validateProductAssetPayload,
  type ProductAssetPayload,
} from "@/lib/validation/product-asset";
import type {
  ProductAssetAccessLevel,
  ProductAssetSourceType,
} from "@/types/database";

export type ProductAssetWriteResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: AdminWriteErrorCode };

export interface AdminActor {
  id: string;
  email?: string | null;
  role?: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function classifyPgError(errCode: string | undefined): AdminWriteErrorCode {
  if (!errCode) return "ADMIN_WRITE_FAILED";
  if (errCode === "22004" || errCode === "P0002") return "ADMIN_WRITE_BAD_REQUEST";
  if (errCode === "40P01" || errCode === "40001" || errCode === "23505") {
    return "ADMIN_WRITE_CONFLICT";
  }
  return "ADMIN_WRITE_FAILED";
}

function extractErrCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * List all product assets (with product association) for the admin UI.
 * Uses service_role; the admin UI must NOT read product_assets directly.
 */
export async function listAllProductAssets(
  client: SupabaseClient<Database>,
): Promise<ProductAssetWriteResult<ProductAsset[]>> {
  try {
    const { data, error } = await client
      .from("product_assets")
      .select("*, product:products(id,slug,name_cn,name_en)")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) {
      console.error("PRODUCT_ASSET_LIST_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: (data as ProductAsset[] | null) || [] };
  } catch {
    console.error("PRODUCT_ASSET_LIST_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

/**
 * Create or update a product asset draft via save_product_asset_draft RPC.
 *
 * Draft model (Section 4):
 *   - source_bucket must be 'private-assets'
 *   - source_object_path is the server-generated private path
 *   - file_url is NOT saved in draft (null or previous published URL)
 *   - publish_status = 'draft'
 *
 * On UPDATE, expectedUpdatedAt is REQUIRED (optimistic lock).
 * On INSERT (id=null), expectedUpdatedAt is ignored.
 */
export async function saveProductAssetDraft(
  client: SupabaseClient<Database>,
  input: {
    id?: string | null;
    payload: ProductAssetPayload;
    sourceBucket: string;
    sourceObjectPath: string;
    mimeType?: string | null;
    fileSize?: number | null;
    sha256?: string | null;
    expectedUpdatedAt?: string | null;
    accessLevel?: ProductAssetAccessLevel;
    sourceType?: ProductAssetSourceType | null;
  },
  actor: AdminActor,
): Promise<ProductAssetWriteResult<{ id: string; updatedAt: string }>> {
  // Validate payload through shared validation
  const validation = validateProductAssetPayload(input.payload, {
    allowHttpForTesting: false,
  });
  if (!validation.ok) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // Draft source must be private-assets
  if (input.sourceBucket !== "private-assets") {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.sourceObjectPath || input.sourceObjectPath.trim().length === 0) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // On update: id must be valid UUID and expectedUpdatedAt required
  if (input.id) {
    if (!UUID_RE.test(input.id)) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (!input.expectedUpdatedAt) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }

  // Build the JSON payload for the RPC (whitelisted fields only)
  const rpcPayload = {
    product_id: input.payload.product_id || null,
    asset_type: input.payload.asset_type,
    catalog_topic_id: input.payload.catalog_topic_id || null,
    title_cn: input.payload.title_cn,
    title_en: input.payload.title_en || null,
    description_cn: input.payload.description_cn || null,
    description_en: input.payload.description_en || null,
    cover_image_url: input.payload.cover_image_url || null,
    published_at: input.payload.published_at || null,
    content_hash: input.payload.content_hash || null,
    sort_order: input.payload.sort_order,
    is_published: false, // Draft is never published
    access_level: input.accessLevel ?? "private",
    source_type: input.sourceType ?? null,
    authorization_status: "pending",
  };

  try {
    const { data, error } = await client.rpc("save_product_asset_draft", {
      p_id: input.id ?? null,
      p_payload: rpcPayload,
      p_source_bucket: input.sourceBucket,
      p_source_object_path: input.sourceObjectPath,
      p_mime_type: input.mimeType ?? null,
      p_file_size: input.fileSize ?? null,
      p_sha256: input.sha256 ?? null,
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("PRODUCT_ASSET_DRAFT_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string; status?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("PRODUCT_ASSET_DRAFT_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

/**
 * Update product asset metadata (non-storage fields only) via
 * update_product_asset_metadata RPC. Does NOT change the source ref
 * or publish state. Optimistic lock required.
 */
export async function updateProductAssetMetadata(
  client: SupabaseClient<Database>,
  input: {
    id: string;
    payload: Partial<ProductAssetPayload>;
    expectedUpdatedAt: string;
    accessLevel?: ProductAssetAccessLevel;
    sourceType?: ProductAssetSourceType | null;
  },
  actor: AdminActor,
): Promise<ProductAssetWriteResult<{ id: string; updatedAt: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  const rpcPayload = {
    product_id: input.payload.product_id ?? null,
    asset_type: input.payload.asset_type,
    catalog_topic_id: input.payload.catalog_topic_id ?? null,
    title_cn: input.payload.title_cn,
    title_en: input.payload.title_en ?? null,
    description_cn: input.payload.description_cn ?? null,
    description_en: input.payload.description_en ?? null,
    cover_image_url: input.payload.cover_image_url ?? null,
    published_at: input.payload.published_at ?? null,
    content_hash: input.payload.content_hash ?? null,
    sort_order: input.payload.sort_order ?? 0,
    is_published: input.payload.is_published ?? false,
    access_level: input.accessLevel ?? "private",
    source_type: input.sourceType ?? null,
  };

  try {
    const { data, error } = await client.rpc("update_product_asset_metadata", {
      p_id: input.id,
      p_payload: rpcPayload,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("PRODUCT_ASSET_UPDATE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string; status?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("PRODUCT_ASSET_UPDATE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

/**
 * Delete a product asset atomically via delete_product_asset_with_cleanup RPC.
 * The RPC enqueues both published and source objects for cleanup in the
 * same transaction. Optimistic lock required.
 */
export async function deleteProductAsset(
  client: SupabaseClient<Database>,
  input: { id: string; expectedUpdatedAt: string },
  actor: AdminActor,
): Promise<ProductAssetWriteResult<{ id: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  try {
    const { data, error } = await client.rpc("delete_product_asset_with_cleanup", {
      p_id: input.id,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("PRODUCT_ASSET_DELETE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; status?: string } | null;
    if (!result || !result.id) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("PRODUCT_ASSET_DELETE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

/**
 * Authorize a product asset via authorize_product_asset RPC.
 * This is a DEDICATED server-side command — not a generic PATCH.
 * Sets authorization_status='confirmed' with atomic audit.
 * Optimistic lock required.
 */
export async function authorizeProductAsset(
  client: SupabaseClient<Database>,
  input: { id: string; expectedUpdatedAt: string },
  actor: AdminActor,
): Promise<ProductAssetWriteResult<{ id: string; updatedAt: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  try {
    const { data, error } = await client.rpc("authorize_product_asset", {
      p_asset_id: input.id,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("PRODUCT_ASSET_AUTHORIZE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    // RPC returns timestamptz (the new updated_at) directly
    const updatedAt = typeof data === "string" ? data : "";
    if (!updatedAt) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: input.id, updatedAt } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("PRODUCT_ASSET_AUTHORIZE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

/**
 * Unpublish a product asset via unpublish_catalog_asset RPC.
 * Sets is_published=false, publish_status='draft', clears published ref.
 * Enqueues old public object for cleanup atomically.
 * Optimistic lock required.
 */
export async function unpublishProductAsset(
  client: SupabaseClient<Database>,
  input: { id: string; expectedUpdatedAt: string },
  actor: AdminActor,
): Promise<ProductAssetWriteResult<{ id: string; updatedAt: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  try {
    const { data, error } = await client.rpc("unpublish_catalog_asset", {
      p_id: input.id,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("PRODUCT_ASSET_UNPUBLISH_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string; status?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("PRODUCT_ASSET_UNPUBLISH_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}
