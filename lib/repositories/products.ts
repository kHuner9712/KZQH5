import { isDemoMode } from "@/lib/demo";
import { mockProducts } from "@/lib/mock-data";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import type { InquiryListItemInput, Product } from "@/types/database";

const PRODUCT_FIELDS = "id, slug, name_cn, name_en, cover_image_url";

export type ProductSelection = Pick<Product, "id" | "slug" | "name_cn" | "name_en" | "cover_image_url">;

function uniqueIds(items: InquiryListItemInput[]): string[] {
  return [...new Set(items.map((item) => item.product_id).filter(Boolean))].slice(0, 30);
}

export async function getPublicProductSelections(ids: string[]): Promise<ProductSelection[]> {
  const unique = [...new Set(ids)].slice(0, 30);
  if (!unique.length) return [];
  if (isDemoMode()) {
    return mockProducts.filter((product) => unique.includes(product.id) && product.is_published);
  }
  const { data, error } = await createPublicSupabaseClient()
    .from("products")
    .select(PRODUCT_FIELDS)
    .eq("is_published", true)
    .in("id", unique);
  if (error) throw error;
  return (data as ProductSelection[] | null) || [];
}

export async function getLatestProductsForInquiry(items: InquiryListItemInput[]): Promise<ProductSelection[]> {
  const ids = uniqueIds(items);
  if (!ids.length) return [];
  const { data, error } = await createAdminSupabaseClient()
    .from("products")
    .select(PRODUCT_FIELDS)
    .in("id", ids);
  if (error) throw error;
  return (data as ProductSelection[] | null) || [];
}

