import type { MetadataRoute } from "next";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { siteUrl } from "@/lib/utils";

// sitemap 仅读取公开产品 slug，不依赖 cookies，允许 ISR 缓存。
export const revalidate = 300;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${base}/products`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/certificates`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/about`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/contact`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
  ];

  try {
    const supabase = createPublicSupabaseClient();
    const { data: products } = await supabase
      .from("products")
      .select("slug, updated_at")
      .eq("is_published", true);

    const productRoutes: MetadataRoute.Sitemap = (
      (products || []) as { slug: string; updated_at: string | null }[]
    ).map((p) => ({
      url: `${base}/products/${p.slug}`,
      lastModified: p.updated_at ? new Date(p.updated_at) : new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    }));

    return [...staticRoutes, ...productRoutes];
  } catch {
    return staticRoutes;
  }
}
