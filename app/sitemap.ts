import type { MetadataRoute } from "next";
import { isDemoMode } from "@/lib/demo";
import { localePath, type Locale } from "@/lib/i18n/config";
import { mockProducts } from "@/lib/mock-data";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { siteUrl } from "@/lib/utils";
import { getPublishedProjects } from "@/lib/repositories/projects";
import { localizedAlternates } from "@/lib/i18n/metadata";

export const revalidate = 300;
const publicPaths = ["/", "/products", "/projects", "/certificates", "/about", "/contact", "/privacy", "/more"];
const routeEntry = (locale: Locale, path: string, priority: number, lastModified?: Date): MetadataRoute.Sitemap[number] => ({
  url: siteUrl(localePath(locale, path)),
  ...(lastModified ? { lastModified } : {}),
  changeFrequency: path === "/" || path.startsWith("/products") ? "weekly" : "monthly",
  priority,
  alternates: { languages: localizedAlternates(path) },
});

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes = (["zh", "en"] as const).flatMap((locale) => publicPaths.map((path) => routeEntry(locale, path, path === "/" ? 1 : path === "/products" ? 0.9 : 0.6)));
  let products: Array<{ slug: string; updated_at: string | null }> = [];
  if (isDemoMode()) products = mockProducts.filter((product) => product.is_published).map((product) => ({ slug: product.slug, updated_at: product.updated_at }));
  else { try { const { data } = await createPublicSupabaseClient().from("products").select("slug, updated_at").eq("is_published", true); products = (data as typeof products | null) || []; } catch { return staticRoutes; } }
  const productRoutes = (["zh", "en"] as const).flatMap((locale) => products.map((product) => routeEntry(locale, `/products/${product.slug}`, 0.8, product.updated_at ? new Date(product.updated_at) : new Date())));
  let projects: Array<{ slug: string; updated_at: string }> = [];
  try { projects = (await getPublishedProjects()).map((project) => ({ slug: project.slug, updated_at: project.updated_at })); } catch { projects = []; }
  const projectRoutes = (["zh", "en"] as const).flatMap((locale) => projects.map((project) => routeEntry(locale, `/projects/${project.slug}`, 0.7, new Date(project.updated_at))));
  return [...staticRoutes, ...productRoutes, ...projectRoutes];
}
