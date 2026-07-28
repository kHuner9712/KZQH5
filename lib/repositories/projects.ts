import { isDemoMode } from "@/lib/demo";
import { mockProjectImages, mockProjectProducts, mockProjects, mockProducts } from "@/lib/mock-data";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import {
  PublicDataUnavailableError,
  logPublicDataFailure,
} from "@/lib/repositories/public-types";
import {
  PROJECT_FIELDS,
  PROJECT_IMAGE_FIELDS,
  PROJECT_PRODUCT_FIELDS,
  PRODUCT_FIELDS,
} from "@/lib/repositories/public-fields";
import type { Product, Project, ProjectImage, ProjectProduct } from "@/types/database";

export async function getPublishedProjects(options: { featuredOnly?: boolean; limit?: number } = {}): Promise<Project[]> {
  if (isDemoMode()) {
    return mockProjects
      .filter((project) => project.is_published && (!options.featuredOnly || project.is_featured))
      .sort((a, b) => Number(b.is_featured) - Number(a.is_featured) || a.sort_order - b.sort_order)
      .slice(0, options.limit);
  }
  try {
    let query = createPublicSupabaseClient().from("projects").select(PROJECT_FIELDS).eq("is_published", true);
    if (options.featuredOnly) query = query.eq("is_featured", true);
    let ordered = query.order("is_featured", { ascending: false }).order("sort_order", { ascending: true }).order("created_at", { ascending: false });
    if (options.limit) ordered = ordered.limit(options.limit);
    const { data, error } = await ordered;
    if (error) {
      logPublicDataFailure("PUBLIC_DATA_READ_FAILED", error);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", { cause: error });
    }
    return (data as unknown as Project[] | null) || [];
  } catch (error) {
    if (PublicDataUnavailableError.is(error)) throw error;
    logPublicDataFailure("PUBLIC_DATA_READ_EXCEPTION", error);
    throw new PublicDataUnavailableError("PUBLIC_DATA_READ_EXCEPTION", { cause: error });
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
    const { data, error } = await client.from("projects").select(PROJECT_FIELDS).eq("slug", slug).eq("is_published", true).maybeSingle();
    if (error) {
      logPublicDataFailure("PUBLIC_DATA_READ_FAILED", error);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", { cause: error });
    }
    if (!data) return null;
    const project = data as unknown as Project;
    const [{ data: imageRows, error: imageError }, { data: relationRows, error: relationError }] = await Promise.all([
      client.from("project_images").select(PROJECT_IMAGE_FIELDS).eq("project_id", project.id).order("sort_order", { ascending: true }),
      client.from("project_products").select(PROJECT_PRODUCT_FIELDS).eq("project_id", project.id).order("sort_order", { ascending: true }),
    ]);
    if (imageError) {
      logPublicDataFailure("PUBLIC_DATA_READ_FAILED", imageError);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", { cause: imageError });
    }
    if (relationError) {
      logPublicDataFailure("PUBLIC_DATA_READ_FAILED", relationError);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", { cause: relationError });
    }
    const relations = (relationRows as unknown as ProjectProduct[] | null) || [];
    let products: Product[] = [];
    if (relations.length) {
      const { data: productRows, error: productError } = await client.from("products").select(PRODUCT_FIELDS).in("id", relations.map((item) => item.product_id)).eq("is_published", true);
      if (productError) {
        logPublicDataFailure("PUBLIC_DATA_READ_FAILED", productError);
        throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", { cause: productError });
      }
      const byId = new Map(((productRows as unknown as Product[] | null) || []).map((item) => [item.id, item]));
      products = relations.map((item) => byId.get(item.product_id)).filter((item): item is Product => Boolean(item));
    }
    return { ...project, project_images: (imageRows as unknown as ProjectImage[] | null) || [], products };
  } catch (error) {
    if (PublicDataUnavailableError.is(error)) throw error;
    logPublicDataFailure("PUBLIC_DATA_READ_EXCEPTION", error);
    throw new PublicDataUnavailableError("PUBLIC_DATA_READ_EXCEPTION", { cause: error });
  }
}
