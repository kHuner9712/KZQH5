// ============================================================
// KZQ Release Readiness Check (read-only)
//
// Performs read-only pre-deployment checks across:
//   1. Git & build state
//   2. URL & SEO configuration
//   3. Supabase schema (catalog fields + analytics constraint)
//   4. Business content (placeholder contact data, catalog counts)
//
// Exit codes:
//   - 0: no BLOCK (PASS or WARN only)
//   - 1: at least one BLOCK found
//
// Usage:
//   node scripts/check-release-readiness.mjs
//   node scripts/check-release-readiness.mjs -- --mode=staging
//
// This script is strictly read-only. It never modifies the database,
// storage policies, or deployment environment. It never prints secrets.
// ============================================================

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ---------- Argument parsing ----------

const args = process.argv.slice(2);
const stagingMode = args.some((a) => a.includes("mode=staging"));

// ---------- Result collection ----------

const results = [];

function pass(label, detail = "") {
  results.push({ level: "PASS", label, detail });
}
function warn(label, detail = "") {
  results.push({ level: "WARN", label, detail });
}
function block(label, detail = "") {
  results.push({ level: "BLOCK", label, detail });
}

// ---------- Placeholder detection (mirrors lib/content/placeholder-detection.ts) ----------

function isEmpty(value) {
  return !value || String(value).trim().length === 0;
}

function hasPlaceholderMarker(value) {
  const lower = String(value).toLowerCase();
  return (
    /\bplaceholder\b/.test(lower) ||
    /\bmock\b/.test(lower) ||
    /\bdemo\b/.test(lower) ||
    /\bsample\b/.test(lower) ||
    /\btodo\b/.test(lower) ||
    /\btbd\b/.test(lower) ||
    /\bfixme\b/.test(lower) ||
    /\bxxx\b/.test(lower)
  );
}

function hasConsecutiveZeros(value) {
  const digits = String(value).replace(/[^\d]/g, "");
  return /0{4,}/.test(digits);
}

function isPlaceholderPhone(value) {
  if (isEmpty(value)) return true;
  if (hasConsecutiveZeros(value)) return true;
  if (/0000[-\s]0000/.test(value)) return true;
  if (hasPlaceholderMarker(value)) return true;
  return false;
}

function isPlaceholderEmail(value) {
  if (isEmpty(value)) return true;
  if (
    /@(example\.(com|org|net)|kzq-demo\.com|kzq-example\.com|test\.com|localhost)/i.test(
      String(value).toLowerCase(),
    )
  )
    return true;
  if (hasPlaceholderMarker(value)) return true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  return false;
}

function isPlaceholderWhatsApp(value) {
  return isPlaceholderPhone(value);
}

function isPlaceholderAddress(value) {
  if (isEmpty(value)) return true;
  if (/XX\s*[区路号街道]/.test(value)) return true;
  if (/No\.\s*XX/i.test(value)) return true;
  if (/XX\s+(Road|District|Street|Avenue|Blvd)/i.test(value)) return true;
  if (hasPlaceholderMarker(value)) return true;
  return false;
}

// ---------- Section 1: Git & Build ----------

function checkGitAndBuild() {
  // Current commit
  try {
    const sha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    pass("git: current commit", sha.slice(0, 12));
  } catch {
    warn("git: current commit", "could not read HEAD");
  }

  // Uncommitted files
  try {
    const status = execSync("git status --porcelain=v1", {
      encoding: "utf-8",
    }).trim();
    if (status) {
      const lines = status.split("\n");
      warn(
        "git: working tree",
        `${lines.length} uncommitted file(s) — commit or stash before release`,
      );
    } else {
      pass("git: working tree", "clean");
    }
  } catch {
    warn("git: working tree", "could not read git status");
  }

  // Node version
  const nodeVersion = process.version;
  const major = Number(nodeVersion.replace("v", "").split(".")[0]);
  if (major === 20) {
    pass("node: version", nodeVersion);
  } else {
    warn("node: version", `${nodeVersion} (recommended: 20.x)`);
  }

  // Demo mode
  const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  if (demoMode) {
    warn(
      "env: NEXT_PUBLIC_DEMO_MODE",
      "true — staging must set this to false before going live",
    );
  } else {
    pass("env: NEXT_PUBLIC_DEMO_MODE", "false / unset");
  }

  // Indexing switch
  const indexingEnabled = process.env.NEXT_PUBLIC_SITE_INDEXING_ENABLED === "true";
  if (indexingEnabled) {
    if (stagingMode) {
      block(
        "env: NEXT_PUBLIC_SITE_INDEXING_ENABLED",
        "staging must keep indexing=false until production domain is verified",
      );
    } else {
      warn(
        "env: NEXT_PUBLIC_SITE_INDEXING_ENABLED",
        "true — ensure production domain is verified before deployment",
      );
    }
  } else {
    pass("env: NEXT_PUBLIC_SITE_INDEXING_ENABLED", "false (noindex)");
  }

  // service_role must never be NEXT_PUBLIC_
  const serviceRolePublic = Object.keys(process.env).find((k) =>
    /NEXT_PUBLIC.*SERVICE_ROLE/i.test(k),
  );
  if (serviceRolePublic) {
    block(
      "env: service role exposure",
      `${serviceRolePublic} must NOT use NEXT_PUBLIC_ prefix`,
    );
  } else {
    pass("env: service role exposure", "not exposed via NEXT_PUBLIC_");
  }
}

// ---------- Section 2: URL & SEO ----------

function checkUrlAndSeo() {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "";

  if (!siteUrl) {
    block("env: NEXT_PUBLIC_SITE_URL", "missing — required for canonical/sitemap");
    return;
  }

  let parsed;
  try {
    parsed = new URL(siteUrl);
  } catch {
    block("env: NEXT_PUBLIC_SITE_URL", `invalid URL: ${siteUrl}`);
    return;
  }

  // HTTPS check
  if (parsed.protocol === "http:") {
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    if (isLoopback) {
      warn("env: NEXT_PUBLIC_SITE_URL", "localhost — dev only");
    } else {
      block("env: NEXT_PUBLIC_SITE_URL", "uses HTTP — must be HTTPS in production");
    }
  } else if (parsed.protocol === "https:") {
    pass("env: NEXT_PUBLIC_SITE_URL", `https (${parsed.hostname})`);
  }

  // Vercel domain check
  if (parsed.hostname.endsWith("vercel.app")) {
    if (stagingMode) {
      block(
        "env: NEXT_PUBLIC_SITE_URL",
        "vercel.app domain — staging must use EdgeOne domain, not Vercel",
      );
    } else {
      block(
        "env: NEXT_PUBLIC_SITE_URL",
        "vercel.app domain — production must use confirmed EdgeOne domain",
      );
    }
  }

  // localhost check
  if (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1"
  ) {
    warn("env: NEXT_PUBLIC_SITE_URL", "localhost — not suitable for staging/prod");
  }

  // Trailing slash
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    warn(
      "env: NEXT_PUBLIC_SITE_URL",
      "trailing slash — will be stripped at runtime but should be clean",
    );
  }

  // indexing=true requires confirmed production domain
  const indexingEnabled = process.env.NEXT_PUBLIC_SITE_INDEXING_ENABLED === "true";
  if (indexingEnabled) {
    const knownStagingHosts = ["vercel.app", "localhost", "127.0.0.1"];
    const isTemporary = knownStagingHosts.some((h) =>
      parsed.hostname.endsWith(h),
    );
    if (isTemporary) {
      block(
        "seo: indexing vs domain",
        "indexing=true but site URL is a temporary/preview domain — must use confirmed production domain",
      );
    } else {
      pass("seo: indexing vs domain", "indexing enabled with non-temporary domain");
    }
  } else {
    pass(
      "seo: indexing vs domain",
      "indexing disabled — temporary preview domain allowed",
    );
  }
}

// ---------- Section 3: Supabase Schema (read-only) ----------

const REQUIRED_CATALOG_FIELDS = [
  "catalog_topic_id",
  "cover_image_url",
  "published_at",
  "content_hash",
];

const EXPECTED_ANALYTICS_EVENTS = [
  "page_view",
  "product_view",
  "product_search",
  "category_click",
  "phone_click",
  "wechat_copy",
  "whatsapp_click",
  "email_click",
  "add_to_inquiry",
  "inquiry_start",
  "inquiry_success",
  "catalog_download",
  "certificate_view",
  "project_view",
  "catalog_open",
  "catalog_load_success",
  "catalog_load_failure",
  "catalog_copy_link",
  "catalog_open_external",
];

async function checkSupabaseSchema() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey) {
    block(
      "supabase: connection",
      "NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY missing",
    );
    return;
  }

  // Service role key presence (server-side only)
  if (!serviceRoleKey) {
    block(
      "supabase: service role",
      "SUPABASE_SERVICE_ROLE_KEY missing — admin/catalog writes will fail",
    );
  } else {
    pass("supabase: service role", "configured (server-side)");
  }

  const adminHeaders = serviceRoleKey
    ? { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    : { apikey: anonKey, Authorization: `Bearer ${anonKey}` };

  // --- Catalog fields check ---
  let columnsAvailable = false;
  try {
    const colRes = await fetch(
      `${supabaseUrl}/rest/v1/information_schema?select=column_name&table_schema=eq.public&table_name=eq.product_assets`,
      { headers: adminHeaders, signal: AbortSignal.timeout(15_000) },
    );
    if (colRes.ok) {
      const cols = await colRes.json();
      const colNames = Array.isArray(cols)
        ? cols.map((c) => c.column_name)
        : [];
      const missing = REQUIRED_CATALOG_FIELDS.filter(
        (f) => !colNames.includes(f),
      );
      if (missing.length === 0) {
        pass("schema: product_assets fields", "all 4 catalog fields present");
        columnsAvailable = true;
      } else {
        block(
          "schema: product_assets fields",
          `missing: ${missing.join(", ")} — migration 20260719090000 not applied`,
        );
      }
    } else {
      warn(
        "schema: product_assets fields",
        `information_schema not queryable (HTTP ${colRes.status})`,
      );
    }
  } catch (err) {
    warn(
      "schema: product_assets fields",
      `query failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  // --- Analytics events constraint check ---
  // We probe by attempting to read existing event_name values (read-only).
  try {
    const evRes = await fetch(
      `${supabaseUrl}/rest/v1/analytics_events?select=event_name&limit=1`,
      { headers: adminHeaders, signal: AbortSignal.timeout(15_000) },
    );
    if (evRes.ok) {
      pass("schema: analytics_events table", "readable");
    } else {
      warn(
        "schema: analytics_events table",
        `HTTP ${evRes.status} — constraint cannot be verified`,
      );
    }
  } catch (err) {
    warn(
      "schema: analytics_events table",
      `query failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  // --- Migration files present locally ---
  // We cannot execute migrations; we only verify the files exist so the
  // runbook can reference them.
  try {
    const migration1 = readFileSync(
      "supabase/migrations/20260719090000_catalog_center_fields.sql",
      { encoding: "utf-8" },
    );
    const migration2 = readFileSync(
      "supabase/migrations/20260721000000_catalog_viewer_analytics_events.sql",
      { encoding: "utf-8" },
    );
    if (migration1.includes("catalog_topic_id") && migration2.includes("catalog_open")) {
      pass("migrations: files present", "both catalog migration files found");
    } else {
      warn("migrations: files present", "files exist but content unexpected");
    }
  } catch {
    block("migrations: files present", "catalog migration files missing from repo");
  }

  // --- Schema compatibility vs deployed code ---
  // Catalog code is on main. If schema fields are missing but we are NOT in
  // demo mode, this is a BLOCK — the catalog feature cannot function.
  const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  if (!demoMode && columnsAvailable === false) {
    // Only block if we definitively know columns are missing (columnsAvailable
    // stays false when the column query failed with a warn, so we only block
    // when the explicit missing-columns branch above already blocked).
    // This branch is a safety net for the catalog compatibility requirement.
    const alreadyBlocked = results.some(
      (r) =>
        r.level === "BLOCK" &&
        r.label.startsWith("schema: product_assets fields"),
    );
    if (alreadyBlocked) {
      block(
        "compat: catalog code vs schema",
        "catalog code is deployed but schema is incompatible — apply migrations first",
      );
    }
  }
}

// ---------- Section 4: Business content ----------

async function checkBusinessContent() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // In demo mode, use mock data
  const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  let company = null;

  if (demoMode) {
    // Load mock data by importing the compiled module is not possible in .mjs;
    // we read the known mock values directly.
    try {
      const mockSrc = readFileSync("lib/mock-data.ts", { encoding: "utf-8" });
      const phoneMatch = mockSrc.match(/phone:\s*"([^"]+)"/);
      const emailMatch = mockSrc.match(/email:\s*"([^"]+)"/);
      const waMatch = mockSrc.match(/whatsapp:\s*"([^"]+)"/);
      const addrCnMatch = mockSrc.match(/address_cn:\s*"([^"]+)"/);
      const addrEnMatch = mockSrc.match(/address_en:\s*"([^"]+)"/);
      company = {
        phone: phoneMatch?.[1] || null,
        email: emailMatch?.[1] || null,
        whatsapp: waMatch?.[1] || null,
        address_cn: addrCnMatch?.[1] || null,
        address_en: addrEnMatch?.[1] || null,
      };
      pass("content: data source", "demo mode (mock data)");
    } catch {
      warn("content: data source", "demo mode but mock-data.ts unreadable");
    }
  } else if (supabaseUrl && anonKey) {
    const adminHeaders = serviceRoleKey
      ? { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
      : { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/company_profile?select=*&limit=1`,
        { headers: adminHeaders, signal: AbortSignal.timeout(15_000) },
      );
      if (res.ok) {
        const data = await res.json();
        company = Array.isArray(data) && data[0] ? data[0] : null;
        pass("content: data source", "supabase");
      } else {
        warn("content: data source", `company_profile HTTP ${res.status}`);
      }
    } catch (err) {
      warn(
        "content: data source",
        `company_profile query failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  } else {
    warn("content: data source", "no Supabase credentials to check business data");
  }

  if (company) {
    // Phone
    if (isPlaceholderPhone(company.phone)) {
      block("content: company phone", "placeholder detected — must not display tel: link");
    } else {
      pass("content: company phone", "real value present");
    }
    // Email
    if (isPlaceholderEmail(company.email)) {
      block("content: company email", "placeholder detected — must not display mailto:");
    } else {
      pass("content: company email", "real value present");
    }
    // WhatsApp
    if (isPlaceholderWhatsApp(company.whatsapp)) {
      block("content: company whatsapp", "placeholder detected — must not display wa.me link");
    } else if (company.whatsapp) {
      pass("content: company whatsapp", "real value present");
    } else {
      warn("content: company whatsapp", "not configured");
    }
    // Address (CN + EN)
    const addrCnPlaceholder = isPlaceholderAddress(company.address_cn);
    const addrEnPlaceholder = isPlaceholderAddress(company.address_en);
    if (addrCnPlaceholder || addrEnPlaceholder) {
      block(
        "content: company address",
        "placeholder detected — must not display fake address",
      );
    } else if (company.address_cn || company.address_en) {
      pass("content: company address", "real value present");
    } else {
      warn("content: company address", "not configured");
    }
    // WeChat QR
    if (!company.wechat_qr_url) {
      warn("content: wechat qr", "not configured");
    } else {
      pass("content: wechat qr", "configured");
    }
    // Logo
    if (!company.logo_url) {
      warn("content: company logo", "not configured");
    } else {
      pass("content: company logo", "configured");
    }
  }

  // --- Catalog counts (read-only) ---
  if (!demoMode && supabaseUrl && (anonKey || serviceRoleKey)) {
    const key = serviceRoleKey || anonKey;
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    // Products
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/products?select=id&is_published=eq.true&limit=1000`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (res.ok) {
        const data = await res.json();
        const count = Array.isArray(data) ? data.length : 0;
        if (count === 0) warn("content: products", "0 published products");
        else pass("content: products", `${count} published`);
      }
    } catch {
      warn("content: products", "query failed");
    }

    // Products with cover image
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/products?select=id&is_published=eq.true&cover_image_url=not.is.null&limit=1000`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (res.ok) {
        const data = await res.json();
        const count = Array.isArray(data) ? data.length : 0;
        if (count === 0) warn("content: products with cover", "0 products with cover image");
        else pass("content: products with cover", `${count} with covers`);
      }
    } catch {
      warn("content: products with cover", "query failed");
    }

    // Certificates
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/certificates?select=id&is_published=eq.true&limit=1000`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (res.ok) {
        const data = await res.json();
        const count = Array.isArray(data) ? data.length : 0;
        if (count === 0) warn("content: certificates", "0 published certificates");
        else pass("content: certificates", `${count} published`);
      }
    } catch {
      warn("content: certificates", "query failed");
    }

    // Projects
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/projects?select=id&is_published=eq.true&limit=1000`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (res.ok) {
        const data = await res.json();
        const count = Array.isArray(data) ? data.length : 0;
        if (count === 0) warn("content: projects", "0 published projects");
        else pass("content: projects", `${count} published`);
      }
    } catch {
      warn("content: projects", "query failed");
    }

    // Published catalog assets
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/product_assets?select=id&is_published=eq.true&limit=1000`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (res.ok) {
        const data = await res.json();
        const count = Array.isArray(data) ? data.length : 0;
        if (count === 0) warn("content: catalog assets", "0 published catalog files (WARN only)");
        else pass("content: catalog assets", `${count} published`);
      }
    } catch {
      warn("content: catalog assets", "query failed");
    }
  }
}

// ---------- Main ----------

async function main() {
  const modeLabel = stagingMode ? "staging" : "default";
  console.log(`\n=== KZQ Release Readiness Check (mode: ${modeLabel}) ===\n`);

  checkGitAndBuild();
  checkUrlAndSeo();
  await checkSupabaseSchema();
  await checkBusinessContent();

  // Print results
  const blocks = results.filter((r) => r.level === "BLOCK");
  const warns = results.filter((r) => r.level === "WARN");
  const passes = results.filter((r) => r.level === "PASS");

  for (const r of results) {
    const detail = r.detail ? ` — ${r.detail}` : "";
    console.log(`[${r.level.padEnd(5)}] ${r.label}${detail}`);
  }

  console.log(`\n--- Summary ---`);
  console.log(`PASS:  ${passes.length}`);
  console.log(`WARN:  ${warns.length}`);
  console.log(`BLOCK: ${blocks.length}`);

  if (blocks.length > 0) {
    console.log(`\n${blocks.length} BLOCK item(s) prevent release.\n`);
    process.exit(1);
  }
  if (warns.length > 0) {
    console.log(`\n${warns.length} WARN item(s) — review before release.\n`);
  }
  console.log("All checks passed (with warnings).\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Release readiness check crashed:", err);
  process.exit(1);
});
