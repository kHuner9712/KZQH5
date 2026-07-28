import { isDemoMode } from "@/lib/demo";
import { mockCatalogAssets } from "@/lib/mock-catalog-assets";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import {
  PublicDataUnavailableError,
  logPublicDataFailure,
} from "@/lib/repositories/public-types";
import { PRODUCT_ASSET_FIELDS } from "@/lib/repositories/public-fields";
import type { ProductAsset } from "@/types/database";

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
 * and runtime errors are surfaced via PublicDataUnavailableError.
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
 * Work Package F contract:
 *   - Demo 模式 → mock 数据
 *   - Supabase 未配置 / 占位 URL → 静默返回 []
 *     (配置问题，非运行时数据库错误)
 *   - Supabase 已配置 + 数据库错误 → 抛 PublicDataUnavailableError
 *     (此前会静默 swallow 并返回 []，让 Supabase 全局故障看起来
 *      像"无资源"，无法在监控中区分。)
 *   - 无匹配行 → 返回 [] (合法空数据)
 *
 * 错误以固定 coarse code 写入 server 日志 (CATALOG_ASSETS_READ_FAILED /
 * CATALOG_ASSETS_READ_EXCEPTION)，不输出原始 Supabase error.message /
 * details / hint，因为它们可能含 schema 或 stack 信息。
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
    let query = client.from("product_assets").select(PRODUCT_ASSET_FIELDS).eq("is_published", true);
    query = productId ? query.eq("product_id", productId) : query.is("product_id", null);
    const { data, error } = await query
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) {
      // Fixed log code only — no error.message/details/hint leakage.
      logPublicDataFailure("PUBLIC_DATA_READ_FAILED", error);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", {
        cause: error,
      });
    }
    return (data as unknown as ProductAsset[] | null) || [];
  } catch (error) {
    if (PublicDataUnavailableError.is(error)) throw error;
    logPublicDataFailure("PUBLIC_DATA_READ_EXCEPTION", error);
    throw new PublicDataUnavailableError("PUBLIC_DATA_READ_EXCEPTION", {
      cause: error,
    });
  }
}
