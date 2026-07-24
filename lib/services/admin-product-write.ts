/**
 * Phase 2 product write service.
 *
 * Validates a product payload from an admin API request and persists it via
 * the transactional `save_product_with_images` RPC. The RPC inserts/updates
 * the product row and replaces its images atomically in a single
 * transaction, so a partial image failure rolls back the product save.
 *
 * Contract:
 *   * Input is validated BEFORE the RPC is called (lengths, enums, UUIDs,
 *     media URLs via the shared allowlist).
 *   * The product jsonb handed to the RPC contains ONLY whitelisted columns.
 *   * On any failure a fixed AdminWriteErrorCode is thrown / returned; the
 *     underlying database error is never forwarded.
 *   * Phase 3: optimistic-lock `updated_at` is checked by the RPC when
 *     `expected_updated_at` is provided. A stale version raises 40P01 which
 *     is classified as ADMIN_WRITE_CONFLICT (HTTP 409).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  fail,
  merge,
  ok,
  validateBoolean,
  validateInteger,
  validateNonEmptyString,
  validateOptionalInteger,
  validateOptionalMediaUrl,
  validateOptionalString,
  validateOptionalUuid,
  validateSlug,
  validateStringArray,
  validateUuid,
  type FieldError,
  type ValidationResult,
} from "@/lib/validation/admin-write";

const MAX_TEXT = 5000;
const MAX_LONG_TEXT = 20000;
const MAX_URL = 2048;
const MAX_KEYWORDS = 32;
const MAX_KEYWORD_LEN = 64;
const MAX_IMAGES = 40;
const MAX_SORT = 100000;

export interface ProductImageInput {
  image_url: string;
  alt_cn: string | null;
  alt_en: string | null;
  sort_order: number;
}

export interface ProductWritePayload {
  id?: string;
  product: Record<string, unknown>;
  images: ProductImageInput[];
  expected_updated_at?: string | null;
}

export type ProductSaveResult =
  | { ok: true; id: string }
  | { ok: false; code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_CONFLICT" | "ADMIN_WRITE_FAILED"; errors?: FieldError[] };

/**
 * Validate the full product payload coming from the admin CMS.
 * Returns the normalized jsonb to hand to the RPC plus the id (if update).
 */
export function validateProductPayload(input: unknown): ValidationResult<{
  id: string | null;
  product: Record<string, unknown>;
  images: ProductImageInput[];
  expected_updated_at: string | null;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail([{ field: "body", reason: "not-object" }]);
  }
  const body = input as Record<string, unknown>;

  // id is optional (create) or a UUID (update)
  const idResult =
    body.id == null || body.id === ""
      ? ok<string | null>(null)
      : validateUuid("id", body.id);
  if (!idResult.ok) return idResult;

  // Phase 3: expected_updated_at — REQUIRED for updates, ignored for creates.
  // This enforces optimistic locking: the caller MUST prove they saw a recent
  // version of the record before modifying it. Missing on update => 400.
  let expectedUpdatedAt: string | null = null;
  if (body.expected_updated_at != null && body.expected_updated_at !== "") {
    if (typeof body.expected_updated_at !== "string") {
      return fail([{ field: "expected_updated_at", reason: "not-string" }]);
    }
    const ts = body.expected_updated_at.trim();
    if (Number.isNaN(Date.parse(ts))) {
      return fail([{ field: "expected_updated_at", reason: "invalid-timestamp" }]);
    }
    expectedUpdatedAt = ts;
  }
  // Enforce: updates (id != null) MUST provide expected_updated_at.
  if (idResult.value !== null && !expectedUpdatedAt) {
    return fail([{ field: "expected_updated_at", reason: "required-for-update" }]);
  }

  // core required + optional fields
  const fields = {
    name_cn: validateNonEmptyString("name_cn", body.name_cn, MAX_TEXT),
    name_en: validateOptionalString("name_en", body.name_en, MAX_TEXT),
    slug: validateSlug("slug", body.slug),
    category_id: validateOptionalUuid("category_id", body.category_id),
    subcategory_id: validateOptionalUuid("subcategory_id", body.subcategory_id),
    summary_cn: validateOptionalString("summary_cn", body.summary_cn, MAX_LONG_TEXT),
    summary_en: validateOptionalString("summary_en", body.summary_en, MAX_LONG_TEXT),
    description_cn: validateOptionalString("description_cn", body.description_cn, MAX_LONG_TEXT),
    description_en: validateOptionalString("description_en", body.description_en, MAX_LONG_TEXT),
    material_cn: validateOptionalString("material_cn", body.material_cn, MAX_TEXT),
    material_en: validateOptionalString("material_en", body.material_en, MAX_TEXT),
    size: validateOptionalString("size", body.size, MAX_TEXT),
    fire_rating: validateOptionalString("fire_rating", body.fire_rating, 64),
    eco_grade: validateOptionalString("eco_grade", body.eco_grade, 64),
    price_display_cn: validateOptionalString("price_display_cn", body.price_display_cn, MAX_TEXT),
    price_display_en: validateOptionalString("price_display_en", body.price_display_en, MAX_TEXT),
    moq: validateOptionalString("moq", body.moq, MAX_TEXT),
    packaging_cn: validateOptionalString("packaging_cn", body.packaging_cn, MAX_TEXT),
    packaging_en: validateOptionalString("packaging_en", body.packaging_en, MAX_TEXT),
    logistics_cn: validateOptionalString("logistics_cn", body.logistics_cn, MAX_TEXT),
    logistics_en: validateOptionalString("logistics_en", body.logistics_en, MAX_TEXT),
    application_cn: validateOptionalString("application_cn", body.application_cn, MAX_LONG_TEXT),
    application_en: validateOptionalString("application_en", body.application_en, MAX_LONG_TEXT),
    video_url: validateOptionalMediaUrl("video_url", body.video_url, MAX_URL),
    cover_image_url: validateOptionalMediaUrl("cover_image_url", body.cover_image_url, MAX_URL),
    is_featured: validateBoolean("is_featured", body.is_featured),
    is_published: validateBoolean("is_published", body.is_published),
    sort_order: validateInteger("sort_order", body.sort_order, 0, MAX_SORT),
    seo_title_cn: validateOptionalString("seo_title_cn", body.seo_title_cn, MAX_TEXT),
    seo_title_en: validateOptionalString("seo_title_en", body.seo_title_en, MAX_TEXT),
    seo_description_cn: validateOptionalString("seo_description_cn", body.seo_description_cn, MAX_LONG_TEXT),
    seo_description_en: validateOptionalString("seo_description_en", body.seo_description_en, MAX_LONG_TEXT),
    geo_summary_cn: validateOptionalString("geo_summary_cn", body.geo_summary_cn, MAX_LONG_TEXT),
    geo_summary_en: validateOptionalString("geo_summary_en", body.geo_summary_en, MAX_LONG_TEXT),
    keywords_cn: body.keywords_cn == null
      ? ok<string[] | null>(null)
      : validateStringArray("keywords_cn", body.keywords_cn, MAX_KEYWORDS, MAX_KEYWORD_LEN),
    keywords_en: body.keywords_en == null
      ? ok<string[] | null>(null)
      : validateStringArray("keywords_en", body.keywords_en, MAX_KEYWORDS, MAX_KEYWORD_LEN),
    search_aliases: body.search_aliases == null
      ? ok<string[] | null>(null)
      : validateStringArray("search_aliases", body.search_aliases, MAX_KEYWORDS, MAX_KEYWORD_LEN),
  };
  const merged = merge(fields);
  if (!merged.ok) return merged;

  // schema_extra + faq are free-form jsonb, validated as objects/arrays
  const product: Record<string, unknown> = { ...merged.value };
  if (body.schema_extra != null) {
    if (typeof body.schema_extra !== "object" || Array.isArray(body.schema_extra)) {
      return fail([{ field: "schema_extra", reason: "not-object" }]);
    }
    product.schema_extra = body.schema_extra;
  } else {
    product.schema_extra = null;
  }
  if (body.faq_cn != null) {
    if (!Array.isArray(body.faq_cn)) {
      return fail([{ field: "faq_cn", reason: "not-array" }]);
    }
    product.faq_cn = body.faq_cn;
  } else {
    product.faq_cn = null;
  }
  if (body.faq_en != null) {
    if (!Array.isArray(body.faq_en)) {
      return fail([{ field: "faq_en", reason: "not-array" }]);
    }
    product.faq_en = body.faq_en;
  } else {
    product.faq_en = null;
  }

  // images: array of { image_url, alt_cn, alt_en, sort_order }
  const imagesResult = validateImages(body.images);
  if (!imagesResult.ok) return imagesResult;

  return ok({
    id: idResult.value,
    product,
    images: imagesResult.value,
    expected_updated_at: expectedUpdatedAt,
  });
}

function validateImages(raw: unknown): ValidationResult<ProductImageInput[]> {
  if (raw == null) return ok([]);
  if (!Array.isArray(raw)) return fail([{ field: "images", reason: "not-array" }]);
  if (raw.length > MAX_IMAGES) {
    return fail([{ field: "images", reason: "too-many-items" }]);
  }
  const out: ProductImageInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return fail([{ field: `images[${i}]`, reason: "not-object" }]);
    }
    const obj = item as Record<string, unknown>;
    const url = validateOptionalMediaUrl(`images[${i}].image_url`, obj.image_url, MAX_URL);
    if (!url.ok) return url;
    if (!url.value) {
      return fail([{ field: `images[${i}].image_url`, reason: "empty" }]);
    }
    const altCn = validateOptionalString(`images[${i}].alt_cn`, obj.alt_cn, MAX_TEXT);
    if (!altCn.ok) return altCn;
    const altEn = validateOptionalString(`images[${i}].alt_en`, obj.alt_en, MAX_TEXT);
    if (!altEn.ok) return altEn;
    const sortOrder = validateOptionalInteger(`images[${i}].sort_order`, obj.sort_order, 0, MAX_SORT);
    if (!sortOrder.ok) return sortOrder;
    out.push({
      image_url: url.value,
      alt_cn: altCn.value,
      alt_en: altEn.value,
      sort_order: sortOrder.value ?? i,
    });
  }
  return ok(out);
}

/**
 * Persist a validated product payload via the transactional RPC.
 * The RPC handles insert-or-update based on whether id is null.
 * Phase 3: passes expected_updated_at for optimistic locking on updates.
 * Phase 13: uses save_product_with_images_and_audit for atomic audit.
 *           Actor info comes from the server-verified admin session.
 */
export async function saveProductViaRpc(
  client: SupabaseClient<Database>,
  payload: {
    id: string | null;
    product: Record<string, unknown>;
    images: ProductImageInput[];
    expected_updated_at?: string | null;
  },
  actor?: { id: string; email?: string; role?: string | null },
): Promise<ProductSaveResult> {
  const { data, error } = await client.rpc("save_product_with_images_and_audit", {
    p_id: payload.id,
    p_product: payload.product,
    p_images: payload.images as unknown as Record<string, unknown>[],
    p_expected_updated_at: payload.expected_updated_at ?? null,
    p_actor_id: actor?.id ?? null,
    p_actor_email: actor?.email ?? null,
    p_actor_role: actor?.role ?? null,
  });

  if (error) {
    const code = classifyPgError(error.code);
    return { ok: false, code };
  }
  if (!data || typeof data !== "string") {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
  return { ok: true, id: data };
}

/**
 * Bulk update a boolean / status field across many product ids.
 * Used by the admin list page for bulk publish / feature / delete.
 * Phase 13: uses bulk_update_products_with_audit for atomic audit.
 */
export async function bulkUpdateProducts(
  client: SupabaseClient<Database>,
  ids: string[],
  patch: Record<string, unknown>,
  actor?: { id: string; email?: string; role?: string | null },
): Promise<{ ok: true; count: number } | { ok: false; code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_FAILED" }> {
  if (ids.length === 0) return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  if (ids.length > 500) return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  const { data, error } = await client.rpc("bulk_update_products_with_audit", {
    p_ids: ids,
    p_patch: patch,
    p_actor_id: actor?.id ?? null,
    p_actor_email: actor?.email ?? null,
    p_actor_role: actor?.role ?? null,
  });
  if (error) return { ok: false, code: "ADMIN_WRITE_FAILED" };
  return { ok: true, count: typeof data === "number" ? data : ids.length };
}

export async function bulkDeleteProducts(
  client: SupabaseClient<Database>,
  ids: string[],
  actor?: { id: string; email?: string; role?: string | null },
): Promise<{ ok: true; count: number } | { ok: false; code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_FAILED" }> {
  if (ids.length === 0) return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  if (ids.length > 500) return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  const { data, error } = await client.rpc("bulk_delete_products_with_audit", {
    p_ids: ids,
    p_actor_id: actor?.id ?? null,
    p_actor_email: actor?.email ?? null,
    p_actor_role: actor?.role ?? null,
  });
  if (error) return { ok: false, code: "ADMIN_WRITE_FAILED" };
  return { ok: true, count: typeof data === "number" ? data : ids.length };
}

function classifyPgError(code: string | undefined): "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_CONFLICT" | "ADMIN_WRITE_FAILED" {
  if (!code) return "ADMIN_WRITE_FAILED";
  const upper = code.toUpperCase();
  if (upper === "23505" || upper === "40P01" || upper === "40001") return "ADMIN_WRITE_CONFLICT";
  if (upper === "23502" || upper === "23503" || upper === "22P02" || upper === "P0002") return "ADMIN_WRITE_BAD_REQUEST";
  return "ADMIN_WRITE_FAILED";
}
