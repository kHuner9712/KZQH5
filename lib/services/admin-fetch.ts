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
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<AdminFetchResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
 * Delete a single product (or a batch if ids is provided).
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
