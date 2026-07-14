import type { SupabaseClient } from "@supabase/supabase-js";
import { isDemoMode } from "@/lib/demo";
import { mockProductAssets } from "@/lib/mock-data";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import type { Database, ProductAsset } from "@/types/database";

type Client = SupabaseClient<Database>;

export async function getPublishedProductAssets(productId: string | null): Promise<ProductAsset[]> {
  if (isDemoMode()) {
    return mockProductAssets
      .filter((asset) => asset.is_published && asset.product_id === productId)
      .sort((a, b) => a.sort_order - b.sort_order);
  }

  try {
    const client = createPublicSupabaseClient();
    let query = client.from("product_assets").select("*").eq("is_published", true);
    query = productId ? query.eq("product_id", productId) : query.is("product_id", null);
    const { data, error } = await query
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return [];
    return (data as ProductAsset[] | null) || [];
  } catch {
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

export async function saveProductAsset(
  client: Client,
  payload: Omit<ProductAsset, "id" | "created_at" | "updated_at" | "product">,
  id?: string
): Promise<void> {
  const result = id
    ? await client.from("product_assets").update(payload).eq("id", id)
    : await client.from("product_assets").insert(payload);
  if (result.error) throw result.error;
}

export async function deleteProductAsset(client: Client, id: string): Promise<void> {
  const { error } = await client.from("product_assets").delete().eq("id", id);
  if (error) throw error;
}
