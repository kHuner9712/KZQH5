/**
 * CMS content admin write service (Section 7).
 *
 * Trusted server-side boundary for company_profile, site_settings,
 * homepage_content, page_content, categories and subcategories.
 *
 * The admin UI MUST call the /api/admin/* routes which in turn call
 * these functions — never the Browser Supabase client.
 *
 * Every write goes through a transactional RPC that:
 *   - enforces optimistic lock (expected_updated_at required for updates)
 *   - writes audit in the same transaction (no best-effort audit)
 *   - enqueues replaced/old storage objects for cleanup atomically
 *     (e.g. company_logo, wechat_qr, default_og_image)
 *
 * Errors are classified into coarse-grained AdminWriteErrorCode values;
 * SQL / internal details are never forwarded to the client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Category,
  CompanyProfile,
  Database,
  HomepageContent,
  NavItem,
  PageContent,
  SiteSettings,
  Subcategory,
} from "@/types/database";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";

export type ContentWriteResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: AdminWriteErrorCode };

export interface AdminActor {
  id: string;
  email?: string | null;
  role?: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_TEXT = 5000;
const MAX_LONG_TEXT = 20000;
const MAX_URL = 2048;
const MAX_NAV_ITEMS = 50;
const MAX_SORT = 100000;

function classifyPgError(errCode: string | undefined): AdminWriteErrorCode {
  if (!errCode) return "ADMIN_WRITE_FAILED";
  const upper = errCode.toUpperCase();
  if (upper === "22004" || upper === "P0002" || upper === "23502" || upper === "23503" || upper === "22P02") {
    return "ADMIN_WRITE_BAD_REQUEST";
  }
  if (upper === "40P01" || upper === "40001" || upper === "23505") {
    return "ADMIN_WRITE_CONFLICT";
  }
  return "ADMIN_WRITE_FAILED";
}

function extractErrCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

// ============================================================
// Company Profile
// ============================================================

export interface CompanyProfilePayload {
  title_cn: string | null;
  title_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  advantages_cn: unknown;
  advantages_en: unknown;
  phone: string | null;
  wechat: string | null;
  email: string | null;
  whatsapp: string | null;
  address_cn: string | null;
  address_en: string | null;
  wechat_qr_url: string | null;
  logo_url: string | null;
}

export async function getCompanyProfile(
  client: SupabaseClient<Database>,
): Promise<ContentWriteResult<CompanyProfile | null>> {
  try {
    const { data, error } = await client
      .from("company_profile")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("COMPANY_PROFILE_READ_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: (data as CompanyProfile | null) || null };
  } catch {
    console.error("COMPANY_PROFILE_READ_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

export async function saveCompanyProfile(
  client: SupabaseClient<Database>,
  input: {
    id?: string | null;
    payload: CompanyProfilePayload;
    expectedUpdatedAt?: string | null;
  },
  actor: AdminActor,
): Promise<ContentWriteResult<{ id: string; updatedAt: string }>> {
  // Validate
  if (input.id) {
    if (!UUID_RE.test(input.id)) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (!input.expectedUpdatedAt) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }

  // Coerce advantages arrays to jsonb-friendly values; allow null
  const advantagesCn =
    input.payload.advantages_cn == null ? null : input.payload.advantages_cn;
  const advantagesEn =
    input.payload.advantages_en == null ? null : input.payload.advantages_en;

  const rpcPayload = {
    title_cn: input.payload.title_cn,
    title_en: input.payload.title_en,
    description_cn: input.payload.description_cn,
    description_en: input.payload.description_en,
    advantages_cn: advantagesCn,
    advantages_en: advantagesEn,
    phone: input.payload.phone,
    wechat: input.payload.wechat,
    email: input.payload.email,
    whatsapp: input.payload.whatsapp,
    address_cn: input.payload.address_cn,
    address_en: input.payload.address_en,
    wechat_qr_url: input.payload.wechat_qr_url,
    logo_url: input.payload.logo_url,
  };

  try {
    const { data, error } = await client.rpc("save_company_profile_with_audit", {
      p_id: input.id ?? null,
      p_payload: rpcPayload,
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("COMPANY_PROFILE_SAVE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("COMPANY_PROFILE_SAVE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

// ============================================================
// Site Settings
// ============================================================

export interface SiteSettingsPayload {
  site_name: string;
  site_name_cn: string | null;
  site_name_en: string | null;
  brand_name: string | null;
  default_language: string;
  global_meta_title_cn: string | null;
  global_meta_title_en: string | null;
  global_meta_description_cn: string | null;
  global_meta_description_en: string | null;
  default_og_image_url: string | null;
  footer_text_cn: string | null;
  footer_text_en: string | null;
  navigation_json: NavItem[];
}

export async function getSiteSettings(
  client: SupabaseClient<Database>,
): Promise<ContentWriteResult<SiteSettings | null>> {
  try {
    const { data, error } = await client
      .from("site_settings")
      .select("*")
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("SITE_SETTINGS_READ_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: (data as SiteSettings | null) || null };
  } catch {
    console.error("SITE_SETTINGS_READ_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

export async function saveSiteSettings(
  client: SupabaseClient<Database>,
  input: {
    id?: string | null;
    payload: SiteSettingsPayload;
    expectedUpdatedAt?: string | null;
  },
  actor: AdminActor,
): Promise<ContentWriteResult<{ id: string; updatedAt: string }>> {
  if (!input.payload.site_name || input.payload.site_name.trim().length === 0) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  const lang = input.payload.default_language || "zh";
  if (lang !== "zh" && lang !== "en") {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (input.payload.site_name.length > MAX_TEXT) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!Array.isArray(input.payload.navigation_json)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (input.payload.navigation_json.length > MAX_NAV_ITEMS) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  if (input.id) {
    if (!UUID_RE.test(input.id)) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (!input.expectedUpdatedAt) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }

  const rpcPayload = {
    site_name: input.payload.site_name,
    site_name_cn: input.payload.site_name_cn,
    site_name_en: input.payload.site_name_en,
    brand_name: input.payload.brand_name,
    default_language: lang,
    global_meta_title_cn: input.payload.global_meta_title_cn,
    global_meta_title_en: input.payload.global_meta_title_en,
    global_meta_description_cn: input.payload.global_meta_description_cn,
    global_meta_description_en: input.payload.global_meta_description_en,
    default_og_image_url: input.payload.default_og_image_url,
    footer_text_cn: input.payload.footer_text_cn,
    footer_text_en: input.payload.footer_text_en,
    navigation_json: input.payload.navigation_json,
  };

  try {
    const { data, error } = await client.rpc("save_site_settings_with_audit", {
      p_id: input.id ?? null,
      p_payload: rpcPayload,
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("SITE_SETTINGS_SAVE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("SITE_SETTINGS_SAVE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

// ============================================================
// Homepage Content
// ============================================================

export interface HomepageContentPayload {
  hero_eyebrow_cn: string | null;
  hero_eyebrow_en: string | null;
  hero_title_cn: string | null;
  hero_title_en: string | null;
  hero_highlight_cn: string | null;
  hero_highlight_en: string | null;
  hero_description_cn: string | null;
  hero_description_en: string | null;
  primary_cta_text_cn: string | null;
  primary_cta_text_en: string | null;
  secondary_cta_text_cn: string | null;
  secondary_cta_text_en: string | null;
  feature_section_title_cn: string | null;
  feature_section_title_en: string | null;
  feature_section_subtitle_cn: string | null;
  feature_section_subtitle_en: string | null;
  features_cn: unknown;
  features_en: unknown;
  category_section_title_cn: string | null;
  category_section_subtitle_cn: string | null;
  featured_products_title_cn: string | null;
  featured_products_subtitle_cn: string | null;
  bottom_cta_title_cn: string | null;
  bottom_cta_title_en: string | null;
  bottom_cta_description_cn: string | null;
  bottom_cta_description_en: string | null;
  is_active: boolean;
}

export async function getHomepageContent(
  client: SupabaseClient<Database>,
): Promise<ContentWriteResult<HomepageContent | null>> {
  try {
    // Prefer active row
    const { data: active, error: activeError } = await client
      .from("homepage_content")
      .select("*")
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeError) {
      console.error("HOMEPAGE_READ_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    if (active) {
      return { ok: true, data: active as HomepageContent };
    }
    // Fallback: any row
    const { data: anyRow, error: anyError } = await client
      .from("homepage_content")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (anyError) {
      console.error("HOMEPAGE_READ_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: (anyRow as HomepageContent | null) || null };
  } catch {
    console.error("HOMEPAGE_READ_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

export async function saveHomepageContent(
  client: SupabaseClient<Database>,
  input: {
    id?: string | null;
    payload: HomepageContentPayload;
    expectedUpdatedAt?: string | null;
  },
  actor: AdminActor,
): Promise<ContentWriteResult<{ id: string; updatedAt: string }>> {
  if (input.id) {
    if (!UUID_RE.test(input.id)) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (!input.expectedUpdatedAt) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }

  const rpcPayload = {
    hero_eyebrow_cn: input.payload.hero_eyebrow_cn,
    hero_eyebrow_en: input.payload.hero_eyebrow_en,
    hero_title_cn: input.payload.hero_title_cn,
    hero_title_en: input.payload.hero_title_en,
    hero_highlight_cn: input.payload.hero_highlight_cn,
    hero_highlight_en: input.payload.hero_highlight_en,
    hero_description_cn: input.payload.hero_description_cn,
    hero_description_en: input.payload.hero_description_en,
    primary_cta_text_cn: input.payload.primary_cta_text_cn,
    primary_cta_text_en: input.payload.primary_cta_text_en,
    secondary_cta_text_cn: input.payload.secondary_cta_text_cn,
    secondary_cta_text_en: input.payload.secondary_cta_text_en,
    feature_section_title_cn: input.payload.feature_section_title_cn,
    feature_section_title_en: input.payload.feature_section_title_en,
    feature_section_subtitle_cn: input.payload.feature_section_subtitle_cn,
    feature_section_subtitle_en: input.payload.feature_section_subtitle_en,
    features_cn: input.payload.features_cn ?? [],
    features_en: input.payload.features_en ?? [],
    category_section_title_cn: input.payload.category_section_title_cn,
    category_section_subtitle_cn: input.payload.category_section_subtitle_cn,
    featured_products_title_cn: input.payload.featured_products_title_cn,
    featured_products_subtitle_cn: input.payload.featured_products_subtitle_cn,
    bottom_cta_title_cn: input.payload.bottom_cta_title_cn,
    bottom_cta_title_en: input.payload.bottom_cta_title_en,
    bottom_cta_description_cn: input.payload.bottom_cta_description_cn,
    bottom_cta_description_en: input.payload.bottom_cta_description_en,
    is_active: input.payload.is_active,
  };

  try {
    const { data, error } = await client.rpc("save_homepage_content_with_audit", {
      p_id: input.id ?? null,
      p_payload: rpcPayload,
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("HOMEPAGE_SAVE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("HOMEPAGE_SAVE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

// ============================================================
// Page Content
// ============================================================

export interface PageContentPayload {
  page_key?: string;
  title_cn: string | null;
  title_en: string | null;
  subtitle_cn: string | null;
  subtitle_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  sections_cn: unknown;
  sections_en: unknown;
  seo_title_cn: string | null;
  seo_title_en: string | null;
  seo_description_cn: string | null;
  seo_description_en: string | null;
}

export async function listPageContent(
  client: SupabaseClient<Database>,
): Promise<ContentWriteResult<PageContent[]>> {
  try {
    const { data, error } = await client
      .from("page_content")
      .select("*")
      .order("page_key", { ascending: true });
    if (error) {
      console.error("PAGE_CONTENT_READ_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: (data as PageContent[] | null) || [] };
  } catch {
    console.error("PAGE_CONTENT_READ_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

export async function savePageContent(
  client: SupabaseClient<Database>,
  input: {
    id?: string | null;
    payload: PageContentPayload;
    expectedUpdatedAt?: string | null;
  },
  actor: AdminActor,
): Promise<ContentWriteResult<{ id: string; updatedAt: string }>> {
  if (input.id) {
    if (!UUID_RE.test(input.id)) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (!input.expectedUpdatedAt) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  } else {
    if (
      !input.payload.page_key ||
      input.payload.page_key.trim().length === 0 ||
      input.payload.page_key.length > 64
    ) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }

  const rpcPayload = {
    page_key: input.payload.page_key ?? null,
    title_cn: input.payload.title_cn,
    title_en: input.payload.title_en,
    subtitle_cn: input.payload.subtitle_cn,
    subtitle_en: input.payload.subtitle_en,
    description_cn: input.payload.description_cn,
    description_en: input.payload.description_en,
    sections_cn: input.payload.sections_cn ?? [],
    sections_en: input.payload.sections_en ?? [],
    seo_title_cn: input.payload.seo_title_cn,
    seo_title_en: input.payload.seo_title_en,
    seo_description_cn: input.payload.seo_description_cn,
    seo_description_en: input.payload.seo_description_en,
  };

  try {
    const { data, error } = await client.rpc("save_page_content_with_audit", {
      p_id: input.id ?? null,
      p_payload: rpcPayload,
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("PAGE_CONTENT_SAVE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("PAGE_CONTENT_SAVE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

// ============================================================
// Categories
// ============================================================

export interface CategoryPayload {
  name_cn: string;
  name_en: string | null;
  slug: string;
  description_cn: string | null;
  description_en: string | null;
  sort_order: number;
  is_active: boolean;
}

export async function listCategories(
  client: SupabaseClient<Database>,
): Promise<ContentWriteResult<Category[]>> {
  try {
    const { data, error } = await client
      .from("categories")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      console.error("CATEGORY_LIST_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: (data as Category[] | null) || [] };
  } catch {
    console.error("CATEGORY_LIST_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

export async function listSubcategories(
  client: SupabaseClient<Database>,
): Promise<ContentWriteResult<Subcategory[]>> {
  try {
    const { data, error } = await client
      .from("subcategories")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      console.error("SUBCATEGORY_LIST_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: (data as Subcategory[] | null) || [] };
  } catch {
    console.error("SUBCATEGORY_LIST_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

export async function saveCategory(
  client: SupabaseClient<Database>,
  input: {
    id?: string | null;
    payload: CategoryPayload;
    expectedUpdatedAt?: string | null;
  },
  actor: AdminActor,
): Promise<ContentWriteResult<{ id: string; updatedAt: string }>> {
  if (!input.payload.name_cn || input.payload.name_cn.trim().length === 0) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.payload.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.payload.slug)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (input.payload.name_cn.length > MAX_TEXT) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (
    input.payload.sort_order < 0 ||
    input.payload.sort_order > MAX_SORT ||
    !Number.isInteger(input.payload.sort_order)
  ) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (input.id) {
    if (!UUID_RE.test(input.id)) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (!input.expectedUpdatedAt) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }

  const rpcPayload = {
    name_cn: input.payload.name_cn,
    name_en: input.payload.name_en,
    slug: input.payload.slug,
    description_cn: input.payload.description_cn,
    description_en: input.payload.description_en,
    sort_order: input.payload.sort_order,
    is_active: input.payload.is_active,
  };

  try {
    const { data, error } = await client.rpc("save_category_with_audit", {
      p_id: input.id ?? null,
      p_payload: rpcPayload,
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("CATEGORY_SAVE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("CATEGORY_SAVE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

export async function deleteCategory(
  client: SupabaseClient<Database>,
  input: { id: string; expectedUpdatedAt: string },
  actor: AdminActor,
): Promise<ContentWriteResult<{ id: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  try {
    const { data, error } = await client.rpc("delete_category_with_audit", {
      p_id: input.id,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("CATEGORY_DELETE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const deletedId = typeof data === "string" ? data : "";
    if (!deletedId) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: deletedId } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("CATEGORY_DELETE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

// ============================================================
// Subcategories
// ============================================================

export interface SubcategoryPayload {
  category_id: string;
  name_cn: string;
  name_en: string | null;
  slug: string;
  description_cn: string | null;
  description_en: string | null;
  sort_order: number;
  is_active: boolean;
}

export async function saveSubcategory(
  client: SupabaseClient<Database>,
  input: {
    id?: string | null;
    payload: SubcategoryPayload;
    expectedUpdatedAt?: string | null;
  },
  actor: AdminActor,
): Promise<ContentWriteResult<{ id: string; updatedAt: string }>> {
  if (!input.payload.category_id || !UUID_RE.test(input.payload.category_id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.payload.name_cn || input.payload.name_cn.trim().length === 0) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.payload.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.payload.slug)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (input.payload.name_cn.length > MAX_TEXT) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (
    input.payload.sort_order < 0 ||
    input.payload.sort_order > MAX_SORT ||
    !Number.isInteger(input.payload.sort_order)
  ) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (input.id) {
    if (!UUID_RE.test(input.id)) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (!input.expectedUpdatedAt) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }

  const rpcPayload = {
    category_id: input.payload.category_id,
    name_cn: input.payload.name_cn,
    name_en: input.payload.name_en,
    slug: input.payload.slug,
    description_cn: input.payload.description_cn,
    description_en: input.payload.description_en,
    sort_order: input.payload.sort_order,
    is_active: input.payload.is_active,
  };

  try {
    const { data, error } = await client.rpc("save_subcategory_with_audit", {
      p_id: input.id ?? null,
      p_payload: rpcPayload,
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("SUBCATEGORY_SAVE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("SUBCATEGORY_SAVE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

export async function deleteSubcategory(
  client: SupabaseClient<Database>,
  input: { id: string; expectedUpdatedAt: string },
  actor: AdminActor,
): Promise<ContentWriteResult<{ id: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  try {
    const { data, error } = await client.rpc("delete_subcategory_with_audit", {
      p_id: input.id,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("SUBCATEGORY_DELETE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const deletedId = typeof data === "string" ? data : "";
    if (!deletedId) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: deletedId } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("SUBCATEGORY_DELETE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

// Reserved exports to satisfy lint (no unused vars in module)
export const _MAX_LONG_TEXT = MAX_LONG_TEXT;
export const _MAX_URL = MAX_URL;
