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
 * Returns true when the public Supabase env vars are missing OR obviously
 * placeholder. In that case the repository returns an empty result silently
 * (no structured warning) — this is a configuration issue, not a runtime
 * database error worth surfacing in server logs.
 *
 * Recognized placeholder patterns:
 *   - empty / undefined
 *   - "https://example.supabase.co"
 *   - "https://placeholder.supabase.co"
 *   - URLs whose host starts with "example." / "placeholder." / "your-"
 *
 * The real Supabase URL for this project looks like
 * `https://<project-ref>.supabase.co` where <project-ref> is a 20-char
 * alphanumeric string. Any non-placeholder value is treated as a real URL
 * and runtime errors are logged with structured codes.
 */
function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "example.supabase.co") return false;
    if (host === "placeholder.supabase.co") return false;
    if (host.startsWith("example.")) return false;
    if (host.startsWith("placeholder.")) return false;
    if (host.startsWith("your-")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads published product assets for the catalog center.
 *
 * Behavior:
 *   - Demo mode → mock data (no Supabase call)
 *   - Supabase env vars missing or placeholder → silent empty result
 *     (configuration issue, not a runtime error)
 *   - Supabase configured + DB error → structured `console.warn` with
 *     fixed code (`CATALOG_ASSETS_READ_FAILED` / `CATALOG_ASSETS_READ_EXCEPTION`)
 *     and return [] so the public page keeps rendering a safe empty state
 *
 * Errors are NOT silently swallowed in the configured case — they are
 * surfaced to server logs with a fixed code so an operator can investigate.
 */
export async function getPublishedProductAssets(productId: string | null): Promise<ProductAsset[]> {
  if (isDemoMode()) {
    return mockCatalogAssets
      .filter((asset) => asset.is_published && asset.product_id === productId)
      .sort((a, b) => a.sort_order - b.sort_order);
  }

  if (!isSupabaseConfigured()) {
    // Configuration missing — build-time or local dev without real Supabase.
    // Return empty silently. This is NOT a runtime database error.
    return [];
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
