import { Award, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { CertificateGallery } from "@/components/public/CertificateGallery";
import { EmptyState } from "@/components/public/EmptyState";
import { ProductAssetList } from "@/components/public/ProductAssetList";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { isDemoMode } from "@/lib/demo";
import { localizePage } from "@/lib/i18n/content";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { mockCertificates } from "@/lib/mock-data";
import { fetchPageContent } from "@/lib/queries/cms";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import type { Certificate } from "@/types/database";
import { getPublishedProductAssets } from "@/lib/repositories/product-assets";

export const publicCertificatesRevalidate = 300;

export async function getCertificatesMetadata(locale: Locale): Promise<Metadata> {
  const content = localizePage(await fetchPageContent("certificates"), locale);
  const copy = getDictionary(locale).certificates;
  return buildLocalizedMetadata({ locale, path: "/certificates", title: content.seoTitle || content.title || copy.title, description: content.seoDescription || content.description || copy.description });
}
export function generateMetadata() { return getCertificatesMetadata("zh"); }

export async function CertificatesPageContent(locale: Locale) {
  let certificates: Certificate[] = [];
  if (isDemoMode()) certificates = [...mockCertificates].sort((a, b) => a.sort_order - b.sort_order);
  else { const { data, error } = await createPublicSupabaseClient().from("certificates").select("*").eq("is_published", true).order("sort_order", { ascending: true }); if (error) throw new Error("PUBLIC_DATA_UNAVAILABLE", { cause: error }); certificates = (data as Certificate[] | null) || []; }
  const content = localizePage(await fetchPageContent("certificates"), locale);
  const copy = getDictionary(locale).certificates;
  const assets = await getPublishedProductAssets(null);
  return (
    <div className="animate-fade-in bg-canvas">
      <div className="bg-canvas-warm texture-paper"><ResponsiveContainer className="pb-5 pt-10 md:pb-8 md:pt-16"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brass/10 ring-1 ring-inset ring-brass/20 md:h-14 md:w-14"><Award className="h-5 w-5 text-brass md:h-6 md:w-6" /></div><p className="mt-3 text-[10px] uppercase tracking-[0.2em] text-brass md:text-xs">Certificates</p><h1 className="mt-1 text-xl font-bold tracking-tight text-ink md:mt-2 md:text-3xl">{content.title || copy.title}</h1><p className="mt-1 text-[12px] text-ink-soft md:mt-2 md:text-sm">{content.subtitle || copy.subtitle}</p>{content.description ? <p className="mt-2 max-w-2xl text-[11.5px] leading-relaxed text-ink-mute md:text-xs">{content.description}</p> : <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-ink-line bg-white px-3 py-1 text-[11px] text-ink-soft md:text-xs"><ShieldCheck className="h-3 w-3 text-emerald-600" />{copy.displayOnly}</div>}</ResponsiveContainer></div>
      {certificates.length > 0 && <ResponsiveContainer className="pt-5"><div className="card-base flex items-center justify-between p-4 md:p-5"><div><p className="text-2xl font-bold text-ink md:text-3xl">{certificates.length}</p><p className="text-[11px] text-ink-mute md:text-xs">{copy.published}</p></div><div className="h-8 w-px bg-ink-line md:h-10" /><div className="text-right"><p className="text-[13px] font-semibold text-industrial md:text-base">{copy.categories}</p><p className="text-[11px] text-ink-mute md:text-xs">{copy.fullDocs}</p></div></div></ResponsiveContainer>}
      <ResponsiveContainer className="py-5 md:py-8">{certificates.length ? <CertificateGallery certificates={certificates} locale={locale} /> : <EmptyState title={copy.empty} description={copy.emptyHint} icon={Award} />}{assets.length > 0 && <div className="mt-10"><ProductAssetList assets={assets} locale={locale} title={getDictionary(locale).assets.siteTitle} /></div>}</ResponsiveContainer>
    </div>
  );
}
export default function CertificatesPage() { return CertificatesPageContent("zh"); }
