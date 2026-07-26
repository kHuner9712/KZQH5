// ============================================================
// KZQ Release Readiness Check (read-only)
//
// Performs read-only pre-deployment checks across:
//   1. Git & build state
//   2. URL & SEO configuration
//   3. Supabase schema (via verify_schema_readiness() RPC)
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
//
// Phase 7 hardening:
//   - Schema compatibility is verified via the service_role-only RPC
//     `verify_schema_readiness()` (migration 20260724160000) instead of
//     probing /rest/v1/information_schema. The RPC performs all checks
//     server-side and returns a structured { ok, checks[] } result.
//   - When the RPC is missing, unreachable, or returns a malformed
//     payload, the script BLOCKs (schema cannot be confirmed) rather
//     than silently passing.
//   - The service role key, Authorization header, and full error
//     objects are NEVER printed. Only fixed error codes + coarse cause.
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

// ---------- Section 3: Supabase Schema (read-only, via RPC) ----------
//
// Phase 7: schema compatibility is verified by calling the service_role-only
// RPC `verify_schema_readiness()` (migration 20260724160000). The RPC checks
// server-side that:
//   - product_assets has the 4 catalog fields
//   - the 2 catalog indexes exist
//   - analytics_events has the 19-event check constraint
//   - count_unread_inquiries(), get_admin_dashboard_snapshot(),
//     create_inquiry_with_items() exist
//   - the critical RPCs are NOT granted to anon/authenticated
//
// The script NEVER falls back to direct information_schema probing. If the
// RPC is missing, unreachable, or returns a malformed payload, we BLOCK
// because schema compatibility cannot be confirmed.
//
// Error handling contract:
//   - The service role key, Authorization header, and full error objects are
//     never printed. We only emit fixed error codes + a coarse cause.
//   - Network failures are classified as BLOCK (schema unverified), not WARN,
//     because we cannot claim readiness without confirming the schema.

// Expected check names returned by verify_schema_readiness(). We track these
// explicitly so a future RPC change that drops a check is detected.
const EXPECTED_SCHEMA_CHECKS = [
  "catalog_field_catalog_topic_id",
  "catalog_field_cover_image_url",
  "catalog_field_published_at",
  "catalog_field_content_hash",
  "index_product_assets_catalog_topic_idx",
  "index_product_assets_content_hash_idx",
  "analytics_events_constraint",
  "rpc_count_unread_inquiries",
  "rpc_get_admin_dashboard_snapshot",
  "rpc_create_inquiry_with_items",
  "grant_count_unread_inquiries",
  "grant_get_admin_dashboard_snapshot",
  "grant_create_inquiry_with_items",
  "grant_save_product_with_images",
  "grant_save_project_with_relations",
];

/**
 * Classifies a fetch failure into a coarse cause string without leaking the
 * URL (which may contain the apikey as a query param) or the error message
 * (which may contain the response body).
 */
function classifyFetchFailure(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return "SCHEMA_RPC_TIMEOUT";
  }
  // Network errors (ECONNREFUSED, ENOTFOUND, ECONNRESET, etc.)
  if (err?.code && typeof err.code === "string" && err.code.startsWith("E")) {
    return "SCHEMA_RPC_NETWORK";
  }
  return "SCHEMA_RPC_UNKNOWN";
}

/**
 * Calls verify_schema_readiness() via PostgREST and returns the parsed
 * result, or throws a classified error.
 *
 * Returns: { ok: boolean, checks: Array<{ name, passed, detail }> }
 */
async function callSchemaVerificationRpc(supabaseUrl, serviceRoleKey) {
  const rpcUrl = `${supabaseUrl}/rest/v1/rpc/verify_schema_readiness`;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });

  // 404 = RPC not deployed (migration 20260724160000 not applied)
  if (res.status === 404) {
    const err = new Error("SCHEMA_RPC_NOT_FOUND");
    err.code = "SCHEMA_RPC_NOT_FOUND";
    throw err;
  }
  // 401/403 = service role key invalid or RPC granted to wrong role
  if (res.status === 401 || res.status === 403) {
    const err = new Error("SCHEMA_RPC_FORBIDDEN");
    err.code = "SCHEMA_RPC_FORBIDDEN";
    throw err;
  }
  if (!res.ok) {
    const err = new Error("SCHEMA_RPC_HTTP_ERROR");
    err.code = "SCHEMA_RPC_HTTP_ERROR";
    err.httpStatus = res.status;
    throw err;
  }

  const body = await res.json();
  return body;
}

/**
 * Validates the RPC response shape. Returns the checks array if valid,
 * otherwise throws with code SCHEMA_RPC_MALFORMED.
 */
function validateRpcResponse(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    const err = new Error("SCHEMA_RPC_MALFORMED");
    err.code = "SCHEMA_RPC_MALFORMED";
    throw err;
  }
  const ok = body.ok;
  const checks = body.checks;
  if (typeof ok !== "boolean") {
    const err = new Error("SCHEMA_RPC_MALFORMED");
    err.code = "SCHEMA_RPC_MALFORMED";
    throw err;
  }
  if (!Array.isArray(checks)) {
    const err = new Error("SCHEMA_RPC_MALFORMED");
    err.code = "SCHEMA_RPC_MALFORMED";
    throw err;
  }
  // Each check must be { name: string, passed: boolean, detail: string }
  for (const c of checks) {
    if (
      !c ||
      typeof c !== "object" ||
      typeof c.name !== "string" ||
      typeof c.passed !== "boolean" ||
      typeof c.detail !== "string"
    ) {
      const err = new Error("SCHEMA_RPC_MALFORMED");
      err.code = "SCHEMA_RPC_MALFORMED";
      throw err;
    }
  }
  return checks;
}

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

  // Service role key presence (server-side only). The schema verification
  // RPC is service_role-only, so without it we cannot confirm schema
  // compatibility — that is a BLOCK, not a WARN.
  if (!serviceRoleKey) {
    block(
      "supabase: service role",
      "SUPABASE_SERVICE_ROLE_KEY missing — schema verification RPC cannot be called",
    );
    // No point continuing; the RPC call would 403.
    return;
  } else {
    pass("supabase: service role", "configured (server-side)");
  }

  // --- Migration files present locally ---
  // We cannot execute migrations; we only verify the files exist so the
  // runbook can reference them. This is a repo-state check, not a schema
  // check.
  try {
    const migration1 = readFileSync(
      "supabase/migrations/20260719090000_catalog_center_fields.sql",
      { encoding: "utf-8" },
    );
    const migration2 = readFileSync(
      "supabase/migrations/20260721000000_catalog_viewer_analytics_events.sql",
      { encoding: "utf-8" },
    );
    const migration7 = readFileSync(
      "supabase/migrations/20260724160000_schema_verification_rpc.sql",
      { encoding: "utf-8" },
    );
    if (
      migration1.includes("catalog_topic_id") &&
      migration2.includes("catalog_open") &&
      migration7.includes("verify_schema_readiness")
    ) {
      pass("migrations: files present", "catalog + schema-verification migration files found");
    } else {
      warn("migrations: files present", "files exist but content unexpected");
    }
  } catch {
    block("migrations: files present", "required migration files missing from repo");
  }

  // --- Schema verification via RPC ---
  let rpcChecks = null;
  try {
    const body = await callSchemaVerificationRpc(supabaseUrl, serviceRoleKey);
    rpcChecks = validateRpcResponse(body);
    pass("schema: verification RPC", `reachable, ${rpcChecks.length} checks returned`);
  } catch (err) {
    const code = err?.code || classifyFetchFailure(err);
    if (code === "SCHEMA_RPC_NOT_FOUND") {
      block(
        "schema: verification RPC",
        "SCHEMA_RPC_NOT_FOUND — migration 20260724160000 not applied",
      );
    } else if (code === "SCHEMA_RPC_FORBIDDEN") {
      block(
        "schema: verification RPC",
        "SCHEMA_RPC_FORBIDDEN — service role key invalid or RPC mis-granted",
      );
    } else if (code === "SCHEMA_RPC_TIMEOUT") {
      block(
        "schema: verification RPC",
        "SCHEMA_RPC_TIMEOUT — Supabase unreachable within 20s",
      );
    } else if (code === "SCHEMA_RPC_NETWORK") {
      block(
        "schema: verification RPC",
        "SCHEMA_RPC_NETWORK — cannot reach Supabase (network error)",
      );
    } else if (code === "SCHEMA_RPC_MALFORMED") {
      block(
        "schema: verification RPC",
        "SCHEMA_RPC_MALFORMED — RPC returned unexpected shape",
      );
    } else if (code === "SCHEMA_RPC_HTTP_ERROR") {
      block(
        "schema: verification RPC",
        `SCHEMA_RPC_HTTP_ERROR — HTTP ${err?.httpStatus || "?"} (check Supabase logs)`,
      );
    } else {
      block(
        "schema: verification RPC",
        "SCHEMA_RPC_UNKNOWN — unclassified failure",
      );
    }
    // Schema cannot be confirmed — we already BLOCKed above. The catalog
    // compatibility safety net below is intentionally skipped because the
    // RPC failure is the authoritative signal.
    return;
  }

  // --- Emit PASS/BLOCK for each RPC check ---
  const seenCheckNames = new Set();
  for (const c of rpcChecks) {
    seenCheckNames.add(c.name);
    if (c.passed) {
      pass(`schema: ${c.name}`, c.detail || "passed");
    } else {
      block(`schema: ${c.name}`, c.detail || "failed");
    }
  }

  // --- Detect missing checks (RPC returned fewer checks than expected) ---
  // This guards against a future RPC change that silently drops a check.
  for (const expected of EXPECTED_SCHEMA_CHECKS) {
    if (!seenCheckNames.has(expected)) {
      block(
        `schema: ${expected}`,
        "check not returned by RPC — verify migration 20260724160000 is current",
      );
    }
  }

  // --- Top-level ok flag ---
  // We re-derive ok from the checks array rather than trusting body.ok, so a
  // buggy RPC that returns ok=true with a failed check is still caught.
  const anyFailed = rpcChecks.some((c) => !c.passed);
  if (anyFailed) {
    block(
      "schema: overall",
      "one or more schema checks failed — review individual BLOCK items above",
    );
  } else {
    pass("schema: overall", "all schema checks passed");
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
