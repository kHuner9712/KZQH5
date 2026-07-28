import { isDemoMode } from "@/lib/demo";
import { mockProducts } from "@/lib/mock-data";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import {
  PublicDataUnavailableError,
  logPublicDataFailure,
} from "@/lib/repositories/public-types";
import { PRODUCT_SELECTION_FIELDS } from "@/lib/repositories/public-fields";
import type { Product } from "@/types/database";

export type ProductSelection = Pick<
  Product,
  "id" | "slug" | "name_cn" | "name_en" | "cover_image_url"
>;

/**
 * Work Package F: 与其他公开仓库一致 — 基础设施失败抛
 * PublicDataUnavailableError，不再 throw 原始 Supabase error
 * (会泄露 SQL / details / hint 到上层)。
 */
export async function getPublicProductSelections(
  ids: string[],
): Promise<ProductSelection[]> {
  const unique = [...new Set(ids)].slice(0, 30);
  if (!unique.length) return [];
  if (isDemoMode()) {
    return mockProducts.filter(
      (product) => unique.includes(product.id) && product.is_published,
    );
  }
  try {
    const { data, error } = await createPublicSupabaseClient()
      .from("products")
      .select(PRODUCT_SELECTION_FIELDS)
      .eq("is_published", true)
      .in("id", unique);
    if (error) {
      logPublicDataFailure("PUBLIC_DATA_READ_FAILED", error);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", {
        cause: error,
      });
    }
    return (data as unknown as ProductSelection[] | null) || [];
  } catch (error) {
    if (PublicDataUnavailableError.is(error)) throw error;
    logPublicDataFailure("PUBLIC_DATA_READ_EXCEPTION", error);
    throw new PublicDataUnavailableError("PUBLIC_DATA_READ_EXCEPTION", {
      cause: error,
    });
  }
}

/**
 * Service-role variant used by inquiry validation. Same error contract
 * as the public variant — throws PublicDataUnavailableError on infra
 * failure so the inquiry API can return a fixed 5xx instead of
 * leaking the Supabase error to the client.
 */
export async function getLatestProductsForInquiry(
  ids: string[],
): Promise<ProductSelection[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  try {
    const { data, error } = await createAdminSupabaseClient()
      .from("products")
      .select(PRODUCT_SELECTION_FIELDS)
      .eq("is_published", true)
      .in("id", unique);
    if (error) {
      logPublicDataFailure("PUBLIC_DATA_READ_FAILED", error);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", {
        cause: error,
      });
    }
    return (data as unknown as ProductSelection[] | null) || [];
  } catch (error) {
    if (PublicDataUnavailableError.is(error)) throw error;
    logPublicDataFailure("PUBLIC_DATA_READ_EXCEPTION", error);
    throw new PublicDataUnavailableError("PUBLIC_DATA_READ_EXCEPTION", {
      cause: error,
    });
  }
}
