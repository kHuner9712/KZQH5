import { isDemoMode } from "@/lib/demo";
import { mockCompany } from "@/lib/mock-data";
import { fetchSiteSettings } from "@/lib/queries/cms";
import { sanitizeCompany } from "@/lib/content/placeholder-detection";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import type { CompanyProfile, SiteSettings } from "@/types/database";

export async function getPublicSiteShellData(): Promise<{
  company: CompanyProfile | null;
  siteSettings: SiteSettings | null;
}> {
  if (isDemoMode()) {
    return { company: sanitizeCompany(mockCompany), siteSettings: await fetchSiteSettings() };
  }

  try {
    const supabase = createPublicSupabaseClient();
    const [{ data }, siteSettings] = await Promise.all([
      supabase.from("company_profile").select("*").limit(1).maybeSingle(),
      fetchSiteSettings(),
    ]);
    return {
      company: sanitizeCompany((data as CompanyProfile | null) || null),
      siteSettings,
    };
  } catch {
    return { company: null, siteSettings: null };
  }
}
