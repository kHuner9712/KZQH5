import { createClient } from "@supabase/supabase-js";
import { classifyProtectedReadResult } from "./lib/protected-read-verification.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (process.env.KZQ_STAGING_CONFIRMATION !== "KZQ-STAGING-ONLY") {
  throw new Error(
    "Remote verification refused: set KZQ_STAGING_CONFIRMATION=KZQ-STAGING-ONLY",
  );
}
if (!url || !anonKey) {
  throw new Error("Staging Supabase URL and anon key are required");
}

const client = createClient(url, anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
const service = serviceKey
  ? createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  : null;
const marker = `[REGRESSION TEST] ${crypto.randomUUID()}`;
const checks = [];

async function check(name, operation) {
  try {
    const ok = await operation();
    checks.push({ name, ok });
  } catch {
    checks.push({ name, ok: false });
  }
}

for (const [table, column, value] of [
  ["products", "is_published", true],
  ["categories", "is_active", true],
  ["subcategories", "is_active", true],
  ["certificates", "is_published", true],
  ["projects", "is_published", true],
  ["product_assets", "is_published", true],
]) {
  await check(`anon read ${table}`, async () => {
    const { error } = await client
      .from(table)
      .select("id")
      .eq(column, value)
      .limit(1);
    return !error;
  });
}

await check("search_published_products RPC", async () => {
  const { error } = await client.rpc("search_published_products", {
    p_query: null,
    p_category_id: null,
    p_subcategory_id: null,
    p_offset: 0,
    p_limit: 1,
  });
  return !error;
});
try {
  const { data, error } = await client.from("inquiries").select("id").limit(1);
  checks.push({
    name: "anon inquiry read denied",
    ...classifyProtectedReadResult({ data, error }),
  });
} catch {
  checks.push({
    name: "anon inquiry read denied",
    ok: false,
    mode: "unexpected-error",
  });
}
await check("anon analytics write denied", async () => {
  const { error } = await client
    .from("analytics_events")
    .insert({
      event_name: "page_view",
      locale: "zh",
      page_path: `/${marker}`,
      source: marker,
    })
    .rollback();
  return Boolean(error);
});
await check("anon inquiry RPC denied", async () => {
  const { error } = await client
    .rpc("create_inquiry_with_items", {
      p_inquiry: { name: marker, interested_product: marker },
      p_items: [],
    })
    .rollback();
  return Boolean(error);
});

for (const result of checks) {
  const mode = result.mode ? ` mode=${result.mode}` : "";
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${mode}`);
}
let hasFailure = checks.some((result) => !result.ok);

if (service) {
  const countChecks = [
    ["products", "products", null],
    ["products.published", "products", ["is_published", true]],
    ["categories", "categories", null],
    ["subcategories", "subcategories", null],
    ["certificates", "certificates", null],
    ["inquiries", "inquiries", null],
    ["inquiries.unread", "inquiries", ["is_read", false]],
    ["projects", "projects", null],
    ["product_assets", "product_assets", null],
    ["admin_profiles", "admin_profiles", null],
  ];

  for (const [label, table, filter] of countChecks) {
    let query = service.from(table).select("id", { count: "exact" }).limit(1);
    if (filter) query = query.eq(filter[0], filter[1]);
    const { count, error } = await query;
    if (error || count === null) {
      console.log(`FAIL count ${label}`);
      hasFailure = true;
      continue;
    }
    console.log(`COUNT ${label}=${count}`);
  }

  const regression = await service
    .from("inquiries")
    .select("id", { count: "exact" })
    .or("name.ilike.%[REGRESSION TEST]%,message.ilike.%[REGRESSION TEST]%")
    .limit(1);
  if (regression.error || regression.count === null) {
    console.log("FAIL count inquiries.regression_test");
    hasFailure = true;
  } else {
    console.log(`COUNT inquiries.regression_test=${regression.count}`);
  }
} else {
  console.log("SKIP privileged count summary (service role missing)");
}
console.log("Non-destructive Staging database verification completed.");
if (hasFailure) process.exitCode = 1;
