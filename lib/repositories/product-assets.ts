import type { SupabaseClient } from "@supabase/supabase-js";
import { isDemoMode } from "@/lib/demo";
import { mockCatalogAssets } from "@/lib/mock-catalog-assets";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import {
  formatFieldErrors,
  validateProductAssetPayload,
  type ProductAssetPayload,
} from "@/lib/validation/product-asset";
import { classifyAdminDataError } from "@/lib/services/admin-data-error";
import type { Database, ProductAsset } from "@/types/database";

type Client = SupabaseClient<Database>;

/**
 * Reads published product assets for the catalog center.
 *
 * Returns an empty array when:
 *   - there is genuinely no published data, or
 *   - the database returned an error (e.g. missing schema).
 *
 * In the error case we log a structured server-side message with a fixed
 * code and return [] so the public page keeps rendering a safe empty state.
 * Errors are NOT silently swallowed — they are surfaced to server logs and
 * the cause is recorded so an operator can investigate.
 */
export async function getPublishedProductAssets(productId: string | null): Promise<ProductAsset[]> {
  if (isDemoMode()) {
    return mockCatalogAssets
      .filter((asset) => asset.is_published && asset.product_id === productId)
      .sort((a, b) => a.sort_order - b.sort_order);
  }

  try {
    const client = createPublicSupabaseClient();
    let query = client.from("product_assets").select("*").eq("is_published", true);
    query = productId ? query.eq("product_id", productId) : query.is("product_id", null);
    const { data, error } = await query
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) {
      const cause = classifyAdminDataError(error);
      // Only emit the fixed log code. Do not log error.message/details/hint
      // because they may contain schema or stack information that should
      // not appear in default server output.
      if (typeof console !== "undefined") {
        // eslint-disable-next-line no-console
        console.warn("CATALOG_ASSETS_READ_FAILED", cause);
      }
      return [];
    }
    return (data as ProductAsset[] | null) || [];
  } catch (err) {
    const cause = classifyAdminDataError(err);
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn("CATALOG_ASSETS_READ_EXCEPTION", cause);
    }
    return [];
  }
}

export async function listProductAssets(client: Client): Promise<ProductAsset[]> {
  const { data, error } = await client
    .from("product_assets")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as ProductAsset[] | null) || [];
}

/**
 * Inserts or updates a product asset row. Validates the payload through
 * `validateProductAssetPayload` BEFORE touching Supabase — even though this
 * runs in the browser, it is the last gate before the network call and
 * catches the case where a hand-edited URL or hidden field bypassed the
 * admin form's UI validation.
 *
 * Throws `Error` with a concatenated field-error message when invalid.
 */
export async function saveProductAsset(
  client: Client,
  payload: ProductAssetPayload,
  id?: string,
): Promise<void> {
  const validation = validateProductAssetPayload(payload);
  if (!validation.ok) {
    throw new Error(formatFieldErrors(validation.errors));
  }

  const result = id
    ? await client.from("product_assets").update(payload as unknown as Record<string, unknown>).eq("id", id)
    : await client.from("product_assets").insert(payload as unknown as Record<string, unknown>);
  if (result.error) throw result.error;
}

export async function deleteProductAsset(client: Client, id: string): Promise<void> {
  const { error } = await client.from("product_assets").delete().eq("id", id);
  if (error) throw error;
}
