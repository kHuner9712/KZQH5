import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey);
const writeRequested = process.env.SMOKE_TEST_ALLOW_WRITES === "true";
const stagingConfirmed =
  process.env.KZQ_STAGING_CONFIRMATION === "KZQ-STAGING-ONLY";

if (writeRequested && (!configured || !serviceKey || !stagingConfirmed)) {
  throw new Error(
    "Write smoke refused: public Supabase variables, SUPABASE_SERVICE_ROLE_KEY, and KZQ_STAGING_CONFIRMATION=KZQ-STAGING-ONLY are required",
  );
}

const options = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
} as const;

const anon = configured
  ? createClient<Database>(url!, anonKey!, options)
  : null;
const service = writeRequested
  ? createClient<Database>(url!, serviceKey!, options)
  : null;

function expectSuccess(result: { error: unknown }, label: string) {
  expect(result.error, label).toBeNull();
}

describe.skipIf(!configured)("real environment read-only smoke", () => {
  it("connects and reads every published public resource", async () => {
    const results = await Promise.all([
      anon!
        .from("products")
        .select("id, slug")
        .eq("is_published", true)
        .limit(1),
      anon!
        .from("categories")
        .select("id, slug")
        .eq("is_active", true)
        .limit(1),
      anon!
        .from("subcategories")
        .select("id, slug")
        .eq("is_active", true)
        .limit(1),
      anon!.from("certificates").select("id").eq("is_published", true).limit(1),
      anon!
        .from("projects")
        .select("id, slug")
        .eq("is_published", true)
        .limit(1),
      anon!
        .from("product_assets")
        .select("id")
        .eq("is_published", true)
        .limit(1),
    ]);
    const labels = [
      "products",
      "categories",
      "subcategories",
      "certificates",
      "projects",
      "product_assets",
    ];
    results.forEach((result, index) => expectSuccess(result, labels[index]));
  });

  it("calls the public product search RPC", async () => {
    const result = await anon!.rpc("search_published_products", {
      p_query: null,
      p_category_id: null,
      p_subcategory_id: null,
      p_offset: 0,
      p_limit: 1,
    });
    expectSuccess(result, "search_published_products");
  });

  it("does not expose unpublished content to anon", async () => {
    const results = await Promise.all([
      anon!.from("products").select("id").eq("is_published", false).limit(1),
      anon!
        .from("certificates")
        .select("id")
        .eq("is_published", false)
        .limit(1),
      anon!.from("projects").select("id").eq("is_published", false).limit(1),
      anon!
        .from("product_assets")
        .select("id")
        .eq("is_published", false)
        .limit(1),
    ]);
    for (const result of results) {
      expectSuccess(result, "unpublished RLS read");
      expect(result.data).toEqual([]);
    }
  });

  it("denies anon inquiry reads, analytics writes, and inquiry RPC writes", async () => {
    const marker = `[REGRESSION TEST] ${crypto.randomUUID()}`;
    const [inquiryRead, analyticsWrite, inquiryRpc] = await Promise.all([
      anon!.from("inquiries").select("id").limit(1),
      anon!
        .from("analytics_events")
        .insert({
          event_name: "page_view",
          locale: "zh",
          page_path: `/${marker}`,
          product_id: null,
          project_id: null,
          source: marker,
          channel: null,
          utm_source: null,
          utm_medium: null,
          utm_campaign: null,
          referrer: null,
        })
        .rollback(),
      anon!
        .rpc("create_inquiry_with_items", {
          p_inquiry: { name: marker, interested_product: marker },
          p_items: [],
        })
        .rollback(),
    ]);
    expect(inquiryRead.data || []).toEqual([]);
    expect(analyticsWrite.error).not.toBeNull();
    expect(inquiryRpc.error).not.toBeNull();
  });
});

async function createMarkedInquiry(
  client: SupabaseClient<Database>,
  marker: string,
  language: "zh" | "en",
  productId: string,
) {
  return client.rpc("create_inquiry_with_items", {
    p_inquiry: {
      name: `${marker} ${language}`,
      phone: language === "zh" ? "13800000000" : null,
      email: language === "en" ? "regression@example.invalid" : null,
      interested_product: marker,
      message: marker,
      language,
      source: `${marker} smoke`,
      channel: "staging-smoke",
      page_url: `https://staging.invalid/${language}?marker=${encodeURIComponent(marker)}`,
      utm_source: `${marker} source`,
      utm_medium: "automated-smoke",
      utm_campaign: marker,
    },
    p_items: [{ product_id: productId, quantity: `${marker} quantity` }],
  });
}

describe.skipIf(!writeRequested)(
  "real environment explicitly enabled write smoke",
  () => {
    it("validates bilingual atomic inquiries, analytics, rejection, and exact cleanup", async () => {
      const marker = `[REGRESSION TEST] ${crypto.randomUUID()}`;
      const inquiryIds: string[] = [];
      const analyticsIds: string[] = [];
      const unpublishedProductId = crypto.randomUUID();

      try {
        const published = await service!
          .from("products")
          .select("id")
          .eq("is_published", true)
          .limit(1)
          .single();
        expectSuccess(published, "published product fixture");
        expect(published.data?.id).toBeTruthy();
        const productId = published.data!.id;

        for (const locale of ["zh", "en"] as const) {
          const created = await createMarkedInquiry(
            service!,
            marker,
            locale,
            productId,
          );
          expectSuccess(created, `${locale} inquiry RPC`);
          const inquiry = created.data as { id?: string } | null;
          expect(inquiry?.id).toBeTruthy();
          inquiryIds.push(inquiry!.id!);

          const stored = await service!
            .from("inquiries")
            .select(
              "id, language, source, utm_source, utm_medium, utm_campaign, inquiry_items(id, quantity)",
            )
            .eq("id", inquiry!.id!)
            .eq("name", `${marker} ${locale}`)
            .single();
          expectSuccess(stored, `${locale} stored inquiry`);
          expect(stored.data).toMatchObject({
            language: locale,
            source: `${marker} smoke`,
            utm_source: `${marker} source`,
            utm_medium: "automated-smoke",
            utm_campaign: marker,
          });
          const storedItems = (
            stored.data as unknown as {
              inquiry_items: Array<{ id: string; quantity: string | null }>;
            }
          ).inquiry_items;
          expect(storedItems).toHaveLength(1);
          expect(storedItems[0].quantity).toContain(marker);
        }

        const analytics = await service!
          .from("analytics_events")
          .insert({
            event_name: "inquiry_success",
            locale: "en",
            page_path: `/staging-smoke/${encodeURIComponent(marker)}`,
            product_id: productId,
            project_id: null,
            source: marker,
            channel: "staging-smoke",
            utm_source: marker,
            utm_medium: "automated-smoke",
            utm_campaign: marker,
            referrer: null,
          })
          .select("id")
          .single();
        expectSuccess(analytics, "analytics insert");
        analyticsIds.push(analytics.data!.id);

        const category = await service!
          .from("categories")
          .select("id")
          .limit(1)
          .single();
        expectSuccess(category, "category fixture");
        const unpublished = await service!
          .from("products")
          .insert({
            id: unpublishedProductId,
            category_id: category.data!.id,
            name_cn: marker,
            name_en: marker,
            slug: `regression-${unpublishedProductId}`,
            is_published: false,
            is_featured: false,
            sort_order: 0,
          })
          .select("id")
          .single();
        expectSuccess(unpublished, "unpublished product fixture");

        const inquiryCountBefore = await service!
          .from("inquiries")
          .select("id", { count: "exact", head: true })
          .like("name", `${marker}%`);
        expectSuccess(inquiryCountBefore, "atomic count before rejection");

        const rejectedUnpublished = await createMarkedInquiry(
          service!,
          marker,
          "en",
          unpublishedProductId,
        );
        expect(rejectedUnpublished.error).not.toBeNull();

        const rejectedMissing = await createMarkedInquiry(
          service!,
          marker,
          "en",
          crypto.randomUUID(),
        );
        expect(rejectedMissing.error).not.toBeNull();

        const inquiryCountAfter = await service!
          .from("inquiries")
          .select("id", { count: "exact", head: true })
          .like("name", `${marker}%`);
        expectSuccess(inquiryCountAfter, "atomic count after rejection");
        expect(inquiryCountAfter.count).toBe(inquiryCountBefore.count);
      } finally {
        for (const analyticsId of analyticsIds) {
          await service!
            .from("analytics_events")
            .delete()
            .eq("id", analyticsId)
            .eq("page_path", `/staging-smoke/${encodeURIComponent(marker)}`);
        }
        for (const inquiryId of inquiryIds) {
          await service!
            .from("inquiry_items")
            .delete()
            .eq("inquiry_id", inquiryId)
            .like("quantity", `${marker}%`);
          await service!
            .from("inquiries")
            .delete()
            .eq("id", inquiryId)
            .like("name", `${marker}%`);
        }
        await service!
          .from("products")
          .delete()
          .eq("id", unpublishedProductId)
          .eq("name_cn", marker)
          .eq("is_published", false);
      }
    });
  },
);
