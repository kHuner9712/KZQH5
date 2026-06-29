import type { MetadataRoute } from "next";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/utils";

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
    const supabase = createServerSupabaseClient();
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
