import { isDemoMode } from "@/lib/demo";
import { mockProducts } from "@/lib/mock-data";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import type { Product } from "@/types/database";

const PRODUCT_FIELDS = "id, slug, name_cn, name_en, cover_image_url";

export type ProductSelection = Pick<
  Product,
  "id" | "slug" | "name_cn" | "name_en" | "cover_image_url"
>;

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
  const { data, error } = await createPublicSupabaseClient()
    .from("products")
    .select(PRODUCT_FIELDS)
    .eq("is_published", true)
    .in("id", unique);
  if (error) throw error;
  return (data as ProductSelection[] | null) || [];
}

export async function getLatestProductsForInquiry(
  ids: string[],
): Promise<ProductSelection[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const { data, error } = await createAdminSupabaseClient()
    .from("products")
    .select(PRODUCT_FIELDS)
    .eq("is_published", true)
    .in("id", unique);
  if (error) throw error;
  return (data as ProductSelection[] | null) || [];
}
