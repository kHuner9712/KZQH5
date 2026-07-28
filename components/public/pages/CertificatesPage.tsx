import { Award, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { CertificateGallery } from "@/components/public/CertificateGallery";
import { EmptyState } from "@/components/public/EmptyState";
import { ProductAssetList } from "@/components/public/ProductAssetList";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { PublicPageHero } from "@/components/public/PublicPageHero";
import { isDemoMode } from "@/lib/demo";
import { localizePage } from "@/lib/i18n/content";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { mockCertificates } from "@/lib/mock-data";
import { fetchPageContent } from "@/lib/queries/cms";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { PublicDataUnavailableError } from "@/lib/repositories/public-types";
import { CERTIFICATE_FIELDS } from "@/lib/repositories/public-fields";
import type { Certificate } from "@/types/database";
import { getPublishedProductAssets } from "@/lib/repositories/product-assets";

export const publicCertificatesRevalidate = 300;

export async function getCertificatesMetadata(
  locale: Locale,
): Promise<Metadata> {
  const content = localizePage(await fetchPageContent("certificates"), locale);
  const copy = getDictionary(locale).certificates;
  return buildLocalizedMetadata({
    locale,
    path: "/certificates",
    title: content.seoTitle || content.title || copy.title,
    description:
      content.seoDescription || content.description || copy.description,
  });
}
export function generateMetadata() {
  return getCertificatesMetadata("zh");
}

export async function CertificatesPageContent(locale: Locale) {
  let certificates: Certificate[] = [];
  if (isDemoMode())
    certificates = [...mockCertificates].sort(
      (a, b) => a.sort_order - b.sort_order,
    );
  else {
    const { data, error } = await createPublicSupabaseClient()
      .from("certificates")
      .select(CERTIFICATE_FIELDS)
      .eq("is_published", true)
      .order("sort_order", { ascending: true });
    if (error) throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", { cause: error });
    certificates = (data as unknown as Certificate[] | null) || [];
  }
  const content = localizePage(await fetchPageContent("certificates"), locale);
  const copy = getDictionary(locale).certificates;
  const assets = await getPublishedProductAssets(null);
  return (
    <div className="animate-fade-in bg-canvas">
      <PublicPageHero
        eyebrow="Certificates"
        title={content.title || copy.title}
        subtitle={content.subtitle || copy.subtitle}
        description={content.description}
        meta={
          !content.description ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-white/15 px-3 py-1.5 text-[11px] text-white/65">
              <ShieldCheck className="h-3.5 w-3.5 text-gold-light" />
              {copy.displayOnly}
            </span>
          ) : undefined
        }
      />
      {certificates.length > 0 && (
        <ResponsiveContainer className="pt-6 md:pt-10">
          <div className="card-base flex items-center justify-between p-4 md:p-5">
            <div>
              <p className="text-2xl font-bold text-ink md:text-3xl">
                {certificates.length}
              </p>
              <p className="text-[11px] text-ink-mute md:text-xs">
                {copy.published}
              </p>
            </div>
            <div className="h-8 w-px bg-ink-line md:h-10" />
            <div className="text-right">
              <p className="text-[13px] font-semibold text-industrial md:text-base">
                {copy.categories}
              </p>
              <p className="text-[11px] text-ink-mute md:text-xs">
                {copy.fullDocs}
              </p>
            </div>
          </div>
        </ResponsiveContainer>
      )}
      <ResponsiveContainer className="py-8 md:py-14">
        {certificates.length ? (
          <CertificateGallery certificates={certificates} locale={locale} />
        ) : (
          <EmptyState
            title={copy.empty}
            description={copy.emptyHint}
            icon={Award}
          />
        )}
        {assets.length > 0 && (
          <div className="mt-10">
            <ProductAssetList
              assets={assets}
              locale={locale}
              title={getDictionary(locale).assets.siteTitle}
            />
          </div>
        )}
      </ResponsiveContainer>
    </div>
  );
}
export default function CertificatesPage() {
  return CertificatesPageContent("zh");
}
