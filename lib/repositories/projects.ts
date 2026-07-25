import { isDemoMode } from "@/lib/demo";
import { mockProjectImages, mockProjectProducts, mockProjects, mockProducts } from "@/lib/mock-data";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import type { Product, Project, ProjectImage, ProjectProduct } from "@/types/database";

export async function getPublishedProjects(options: { featuredOnly?: boolean; limit?: number } = {}): Promise<Project[]> {
  if (isDemoMode()) {
    return mockProjects
      .filter((project) => project.is_published && (!options.featuredOnly || project.is_featured))
      .sort((a, b) => Number(b.is_featured) - Number(a.is_featured) || a.sort_order - b.sort_order)
      .slice(0, options.limit);
  }
  try {
    let query = createPublicSupabaseClient().from("projects").select("*").eq("is_published", true);
    if (options.featuredOnly) query = query.eq("is_featured", true);
    let ordered = query.order("is_featured", { ascending: false }).order("sort_order", { ascending: true }).order("created_at", { ascending: false });
    if (options.limit) ordered = ordered.limit(options.limit);
    const { data, error } = await ordered;
    if (error) throw error;
    return (data as Project[] | null) || [];
  } catch (error) {
    throw new Error("PUBLIC_DATA_UNAVAILABLE", { cause: error });
  }
}

export async function getFeaturedProjects(limit = 3): Promise<Project[]> {
  return getPublishedProjects({ featuredOnly: true, limit });
}

export async function getPublishedProjectBySlug(slug: string): Promise<Project | null> {
  if (isDemoMode()) {
    const project = mockProjects.find((item) => item.slug === slug && item.is_published);
    if (!project) return null;
    const productIds = mockProjectProducts.filter((item) => item.project_id === project.id).map((item) => item.product_id);
    return {
      ...project,
      project_images: mockProjectImages.filter((item) => item.project_id === project.id).sort((a, b) => a.sort_order - b.sort_order),
      products: mockProducts.filter((item) => productIds.includes(item.id) && item.is_published),
    };
  }
  try {
    const client = createPublicSupabaseClient();
    const { data, error } = await client.from("projects").select("*").eq("slug", slug).eq("is_published", true).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const project = data as Project;
    const [{ data: imageRows, error: imageError }, { data: relationRows, error: relationError }] = await Promise.all([
      client.from("project_images").select("*").eq("project_id", project.id).order("sort_order", { ascending: true }),
      client.from("project_products").select("*").eq("project_id", project.id).order("sort_order", { ascending: true }),
    ]);
    if (imageError) throw imageError;
    if (relationError) throw relationError;
    const relations = (relationRows as ProjectProduct[] | null) || [];
    let products: Product[] = [];
    if (relations.length) {
      const { data: productRows, error: productError } = await client.from("products").select("*").in("id", relations.map((item) => item.product_id)).eq("is_published", true);
      if (productError) throw productError;
      const byId = new Map(((productRows as Product[] | null) || []).map((item) => [item.id, item]));
      products = relations.map((item) => byId.get(item.product_id)).filter((item): item is Product => Boolean(item));
    }
    return { ...project, project_images: (imageRows as ProjectImage[] | null) || [], products };
  } catch (error) {
    throw new Error("PUBLIC_DATA_UNAVAILABLE", { cause: error });
  }
}
