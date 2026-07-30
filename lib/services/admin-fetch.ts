/**
 * Phase 2 client-side admin API helper.
 *
 * All admin CMS write operations now go through these helpers instead of
 * calling the Supabase client directly from Client Components. Each helper
 * posts JSON to the corresponding /api/admin/* route, which enforces
 * service_role admin verification, fail-closed same-origin, Content-Type
 * and body-size limits, field validation, and transactional RPCs.
 *
 * Errors are returned as a fixed code string (matching ADMIN_WRITE_* on the
 * server). The underlying database error is never forwarded to the client.
 */

export type AdminFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; status: number };

async function adminFetch<T>(
  url: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<AdminFetchResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers:
        method === "GET"
          ? undefined
          : { "Content-Type": "application/json" },
      body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON response -> treat as generic failure.
      }
    }
    if (!res.ok) {
      const code =
        json && typeof json === "object" && "error" in json
          ? String((json as Record<string, unknown>).error)
          : "ADMIN_WRITE_FAILED";
      return { ok: false, code, status: res.status };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, code: "ADMIN_WRITE_NETWORK", status: 0 };
  }
}

export interface ProductListResponse {
  success: true;
  products: import("@/types/database").Product[];
  total: number;
  categories: import("@/types/database").Category[];
  subcategories: import("@/types/database").Subcategory[];
  demo?: boolean;
}

/**
 * List products (paged/filtered) via the trusted server API.
 *
 * The admin UI MUST call this instead of reading products via the Browser
 * Supabase client. The anon client is RLS-filtered to published rows, so
 * drafts (is_published=false) would be invisible. The server uses
 * service_role to bypass RLS and returns drafts as well.
 *
 * The response also includes all categories + subcategories so the UI can
 * populate the filter bar and the bulk-change-category modal without
 * extra round-trips.
 */
export function listProductsApi(params: {
  page: number;
  pageSize: number;
  status: "all" | "published" | "draft" | "featured";
  categoryId?: string;
  subcategoryId?: string;
  search?: string;
  sort?: "default" | "updated" | "name";
}): Promise<AdminFetchResult<ProductListResponse>> {
  const qs = new URLSearchParams();
  qs.set("page", String(params.page));
  qs.set("pageSize", String(params.pageSize));
  qs.set("status", params.status);
  if (params.categoryId) qs.set("categoryId", params.categoryId);
  if (params.subcategoryId) qs.set("subcategoryId", params.subcategoryId);
  if (params.search) qs.set("search", params.search);
  if (params.sort) qs.set("sort", params.sort);
  return adminFetch<ProductListResponse>(
    `/api/admin/products?${qs.toString()}`,
    "GET",
  );
}

export interface ProductForCopyResponse {
  success: true;
  product: import("@/types/database").Product | null;
  images: import("@/types/database").ProductImage[];
  demo?: boolean;
}

/**
 * Fetch a single product + its images via the trusted server API.
 *
 * Used by the admin "copy product" flow. service_role bypasses RLS so a
 * draft product can be copied (the anon client would 404/empty on drafts).
 */
export function getProductForCopyApi(
  id: string,
): Promise<AdminFetchResult<ProductForCopyResponse>> {
  return adminFetch<ProductForCopyResponse>(
    `/api/admin/products/${id}`,
    "GET",
  );
}

export interface ProductSaveResponse {
  success: true;
  id: string;
  demo?: boolean;
}

export interface BulkProductResponse {
  success: true;
  count: number;
  demo?: boolean;
}

/**
 * Save (create or update) a product together with its images via the
 * transactional RPC. If `payload.id` is provided the product is updated;
 * otherwise a new product is created.
 *
 * Optimistic lock (Phase 3): when updating an existing product the
 * caller MUST pass `expected_updated_at` set to the `updated_at`
 * timestamp of the product record currently in the editor. The server
 * RPC compares this against `products.updated_at` using `FOR UPDATE`
 * and rejects the update with 409 (ADMIN_WRITE_CONFLICT) when another
 * edit landed in between. Creates omit `expected_updated_at` (the
 * server ignores it for inserts).
 */
export function saveProduct(payload: {
  id?: string;
  product: Record<string, unknown>;
  images: Array<{
    image_url: string;
    alt_cn: string | null;
    alt_en: string | null;
    sort_order: number;
  }>;
  expected_updated_at?: string | null;
}): Promise<AdminFetchResult<ProductSaveResponse>> {
  return adminFetch<ProductSaveResponse>("/api/admin/products", "POST", payload);
}

/**
 * Bulk update a boolean / category field across many products.
 */
export function bulkUpdateProductsApi(
  ids: string[],
  patch: {
    is_published?: boolean;
    is_featured?: boolean;
    category_id?: string | null;
    subcategory_id?: string | null;
  },
): Promise<AdminFetchResult<BulkProductResponse>> {
  return adminFetch<BulkProductResponse>("/api/admin/products", "PATCH", {
    ids,
    ...patch,
  });
}

/**
 * Delete a single product (or a batch if ids is given).
 */
export function deleteProductsApi(
  id: string,
  ids?: string[],
): Promise<AdminFetchResult<BulkProductResponse>> {
  return adminFetch<BulkProductResponse>(
    `/api/admin/products/${id}`,
    "DELETE",
    ids ? { ids } : { id },
  );
}

// ============================================================
// Product Assets (Section 4)
// -------------------------------------------------------------

export interface ProductAssetListResponse {
  success: true;
  assets: import("@/types/database").ProductAsset[];
  demo?: boolean;
}

/**
 * List all product assets via the trusted server API.
 *
 * The admin UI MUST call this instead of reading product_assets via
 * the Browser Supabase client. Uses service_role on the server.
 */
export function listProductAssetsApi(): Promise<
  AdminFetchResult<ProductAssetListResponse>
> {
  return adminFetch<ProductAssetListResponse>(
    "/api/admin/product-assets",
    "GET",
  );
}

export interface ProductAssetSaveResponse {
  success: true;
  id: string;
  updatedAt?: string;
  demo?: boolean;
}

export interface ProductAssetPublishResponse {
  success: true;
  ref?: {
    bucket: string;
    path: string;
    publicUrl: string;
    mimeType?: string;
    size?: number;
  };
  demo?: boolean;
}

/**
 * Save (create or update) a product asset draft via the trusted server API.
 * The server RPC enforces optimistic lock, structured private-assets ref,
 * atomic audit, and rejects draft saves over publishing/published rows.
 *
 * On update, `expectedUpdatedAt` MUST be the row's current `updated_at`
 * (optimistic lock). On create, `id` is omitted and `expectedUpdatedAt`
 * is ignored.
 */
export function saveProductAssetApi(payload: {
  id?: string;
  expectedUpdatedAt?: string | null;
  payload: Record<string, unknown>;
  sourceBucket: "private-assets";
  sourceObjectPath: string;
  mimeType?: string | null;
  fileSize?: number | null;
  sha256?: string | null;
  accessLevel?: "public" | "private";
  sourceType?: "official" | "self-produced" | "licensed" | "public-domain" | null;
}): Promise<AdminFetchResult<ProductAssetSaveResponse>> {
  return adminFetch<ProductAssetSaveResponse>(
    "/api/admin/product-assets",
    "POST",
    payload,
  );
}

/**
 * Update product asset metadata (non-storage fields) via PATCH.
 * Does NOT change source ref or publish state.
 */
export function updateProductAssetApi(
  id: string,
  payload: {
    expectedUpdatedAt: string;
    payload: Record<string, unknown>;
    accessLevel?: "public" | "private";
    sourceType?: "official" | "self-produced" | "licensed" | "public-domain" | null;
  },
): Promise<AdminFetchResult<ProductAssetSaveResponse>> {
  return adminFetch<ProductAssetSaveResponse>(
    `/api/admin/product-assets/${id}`,
    "PATCH",
    payload,
  );
}

/**
 * Delete a product asset atomically (row + cleanup enqueue) via DELETE.
 * The server RPC enqueues both published and source objects for cleanup
 * in the same transaction.
 */
export function deleteProductAssetApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<{ success: true; id: string; demo?: boolean }>> {
  return adminFetch<{ success: true; id: string; demo?: boolean }>(
    `/api/admin/product-assets/${id}`,
    "DELETE",
    { expectedUpdatedAt },
  );
}

/**
 * Authorize a product asset via the dedicated server-side RPC.
 * This is NOT a generic PATCH — `authorization_status='confirmed'` can
 * only be set by this dedicated command with atomic audit.
 */
export function authorizeProductAssetApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<ProductAssetSaveResponse>> {
  return adminFetch<ProductAssetSaveResponse>(
    `/api/admin/product-assets/${id}/authorize`,
    "POST",
    { expectedUpdatedAt },
  );
}

/**
 * Publish a product asset via the two-phase claim/finalize protocol.
 * The server copies the private-assets source to public-assets and
 * atomically updates the row + enqueues cleanup + writes audit.
 */
export function publishProductAssetApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<ProductAssetPublishResponse>> {
  return adminFetch<ProductAssetPublishResponse>(
    `/api/admin/product-assets/${id}/publish`,
    "POST",
    { expectedUpdatedAt },
  );
}

/**
 * Unpublish a product asset atomically (publish→draft transition).
 * Enqueues old public object for cleanup in the same transaction.
 */
export function unpublishProductAssetApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<ProductAssetSaveResponse>> {
  return adminFetch<ProductAssetSaveResponse>(
    `/api/admin/product-assets/${id}/unpublish`,
    "POST",
    { expectedUpdatedAt },
  );
}

// ============================================================
// Certificates (Section 6)
// -------------------------------------------------------------

export interface CertificateListResponse {
  success: true;
  certificates: import("@/types/database").Certificate[];
  demo?: boolean;
}

/**
 * List all certificates via the trusted server API.
 *
 * The admin UI MUST call this instead of reading certificates via
 * the Browser Supabase client. Uses service_role on the server.
 */
export function listCertificatesApi(): Promise<
  AdminFetchResult<CertificateListResponse>
> {
  return adminFetch<CertificateListResponse>(
    "/api/admin/certificates",
    "GET",
  );
}

export interface CertificateSaveResponse {
  success: true;
  id: string;
  updatedAt?: string;
  demo?: boolean;
}

export interface CertificatePublishResponse {
  success: true;
  ref?: {
    bucket: string;
    path: string;
    publicUrl: string;
    mimeType?: string;
    size?: number;
  };
  demo?: boolean;
}

/**
 * Save (create or update) a certificate draft via the trusted server API.
 * The server RPC enforces optimistic lock, structured private-assets ref,
 * atomic audit, and rejects draft saves over publishing/published rows.
 */
export function saveCertificateApi(payload: {
  id?: string;
  expectedUpdatedAt?: string | null;
  payload: Record<string, unknown>;
  sourceBucket: "private-assets";
  sourceObjectPath: string;
  mimeType?: string | null;
  fileSize?: number | null;
  sha256?: string | null;
  accessLevel?: "public" | "private";
  sourceType?: "official" | "self-produced" | "licensed" | "public-domain" | null;
}): Promise<AdminFetchResult<CertificateSaveResponse>> {
  return adminFetch<CertificateSaveResponse>(
    "/api/admin/certificates",
    "POST",
    payload,
  );
}

/**
 * Update certificate metadata (non-storage fields) via PATCH.
 */
export function updateCertificateApi(
  id: string,
  payload: {
    expectedUpdatedAt: string;
    payload: Record<string, unknown>;
    accessLevel?: "public" | "private";
    sourceType?: "official" | "self-produced" | "licensed" | "public-domain" | null;
  },
): Promise<AdminFetchResult<CertificateSaveResponse>> {
  return adminFetch<CertificateSaveResponse>(
    `/api/admin/certificates/${id}`,
    "PATCH",
    payload,
  );
}

/**
 * Delete a certificate atomically (row + cleanup enqueue) via DELETE.
 */
export function deleteCertificateApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<{ success: true; id: string; demo?: boolean }>> {
  return adminFetch<{ success: true; id: string; demo?: boolean }>(
    `/api/admin/certificates/${id}`,
    "DELETE",
    { expectedUpdatedAt },
  );
}

/**
 * Authorize a certificate via the dedicated server-side RPC.
 */
export function authorizeCertificateApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<CertificateSaveResponse>> {
  return adminFetch<CertificateSaveResponse>(
    `/api/admin/certificates/${id}/authorize`,
    "POST",
    { expectedUpdatedAt },
  );
}

/**
 * Publish a certificate via the two-phase claim/finalize protocol.
 */
export function publishCertificateApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<CertificatePublishResponse>> {
  return adminFetch<CertificatePublishResponse>(
    `/api/admin/certificates/${id}/publish`,
    "POST",
    { expectedUpdatedAt },
  );
}

/**
 * Unpublish a certificate atomically (publish→draft transition).
 */
export function unpublishCertificateApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<CertificateSaveResponse>> {
  return adminFetch<CertificateSaveResponse>(
    `/api/admin/certificates/${id}/unpublish`,
    "POST",
    { expectedUpdatedAt },
  );
}

// ============================================================
// Projects (Section 7)
// -------------------------------------------------------------

export interface ProjectListResponse {
  success: true;
  projects: import("@/types/database").Project[];
  products: import("@/types/database").Product[];
  demo?: boolean;
}

export interface ProjectEditorResponse {
  success: true;
  project: import("@/types/database").Project | null;
  images: import("@/types/database").ProjectImage[];
  products: import("@/types/database").ProjectProduct[];
  demo?: boolean;
}

export interface ProjectSaveResponse {
  success: true;
  id: string;
  demo?: boolean;
}

/**
 * List all projects + products (for the project form picker) via the
 * trusted server API. Uses service_role on the server.
 */
export function listProjectsApi(): Promise<
  AdminFetchResult<ProjectListResponse>
> {
  return adminFetch<ProjectListResponse>("/api/admin/projects", "GET");
}

/**
 * Fetch a single project with its images + product relations for the
 * admin editor.
 */
export function getProjectEditorApi(
  id: string,
): Promise<AdminFetchResult<ProjectEditorResponse>> {
  return adminFetch<ProjectEditorResponse>(
    `/api/admin/projects/${id}`,
    "GET",
  );
}

/**
 * Save (create or update) a project together with its images and
 * product relations via the transactional RPC. The RPC enforces
 * optimistic lock, atomic relations replace, cleanup enqueue, and
 * audit in the same transaction.
 *
 * On update, `expectedUpdatedAt` MUST be the row's current `updated_at`.
 * On create, `id` is omitted and `expectedUpdatedAt` is ignored.
 */
export function saveProjectApi(payload: {
  id?: string;
  expectedUpdatedAt?: string | null;
  project: Record<string, unknown>;
  images: Array<{
    image_url: string;
    alt_cn: string | null;
    alt_en: string | null;
    sort_order: number;
  }>;
  products: Array<{
    product_id: string;
    sort_order: number;
  }>;
}): Promise<AdminFetchResult<ProjectSaveResponse>> {
  return adminFetch<ProjectSaveResponse>("/api/admin/projects", "POST", payload);
}

/**
 * Delete a project atomically (row + cleanup enqueue + audit) via DELETE.
 * Requires optimistic lock (expectedUpdatedAt).
 */
export function deleteProjectApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<{ success: true; id: string; demo?: boolean }>> {
  return adminFetch<{ success: true; id: string; demo?: boolean }>(
    `/api/admin/projects/${id}`,
    "DELETE",
    { expectedUpdatedAt },
  );
}

// ============================================================
// CMS Content (Section 7): company / site-settings / homepage /
// pages / categories / subcategories
// -------------------------------------------------------------
// All writes go through trusted server APIs that enforce
// requireAdminWrite, optimistic lock, atomic audit, and cleanup
// enqueue for replaced storage refs.
// ============================================================

export interface ContentSaveResponse {
  success: true;
  id: string;
  updatedAt?: string;
  demo?: boolean;
}

export interface ContentDeleteResponse {
  success: true;
  id: string;
  demo?: boolean;
}

// ---- Company Profile ----

export interface CompanyProfileGetResponse {
  success: true;
  profile: import("@/types/database").CompanyProfile | null;
  demo?: boolean;
}

export function getCompanyProfileApi(): Promise<
  AdminFetchResult<CompanyProfileGetResponse>
> {
  return adminFetch<CompanyProfileGetResponse>("/api/admin/company", "GET");
}

export function saveCompanyProfileApi(payload: {
  id?: string | null;
  expectedUpdatedAt?: string | null;
  payload: Record<string, unknown>;
}): Promise<AdminFetchResult<ContentSaveResponse>> {
  return adminFetch<ContentSaveResponse>("/api/admin/company", "POST", payload);
}

// ---- Site Settings ----

export interface SiteSettingsGetResponse {
  success: true;
  settings: import("@/types/database").SiteSettings | null;
  demo?: boolean;
}

export function getSiteSettingsApi(): Promise<
  AdminFetchResult<SiteSettingsGetResponse>
> {
  return adminFetch<SiteSettingsGetResponse>("/api/admin/site-settings", "GET");
}

export function saveSiteSettingsApi(payload: {
  id?: string | null;
  expectedUpdatedAt?: string | null;
  payload: Record<string, unknown>;
}): Promise<AdminFetchResult<ContentSaveResponse>> {
  return adminFetch<ContentSaveResponse>(
    "/api/admin/site-settings",
    "POST",
    payload,
  );
}

// ---- Homepage Content ----

export interface HomepageContentGetResponse {
  success: true;
  content: import("@/types/database").HomepageContent | null;
  demo?: boolean;
}

export function getHomepageContentApi(): Promise<
  AdminFetchResult<HomepageContentGetResponse>
> {
  return adminFetch<HomepageContentGetResponse>("/api/admin/homepage", "GET");
}

export function saveHomepageContentApi(payload: {
  id?: string | null;
  expectedUpdatedAt?: string | null;
  payload: Record<string, unknown>;
}): Promise<AdminFetchResult<ContentSaveResponse>> {
  return adminFetch<ContentSaveResponse>(
    "/api/admin/homepage",
    "POST",
    payload,
  );
}

// ---- Page Content ----

export interface PageListResponse {
  success: true;
  pages: import("@/types/database").PageContent[];
  demo?: boolean;
}

export function listPagesApi(): Promise<AdminFetchResult<PageListResponse>> {
  return adminFetch<PageListResponse>("/api/admin/pages", "GET");
}

export function savePageApi(payload: {
  id?: string | null;
  expectedUpdatedAt?: string | null;
  payload: Record<string, unknown>;
}): Promise<AdminFetchResult<ContentSaveResponse>> {
  return adminFetch<ContentSaveResponse>("/api/admin/pages", "POST", payload);
}

// ---- Categories ----

export interface CategoryListResponse {
  success: true;
  categories: import("@/types/database").Category[];
  subcategories: import("@/types/database").Subcategory[];
  demo?: boolean;
}

export function listCategoriesApi(): Promise<
  AdminFetchResult<CategoryListResponse>
> {
  return adminFetch<CategoryListResponse>("/api/admin/categories", "GET");
}

export function saveCategoryApi(payload: {
  id?: string | null;
  expectedUpdatedAt?: string | null;
  payload: Record<string, unknown>;
}): Promise<AdminFetchResult<ContentSaveResponse>> {
  return adminFetch<ContentSaveResponse>("/api/admin/categories", "POST", payload);
}

export function toggleCategoryApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<ContentSaveResponse>> {
  return adminFetch<ContentSaveResponse>(
    `/api/admin/categories/${id}`,
    "PATCH",
    { expectedUpdatedAt },
  );
}

export function deleteCategoryApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<ContentDeleteResponse>> {
  return adminFetch<ContentDeleteResponse>(
    `/api/admin/categories/${id}`,
    "DELETE",
    { expectedUpdatedAt },
  );
}

// ---- Subcategories ----

export function saveSubcategoryApi(payload: {
  id?: string | null;
  expectedUpdatedAt?: string | null;
  payload: Record<string, unknown>;
}): Promise<AdminFetchResult<ContentSaveResponse>> {
  return adminFetch<ContentSaveResponse>(
    "/api/admin/subcategories",
    "POST",
    payload,
  );
}

export function toggleSubcategoryApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<ContentSaveResponse>> {
  return adminFetch<ContentSaveResponse>(
    `/api/admin/subcategories/${id}`,
    "PATCH",
    { expectedUpdatedAt },
  );
}

export function deleteSubcategoryApi(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminFetchResult<ContentDeleteResponse>> {
  return adminFetch<ContentDeleteResponse>(
    `/api/admin/subcategories/${id}`,
    "DELETE",
    { expectedUpdatedAt },
  );
}
