// ============================================================
// Mock Supabase REST server for the CI production-contract build.
//
// Review #2 WP8: `npm run build:production` MUST exit 0. Previously
// the production-build CI job allowed `next build` to exit non-zero
// and converted failures to success via `grep "prerender-error"`.
// That hid real build regressions behind prerender failures caused
// by the placeholder Supabase URL.
//
// This script starts a deterministic local HTTP server that responds
// to PostgREST queries the same way the real Supabase REST gateway
// would, using a small fixed dataset that satisfies every CMS query
// exercised during `next build` (site_settings, homepage_content,
// page_content, company_profile, products, categories, certificates,
// projects, product_images, subcategories).
//
// Usage:
//   node scripts/mock-supabase-for-build.mjs --port=5433
//
// The server speaks just enough of the PostgREST v1 wire format to
// satisfy the supabase-js client used by lib/supabase/public.ts:
//   GET /rest/v1/<table>?select=<cols>&<col>=<op>.<value>&order=...
//   → 200 OK, Content-Type: application/json, body = row array
//   .maybeSingle() → client treats array[0] as the row, or null
//   .single()      → client treats array[0] as the row, 0 rows = error
//   .limit(n)      → server-side truncation (we honor n)
//
// The server deliberately returns EMPTY arrays for unknown tables so
// the build still compiles even if a future migration adds a new
// public read table that this mock does not know about. Failures
// from missing tables would be caught at runtime by the existing
// PublicDataUnavailableError contract.
//
// This file MUST NOT be loaded at runtime in production. It is a
// CI build-only fixture. The CI job gates it behind
// BUILD_MOCK_BACKEND=true and the next.config.mjs build-time bypass
// only accepts localhost URLs when that flag is set.
// ============================================================

import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "5433" },
  },
});
const port = Number(values.port);

// ============================================================
// Deterministic test fixtures.
//
// Each row only includes fields that the public read paths actually
// select (see lib/repositories/public-fields.ts). Internal state
// columns (source_bucket, publish_token, etc.) are intentionally
// absent — that mirrors the public read contract.
// ============================================================

const siteSettings = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    site_name: "KZQ",
    site_name_cn: "KZQ 工程级板材",
    site_name_en: "KZQ Engineered Panels",
    brand_name: "KZQ",
    default_language: "zh",
    global_meta_title_cn: "KZQ 工程级板材",
    global_meta_title_en: "KZQ Engineered Panels",
    global_meta_description_cn: "KZQ 工程级板材产品与询盘网站。",
    global_meta_description_en: "KZQ engineered panel products and inquiry website.",
    default_og_image_url: null,
    footer_text_cn: "© KZQ",
    footer_text_en: "© KZQ",
    navigation_json: null,
    meta_title_cn: "KZQ | 工程级板材",
    meta_title_en: "KZQ | Engineered Panels",
    meta_description_cn: "KZQ 工程级板材产品与询盘网站。",
    meta_description_en: "KZQ engineered panel products and inquiry website.",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const homepageContent = [
  {
    id: "00000000-0000-0000-0000-000000000010",
    hero_eyebrow_cn: "工程级板材",
    hero_eyebrow_en: "Engineered Panels",
    hero_title_cn: "KZQ 工程级板材",
    hero_title_en: "KZQ Engineered Panels",
    hero_highlight_cn: "B级防火 / E0级环保",
    hero_highlight_en: "Class B fire rating / E0 eco grade",
    hero_description_cn: "KZQ 工程级板材产品与询盘网站。",
    hero_description_en: "KZQ engineered panel products and inquiry website.",
    primary_cta_text_cn: "联系我们",
    primary_cta_text_en: "Contact us",
    secondary_cta_text_cn: "查看产品",
    secondary_cta_text_en: "View products",
    feature_section_title_cn: "核心优势",
    feature_section_title_en: "Core advantages",
    feature_section_subtitle_cn: "",
    feature_section_subtitle_en: "",
    featured_products_title_cn: "推荐产品",
    featured_products_subtitle_cn: "",
    bottom_cta_title_cn: "立即询盘",
    bottom_cta_title_en: "Get a quote",
    is_active: true,
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const pageContent = [
  {
    id: "00000000-0000-0000-0000-000000000020",
    page_key: "about",
    title_cn: "关于我们",
    title_en: "About us",
    subtitle_cn: "",
    subtitle_en: "",
    description_cn: "KZQ 公司介绍。",
    description_en: "KZQ company introduction.",
    sections_cn: [],
    sections_en: [],
    seo_title_cn: "关于 KZQ",
    seo_title_en: "About KZQ",
    seo_description_cn: "KZQ 公司介绍。",
    seo_description_en: "KZQ company introduction.",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const companyProfile = [
  {
    id: "00000000-0000-0000-0000-000000000030",
    title_cn: "KZQ 建材",
    title_en: "KZQ Building Materials",
    description_cn: "KZQ 工程级板材制造商。",
    description_en: "KZQ engineered panel manufacturer.",
    advantages_cn: [],
    advantages_en: [],
    phone: "+86-000-0000-0000",
    wechat: "kzq-official",
    email: "sales@kzq.test",
    whatsapp: "",
    address_cn: "中国",
    address_en: "China",
    wechat_qr_url: null,
    logo_url: null,
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const categories = [
  {
    id: "00000000-0000-0000-0000-000000000040",
    name_cn: "示例分类",
    name_en: "Sample category",
    slug: "sample-category",
    description_cn: "示例分类描述。",
    description_en: "Sample category description.",
    sort_order: 0,
    is_active: true,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const subcategories = [];

const products = [
  {
    id: "00000000-0000-0000-0000-000000000050",
    category_id: "00000000-0000-0000-0000-000000000040",
    subcategory_id: null,
    name_cn: "示例产品",
    name_en: "Sample product",
    slug: "sample-product",
    summary_cn: "示例产品摘要。",
    summary_en: "Sample product summary.",
    description_cn: "示例产品描述。",
    description_en: "Sample product description.",
    material_cn: "工程级板材",
    material_en: "Engineered panel",
    size: "1220 x 2440 mm",
    fire_rating: "B级",
    eco_grade: "E0级",
    price_display_cn: "请联系销售获取报价",
    price_display_en: "Contact for quotation",
    moq: null,
    packaging_cn: "",
    packaging_en: "",
    logistics_cn: "",
    logistics_en: "",
    application_cn: "",
    application_en: "",
    video_url: null,
    cover_image_url: null,
    is_published: true,
    is_featured: true,
    sort_order: 0,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const productImages = [];

const certificates = [
  {
    id: "00000000-0000-0000-0000-000000000060",
    name_cn: "示例证书",
    name_en: "Sample certificate",
    description_cn: "示例证书描述。",
    description_en: "Sample certificate description.",
    image_url: null,
    applicable_scope_cn: "",
    applicable_scope_en: "",
    is_published: true,
    sort_order: 0,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const projects = [
  {
    id: "00000000-0000-0000-0000-000000000070",
    slug: "sample-project",
    title_cn: "示例案例",
    title_en: "Sample project",
    summary_cn: "示例案例摘要。",
    summary_en: "Sample project summary.",
    description_cn: "示例案例描述。",
    description_en: "Sample project description.",
    country_cn: "中国",
    country_en: "China",
    project_type_cn: "商业空间",
    project_type_en: "Commercial space",
    cover_image_url: null,
    is_published: true,
    is_featured: true,
    sort_order: 0,
    seo_title_cn: "示例案例",
    seo_title_en: "Sample project",
    seo_description_cn: "示例案例描述。",
    seo_description_en: "Sample project description.",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const projectImages = [];
const projectProducts = [];

const tableData = {
  site_settings: siteSettings,
  homepage_content: homepageContent,
  page_content: pageContent,
  company_profile: companyProfile,
  categories,
  subcategories,
  products,
  product_images: productImages,
  certificates,
  projects,
  project_images: projectImages,
  project_products: projectProducts,
};

// ============================================================
// Minimal PostgREST filter evaluator.
// Only the operators actually used by lib/repositories/* are
// implemented. Anything else returns the unfiltered rows so the
// build still succeeds (we prefer false-positive data over a
// false-negative build failure).
// ============================================================

function applyFilter(rows, column, operator, value) {
  if (operator === "eq") {
    const v = value === "true" ? true : value === "false" ? false : value === "null" ? null : value;
    return rows.filter((row) => row[column] === v);
  }
  if (operator === "in") {
    const list = value.split(",").map((s) => s.trim());
    return rows.filter((row) => list.includes(String(row[column])));
  }
  // Unknown operator: do not filter (fail-open so the build can
  // proceed; correctness is enforced by unit tests, not the mock).
  return rows;
}

function applyOrder(rows, orderParam) {
  if (!orderParam) return rows;
  const parts = orderParam.split(",");
  const sorted = [...rows];
  for (const part of parts) {
    const [col, dir] = part.split(".");
    if (!col) continue;
    sorted.sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return av < bv ? -1 : 1;
    });
    if (dir === "desc") sorted.reverse();
  }
  return sorted;
}

function handleRest(req, res, url) {
  const pathSegments = url.pathname.split("/").filter(Boolean);
  // Expected: /rest/v1/<table>
  if (pathSegments.length < 3 || pathSegments[0] !== "rest" || pathSegments[1] !== "v1") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not found" }));
    return;
  }
  const table = pathSegments[2];
  const rows = tableData[table] ?? [];

  // Parse query params. supabase-js sends filters like
  // `is_published=eq.true` and `id=in.(uuid1,uuid2)`. The `select`
  // param lists projected columns. We ignore projection here —
  // supabase-js parses the response and only keeps the projected
  // columns client-side, so returning the full row is safe.
  let filtered = rows;
  let orderParam = null;
  let limit = null;

  for (const [key, rawValue] of url.searchParams.entries()) {
    if (key === "select") continue;
    if (key === "order") {
      orderParam = rawValue;
      continue;
    }
    if (key === "limit") {
      limit = Number(rawValue);
      continue;
    }
    if (key === "offset") continue;
    // Filter: `<column>=<op>.<value>` or `<column>=<value>` (eq implied).
    const dotIdx = rawValue.indexOf(".");
    if (dotIdx === -1) {
      filtered = applyFilter(filtered, key, "eq", rawValue);
    } else {
      const op = rawValue.slice(0, dotIdx);
      const val = rawValue.slice(dotIdx + 1);
      filtered = applyFilter(filtered, key, op, val);
    }
  }

  filtered = applyOrder(filtered, orderParam);
  if (limit !== null && Number.isFinite(limit)) {
    filtered = filtered.slice(0, limit);
  }

  // PostgREST returns 200 with an array body. supabase-js's
  // maybeSingle() treats array[0] as the row, [] as null. single()
  // treats [] as an error — we never want that path during build,
  // so every queried table has at least one row above.
  res.writeHead(200, {
    "Content-Type": "application/json",
    // PostgREST metadata headers used by supabase-js for range
    // queries. We return the full array, so range is 0..n-1.
    "Content-Range": `0-${Math.max(filtered.length - 1, -1)}/*`,
    "Profile": "public",
  });
  res.end(JSON.stringify(filtered));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (req.method !== "GET" || !url.pathname.startsWith("/rest/v1/")) {
    // Auth / Storage / Realtime endpoints are not exercised during
    // build. Return 404 for any path we do not handle.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not found" }));
    return;
  }
  try {
    handleRest(req, res, url);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Mock server error", error: String(err) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-supabase] listening on http://127.0.0.1:${port}`);
});

// Keep the process alive until SIGTERM/SIGINT.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
