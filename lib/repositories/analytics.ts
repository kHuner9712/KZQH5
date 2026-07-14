import type { SupabaseClient } from "@supabase/supabase-js";
import { isDemoMode } from "@/lib/demo";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type {
  AnalyticsEventInput,
  AnalyticsSummary,
  Database,
} from "@/types/database";

const emptySummary = (): AnalyticsSummary => ({
  page_views: 0,
  product_views: 0,
  contact_clicks: 0,
  inquiry_successes: 0,
  popular_products: [],
  popular_searches: [],
  sources: [],
  utm: [],
});

export async function recordAnalyticsEvent(event: AnalyticsEventInput): Promise<void> {
  if (isDemoMode()) return;
  const { error } = await createAdminSupabaseClient()
    .from("analytics_events")
    .insert(event);
  if (error) throw error;
}

export async function getAnalyticsSummary(
  client: SupabaseClient<Database>,
  start: Date,
  end: Date
): Promise<AnalyticsSummary> {
  if (isDemoMode()) return emptySummary();
  const { data, error } = await client.rpc("get_analytics_summary", {
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) throw error;
  if (!data || typeof data !== "object") return emptySummary();
  const value = data as Partial<AnalyticsSummary>;
  return {
    page_views: Number(value.page_views) || 0,
    product_views: Number(value.product_views) || 0,
    contact_clicks: Number(value.contact_clicks) || 0,
    inquiry_successes: Number(value.inquiry_successes) || 0,
    popular_products: Array.isArray(value.popular_products) ? value.popular_products : [],
    popular_searches: Array.isArray(value.popular_searches) ? value.popular_searches : [],
    sources: Array.isArray(value.sources) ? value.sources : [],
    utm: Array.isArray(value.utm) ? value.utm : [],
  };
}
