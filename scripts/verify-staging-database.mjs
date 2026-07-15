import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
await check("anon inquiry read denied", async () => {
  const { data, error } = await client.from("inquiries").select("id").limit(1);
  return !error && Array.isArray(data) && data.length === 0;
});
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
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}`);
}
if (checks.some((result) => !result.ok)) process.exit(1);
console.log("Non-destructive Staging database verification completed.");
