import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey);
const anon = configured
  ? createClient<Database>(url!, anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;
const writesConfigured = Boolean(
  configured && process.env.SMOKE_TEST_ALLOW_WRITES === "true" && serviceKey,
);
const service = writesConfigured
  ? createClient<Database>(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

describe.skipIf(!configured)("real environment read-only smoke", () => {
  it("connects and reads published public resources", async () => {
    const [products, categories, projects, assets] = await Promise.all([
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
    expect(products.error).toBeNull();
    expect(categories.error).toBeNull();
    expect(projects.error).toBeNull();
    expect(assets.error).toBeNull();
  });

  it("calls the public product search RPC", async () => {
    const result = await anon!.rpc("search_published_products", {
      p_query: null,
      p_offset: 0,
      p_limit: 1,
    });
    expect(result.error).toBeNull();
  });

  it("cannot read inquiries or write analytics directly", async () => {
    const inquiryRead = await anon!.from("inquiries").select("id").limit(1);
    const analyticsWrite = await anon!.from("analytics_events").insert({
      event_name: "page_view",
      locale: "zh",
      page_path: "/[REGRESSION TEST]",
      product_id: null,
      project_id: null,
      source: "smoke",
      channel: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      referrer: null,
    });
    expect(inquiryRead.data || []).toEqual([]);
    expect(analyticsWrite.error).not.toBeNull();
  });
});

describe.skipIf(!writesConfigured)(
  "real environment explicitly enabled write smoke",
  () => {
    it("writes only marked regression rows and cleans them by exact IDs", async () => {
      const marker = `[REGRESSION TEST] ${crypto.randomUUID()}`;
      let inquiryId: string | null = null;
      let analyticsId: string | null = null;
      try {
        const inquiry = await service!
          .from("inquiries")
          .insert({
            name: marker,
            interested_product: marker,
            status: "new",
            source: "smoke",
            language: "en",
            is_read: false,
          })
          .select("id")
          .single();
        expect(inquiry.error).toBeNull();
        inquiryId = inquiry.data?.id || null;
        expect(inquiryId).not.toBeNull();

        const item = await service!.from("inquiry_items").insert({
          inquiry_id: inquiryId!,
          product_id: null,
          product_slug: null,
          product_name_cn: marker,
          product_name_en: marker,
          quantity: null,
          sort_order: 0,
        });
        expect(item.error).toBeNull();

        const analytics = await service!
          .from("analytics_events")
          .insert({
            event_name: "page_view",
            locale: "en",
            page_path: `/smoke/${encodeURIComponent(marker)}`,
            product_id: null,
            project_id: null,
            source: "smoke",
            channel: null,
            utm_source: null,
            utm_medium: null,
            utm_campaign: null,
            referrer: null,
          })
          .select("id")
          .single();
        expect(analytics.error).toBeNull();
        analyticsId = analytics.data?.id || null;
      } finally {
        if (analyticsId)
          await service!
            .from("analytics_events")
            .delete()
            .eq("id", analyticsId);
        if (inquiryId) {
          await service!
            .from("inquiry_items")
            .delete()
            .eq("inquiry_id", inquiryId);
          await service!
            .from("inquiries")
            .delete()
            .eq("id", inquiryId)
            .eq("name", marker);
        }
      }
    });
  },
);
