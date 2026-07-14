import { isDemoMode } from "@/lib/demo";
import { mockProducts } from "@/lib/mock-data";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import type { Product } from "@/types/database";

export interface ProductSearchRequest {
  query?: string;
  categoryId?: string | null;
  subcategoryId?: string | null;
  page: number;
  pageSize: number;
}

export interface ProductSearchResult {
  items: Product[];
  total: number;
}

export function normalizeProductSearch(input?: string | null): string {
  return (input || "")
    .slice(0, 120)
    .toLocaleLowerCase()
    .replace(/[×*＊]/g, "x")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function demoSearch(request: ProductSearchRequest): ProductSearchResult {
  const normalized = normalizeProductSearch(request.query);
  const searchable = (product: Product) => normalizeProductSearch([
    product.name_cn,
    product.name_en,
    product.slug,
    product.summary_cn,
    product.summary_en,
    product.material_cn,
    product.material_en,
    product.size,
    product.application_cn,
    product.application_en,
    ...(product.search_aliases || []),
    ...(product.keywords_cn || []),
    ...(product.keywords_en || []),
  ].filter(Boolean).join(" "));

  const exact = (product: Product) => normalized && [
    product.slug,
    product.size,
    ...(product.search_aliases || []),
  ].some((value) => normalizeProductSearch(value) === normalized);

  const filtered = mockProducts
    .filter((product) => product.is_published)
    .filter((product) => !request.categoryId || product.category_id === request.categoryId)
    .filter((product) => !request.subcategoryId || product.subcategory_id === request.subcategoryId)
    .filter((product) => !normalized || searchable(product).includes(normalized))
    .sort((left, right) => Number(exact(right)) - Number(exact(left))
      || Number(right.is_featured) - Number(left.is_featured)
      || left.sort_order - right.sort_order);
  const offset = (request.page - 1) * request.pageSize;
  return { items: filtered.slice(offset, offset + request.pageSize), total: filtered.length };
}

export async function searchProducts(request: ProductSearchRequest): Promise<ProductSearchResult> {
  if (isDemoMode()) return demoSearch(request);

  const { data, error } = await createPublicSupabaseClient().rpc("search_published_products", {
    p_query: request.query?.slice(0, 120) || null,
    p_category_id: request.categoryId || null,
    p_subcategory_id: request.subcategoryId || null,
    p_offset: (request.page - 1) * request.pageSize,
    p_limit: request.pageSize,
  });
  if (error) throw error;
  const payload = data as { items?: Product[]; total?: number } | null;
  return {
    items: Array.isArray(payload?.items) ? payload.items : [],
    total: Number.isFinite(Number(payload?.total)) ? Number(payload?.total) : 0,
  };
}

