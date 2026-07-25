/**
 * Phase 15 (Section 7): Project admin write service.
 *
 * Trusted server-side boundary for project CRUD operations.
 * The admin UI MUST call the /api/admin/projects/* routes which
 * in turn call these functions — never the Browser Supabase client.
 *
 * Every write goes through a transactional RPC that:
 *   - enforces optimistic lock (expected_updated_at required for updates)
 *   - replaces project images + product relations atomically
 *   - enqueues replaced/old storage objects for cleanup in the same
 *     transaction
 *   - writes audit in the same transaction (no best-effort audit)
 *
 * Errors are classified into coarse-grained AdminWriteErrorCode values;
 * SQL / internal details are never forwarded to the client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Project, ProjectImage, ProjectProduct, Product } from "@/types/database";
import {
  fail,
  merge,
  ok,
  validateBoolean,
  validateInteger,
  validateNonEmptyString,
  validateOptionalInteger,
  validateOptionalMediaUrl,
  validateOptionalString,
  validateOptionalUuid,
  validateSlug,
  validateUuid,
  type FieldError,
  type ValidationResult,
} from "@/lib/validation/admin-write";

const MAX_TEXT = 5000;
const MAX_LONG_TEXT = 20000;
const MAX_URL = 2048;
const MAX_IMAGES = 40;
const MAX_PRODUCTS = 200;
const MAX_SORT = 100000;

export interface ProjectImageInput {
  image_url: string;
  alt_cn: string | null;
  alt_en: string | null;
  sort_order: number;
}

export interface ProjectProductInput {
  product_id: string;
  sort_order: number;
}

export interface ProjectWritePayload {
  id: string | null;
  project: Record<string, unknown>;
  images: ProjectImageInput[];
  products: ProjectProductInput[];
  expected_updated_at: string | null;
}

export type ProjectSaveResult =
  | { ok: true; id: string }
  | {
      ok: false;
      code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_CONFLICT" | "ADMIN_WRITE_FAILED";
      errors?: FieldError[];
    };

/**
 * Validate the full project payload coming from the admin CMS.
 * Returns the normalized jsonb to hand to the RPC plus the id (if update).
 *
 * Validation rules:
 *   - id (optional): UUID for update, null/empty for create
 *   - expected_updated_at: REQUIRED for updates, ignored for creates
 *   - title_cn + slug: required non-empty
 *   - slug: must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/ (URL-safe kebab-case)
 *   - all string fields: max length enforced
 *   - media URLs: validated against the media allowlist (env-driven)
 *   - images: array of { image_url, alt_cn, alt_en, sort_order }
 *   - products: array of { product_id (uuid), sort_order }
 */
export function validateProjectPayload(input: unknown): ValidationResult<ProjectWritePayload> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail([{ field: "body", reason: "not-object" }]);
  }
  const body = input as Record<string, unknown>;

  // id is optional (create) or a UUID (update)
  const idResult =
    body.id == null || body.id === ""
      ? ok<string | null>(null)
      : validateUuid("id", body.id);
  if (!idResult.ok) return idResult;

  // Optimistic lock: required for updates, ignored for creates.
  let expectedUpdatedAt: string | null = null;
  if (body.expected_updated_at != null && body.expected_updated_at !== "") {
    if (typeof body.expected_updated_at !== "string") {
      return fail([{ field: "expected_updated_at", reason: "not-string" }]);
    }
    const ts = body.expected_updated_at.trim();
    if (Number.isNaN(Date.parse(ts))) {
      return fail([{ field: "expected_updated_at", reason: "invalid-timestamp" }]);
    }
    expectedUpdatedAt = ts;
  }
  if (idResult.value !== null && !expectedUpdatedAt) {
    return fail([{ field: "expected_updated_at", reason: "required-for-update" }]);
  }

  // project object
  if (!body.project || typeof body.project !== "object" || Array.isArray(body.project)) {
    return fail([{ field: "project", reason: "not-object" }]);
  }
  const p = body.project as Record<string, unknown>;

  const fields = {
    title_cn: validateNonEmptyString("project.title_cn", p.title_cn, MAX_TEXT),
    title_en: validateOptionalString("project.title_en", p.title_en, MAX_TEXT),
    slug: validateSlug("project.slug", p.slug),
    summary_cn: validateOptionalString("project.summary_cn", p.summary_cn, MAX_LONG_TEXT),
    summary_en: validateOptionalString("project.summary_en", p.summary_en, MAX_LONG_TEXT),
    description_cn: validateOptionalString("project.description_cn", p.description_cn, MAX_LONG_TEXT),
    description_en: validateOptionalString("project.description_en", p.description_en, MAX_LONG_TEXT),
    country_cn: validateOptionalString("project.country_cn", p.country_cn, MAX_TEXT),
    country_en: validateOptionalString("project.country_en", p.country_en, MAX_TEXT),
    project_type_cn: validateOptionalString("project.project_type_cn", p.project_type_cn, MAX_TEXT),
    project_type_en: validateOptionalString("project.project_type_en", p.project_type_en, MAX_TEXT),
    cover_image_url: validateOptionalMediaUrl("project.cover_image_url", p.cover_image_url, MAX_URL),
    is_published: validateBoolean("project.is_published", p.is_published),
    is_featured: validateBoolean("project.is_featured", p.is_featured),
    sort_order: validateInteger("project.sort_order", p.sort_order, 0, MAX_SORT),
    seo_title_cn: validateOptionalString("project.seo_title_cn", p.seo_title_cn, MAX_TEXT),
    seo_title_en: validateOptionalString("project.seo_title_en", p.seo_title_en, MAX_TEXT),
    seo_description_cn: validateOptionalString("project.seo_description_cn", p.seo_description_cn, MAX_LONG_TEXT),
    seo_description_en: validateOptionalString("project.seo_description_en", p.seo_description_en, MAX_LONG_TEXT),
  };
  const merged = merge(fields);
  if (!merged.ok) return merged;

  const project: Record<string, unknown> = { ...merged.value };

  // images: array of { image_url, alt_cn, alt_en, sort_order }
  const imagesResult = validateProjectImages(body.images);
  if (!imagesResult.ok) return imagesResult;

  // products: array of { product_id (uuid), sort_order }
  const productsResult = validateProjectProducts(body.products);
  if (!productsResult.ok) return productsResult;

  return ok({
    id: idResult.value,
    project,
    images: imagesResult.value,
    products: productsResult.value,
    expected_updated_at: expectedUpdatedAt,
  });
}

function validateProjectImages(raw: unknown): ValidationResult<ProjectImageInput[]> {
  if (raw == null) return ok([]);
  if (!Array.isArray(raw)) return fail([{ field: "images", reason: "not-array" }]);
  if (raw.length > MAX_IMAGES) {
    return fail([{ field: "images", reason: "too-many-items" }]);
  }
  const out: ProjectImageInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return fail([{ field: `images[${i}]`, reason: "not-object" }]);
    }
    const obj = item as Record<string, unknown>;
    const url = validateOptionalMediaUrl(`images[${i}].image_url`, obj.image_url, MAX_URL);
    if (!url.ok) return url;
    if (!url.value) {
      return fail([{ field: `images[${i}].image_url`, reason: "empty" }]);
    }
    const altCn = validateOptionalString(`images[${i}].alt_cn`, obj.alt_cn, MAX_TEXT);
    if (!altCn.ok) return altCn;
    const altEn = validateOptionalString(`images[${i}].alt_en`, obj.alt_en, MAX_TEXT);
    if (!altEn.ok) return altEn;
    const sortOrder = validateOptionalInteger(`images[${i}].sort_order`, obj.sort_order, 0, MAX_SORT);
    if (!sortOrder.ok) return sortOrder;
    out.push({
      image_url: url.value,
      alt_cn: altCn.value,
      alt_en: altEn.value,
      sort_order: sortOrder.value ?? i,
    });
  }
  return ok(out);
}

function validateProjectProducts(raw: unknown): ValidationResult<ProjectProductInput[]> {
  if (raw == null) return ok([]);
  if (!Array.isArray(raw)) return fail([{ field: "products", reason: "not-array" }]);
  if (raw.length > MAX_PRODUCTS) {
    return fail([{ field: "products", reason: "too-many-items" }]);
  }
  const out: ProjectProductInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return fail([{ field: `products[${i}]`, reason: "not-object" }]);
    }
    const obj = item as Record<string, unknown>;
    const productId = validateOptionalUuid(`products[${i}].product_id`, obj.product_id);
    if (!productId.ok) return productId;
    if (!productId.value) {
      return fail([{ field: `products[${i}].product_id`, reason: "empty" }]);
    }
    const sortOrder = validateOptionalInteger(`products[${i}].sort_order`, obj.sort_order, 0, MAX_SORT);
    if (!sortOrder.ok) return sortOrder;
    out.push({
      product_id: productId.value,
      sort_order: sortOrder.value ?? i,
    });
  }
  return ok(out);
}

function classifyPgError(code: string | undefined): "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_CONFLICT" | "ADMIN_WRITE_FAILED" {
  if (!code) return "ADMIN_WRITE_FAILED";
  const upper = code.toUpperCase();
  if (upper === "23505" || upper === "40P01" || upper === "40001") return "ADMIN_WRITE_CONFLICT";
  if (upper === "23502" || upper === "23503" || upper === "22P02" || upper === "P0002" || upper === "22004") return "ADMIN_WRITE_BAD_REQUEST";
  return "ADMIN_WRITE_FAILED";
}

/**
 * Persist a validated project payload via the transactional RPC.
 * The RPC handles insert-or-update based on whether id is null.
 * Phase 15: uses save_project_with_relations_and_audit for atomic audit
 *           + cleanup enqueue + optimistic lock.
 * Actor info comes from the server-verified admin session.
 */
export async function saveProjectViaRpc(
  client: SupabaseClient<Database>,
  payload: ProjectWritePayload,
  actor?: { id: string; email?: string; role?: string | null },
): Promise<ProjectSaveResult> {
  const { data, error } = await client.rpc("save_project_with_relations_and_audit", {
    p_id: payload.id,
    p_project: payload.project,
    p_images: payload.images as unknown as Record<string, unknown>[],
    p_products: payload.products as unknown as Record<string, unknown>[],
    p_expected_updated_at: payload.expected_updated_at ?? null,
    p_actor_id: actor?.id ?? null,
    p_actor_email: actor?.email ?? null,
    p_actor_role: actor?.role ?? null,
  });

  if (error) {
    const code = classifyPgError(error.code);
    return { ok: false, code };
  }
  if (!data || typeof data !== "string") {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
  return { ok: true, id: data };
}

/**
 * Delete a project atomically via delete_project_with_audit RPC.
 * The RPC enqueues removed images/cover/video URLs for cleanup in the
 * same transaction. Optimistic lock required.
 */
export async function deleteProjectViaRpc(
  client: SupabaseClient<Database>,
  input: { id: string; expectedUpdatedAt: string },
  actor?: { id: string; email?: string; role?: string | null },
): Promise<{ ok: true; id: string } | { ok: false; code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_CONFLICT" | "ADMIN_WRITE_FAILED" }> {
  if (!input.id || !input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  const { data, error } = await client.rpc("delete_project_with_audit", {
    p_id: input.id,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_actor_id: actor?.id ?? null,
    p_actor_email: actor?.email ?? null,
    p_actor_role: actor?.role ?? null,
  });
  if (error) {
    return { ok: false, code: classifyPgError(error.code) };
  }
  if (!data || typeof data !== "string") {
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
  return { ok: true, id: data };
}

/**
 * List all projects for the admin UI. Uses service_role; the admin UI
 * must NOT read projects directly via the Browser Supabase client.
 */
export async function listAllProjects(
  client: SupabaseClient<Database>,
): Promise<{ ok: true; projects: Project[] } | { ok: false; code: "ADMIN_WRITE_FAILED" }> {
  try {
    const { data, error } = await client
      .from("projects")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) {
      console.error("PROJECT_LIST_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, projects: (data as Project[] | null) || [] };
  } catch {
    console.error("PROJECT_LIST_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

/**
 * List all products for the project-form product picker. Uses service_role.
 * Returns minimal fields needed for the picker (id, name_cn, name_en).
 */
export async function listAllProductsForProjectPicker(
  client: SupabaseClient<Database>,
): Promise<{ ok: true; products: Product[] } | { ok: false; code: "ADMIN_WRITE_FAILED" }> {
  try {
    const { data, error } = await client
      .from("products")
      .select("*")
      .order("name_cn", { ascending: true });
    if (error) {
      console.error("PROJECT_PRODUCT_LIST_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, products: (data as Product[] | null) || [] };
  } catch {
    console.error("PROJECT_PRODUCT_LIST_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

/**
 * Get a single project with its images + product relations for the
 * admin editor. Uses service_role.
 */
export async function getProjectForEditor(
  client: SupabaseClient<Database>,
  projectId: string,
): Promise<
  | {
      ok: true;
      project: Project;
      images: ProjectImage[];
      products: ProjectProduct[];
    }
  | { ok: false; code: "ADMIN_WRITE_BAD_REQUEST" | "ADMIN_WRITE_FAILED" }
> {
  if (!projectId || !validateUuid("id", projectId).ok) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  try {
    const { data: projectData, error: projectError } = await client
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .maybeSingle();
    if (projectError) {
      console.error("PROJECT_GET_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    if (!projectData) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    const project = projectData as Project;

    const [imagesResult, productsResult] = await Promise.all([
      client
        .from("project_images")
        .select("*")
        .eq("project_id", projectId)
        .order("sort_order", { ascending: true }),
      client
        .from("project_products")
        .select("*")
        .eq("project_id", projectId)
        .order("sort_order", { ascending: true }),
    ]);
    if (imagesResult.error || productsResult.error) {
      console.error("PROJECT_RELATIONS_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return {
      ok: true,
      project,
      images: (imagesResult.data as ProjectImage[] | null) || [],
      products: (productsResult.data as ProjectProduct[] | null) || [],
    };
  } catch {
    console.error("PROJECT_GET_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}
