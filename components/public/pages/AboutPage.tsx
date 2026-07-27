import Link from "next/link";
import {
  ArrowRight,
  Boxes,
  Factory,
  Globe2,
  Phone,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { SectionHeader } from "@/components/public/SectionHeader";
import { PublicPageHero } from "@/components/public/PublicPageHero";
import { isDemoMode } from "@/lib/demo";
import { localizeCompany, localizePage } from "@/lib/i18n/content";
import { localeConfig, localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { mockCompany } from "@/lib/mock-data";
import {
  safeAddress,
  safeEmail,
  safePhone,
  sanitizeCompany,
} from "@/lib/content/placeholder-detection";
import { fetchPageContent } from "@/lib/queries/cms";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { serializeJsonLd, siteUrl } from "@/lib/utils";
import type { CompanyProfile } from "@/types/database";

export const publicAboutRevalidate = 300;
const iconMap: Record<string, LucideIcon> = {
  boxes: Boxes,
  shield: ShieldCheck,
  factory: Factory,
  globe: Globe2,
};

export async function getAboutMetadata(locale: Locale): Promise<Metadata> {
  const content = localizePage(await fetchPageContent("about"), locale);
  const copy = getDictionary(locale).about;
  return buildLocalizedMetadata({
    locale,
    path: "/about",
    title: content.seoTitle || content.title || copy.title,
    description: content.seoDescription || content.description || copy.subtitle,
  });
}
export function generateMetadata() {
  return getAboutMetadata("zh");
}

export async function AboutPageContent(locale: Locale) {
  let company: CompanyProfile | null = null;
  if (isDemoMode()) company = sanitizeCompany(mockCompany);
  else {
    const { data, error } = await createPublicSupabaseClient()
      .from("company_profile")
      .select("*")
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("PUBLIC_DATA_UNAVAILABLE", { cause: error });
    company = sanitizeCompany((data as CompanyProfile | null) || null);
  }
  const content = localizePage(await fetchPageContent("about"), locale);
  const localizedCompany = localizeCompany(company, locale);
  const copy = getDictionary(locale).about;
  const safePhoneNumber = safePhone(company?.phone);
  const safeEmailAddress = safeEmail(company?.email);
  const safeCompanyAddress = safeAddress(localizedCompany.address);
  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "KZQ",
    url: siteUrl(localePath(locale)),
    logo: company?.logo_url || undefined,
    description: localizedCompany.description || undefined,
    inLanguage: localeConfig[locale].htmlLang,
    address: safeCompanyAddress
      ? { "@type": "PostalAddress", streetAddress: safeCompanyAddress }
      : undefined,
    contactPoint: {
      "@type": "ContactPoint",
      telephone: safePhoneNumber || undefined,
      email: safeEmailAddress || undefined,
      contactType: "sales",
    },
  };
  const cards = content.sections.length
    ? content.sections.map((section) => ({
        icon: (section.icon && iconMap[section.icon]) || Boxes,
        title: section.title || "",
        description: section.body || section.subtitle || "",
      }))
    : localizedCompany.advantages.map((item) => ({
        icon: Boxes,
        title: item.title,
        description: item.description,
      }));
  return (
    <div className="animate-fade-in bg-canvas">
      <PublicPageHero
        eyebrow="About KZQ"
        variant="brand"
        title={content.title || localizedCompany.title || copy.title}
        subtitle={content.subtitle || copy.subtitle}
        description={content.description || localizedCompany.description}
        meta={
          safeCompanyAddress ? (
            <p className="text-xs text-white/50">{safeCompanyAddress}</p>
          ) : undefined
        }
      />
      {cards.length > 0 && (
        <ResponsiveContainer className="py-8 md:py-16">
          <SectionHeader
            title={copy.capabilities}
            subtitle={copy.capabilitySubtitle}
            size="large"
          />
          <div className="mt-4 grid grid-cols-1 gap-3 md:mt-6 md:grid-cols-2 md:gap-4">
            {cards.map((card, index) => {
              const Icon = card.icon;
              return (
                <div
                  key={`${card.title}-${index}`}
                  className="kzq-interactive-card flex gap-4 rounded-md border border-black/[0.06] bg-canvas-warm p-4 transition-colors hover:border-gold/30 md:rounded-lg md:p-6"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-industrial-50">
                    <Icon className="h-5 w-5 text-industrial" />
                  </div>
                  <div>
                    <h2 className="text-[13px] font-semibold text-ink md:text-base">
                      {card.title}
                    </h2>
                    {card.description && (
                      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft md:mt-2 md:text-sm">
                        {card.description}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ResponsiveContainer>
      )}
      <ResponsiveContainer className="pb-8 md:pb-20">
        <Link
          href={localePath(locale, "/contact")}
          prefetch={false}
          className="relative block overflow-hidden rounded-lg border border-white/10 bg-page p-6 text-white transition-colors hover:border-gold/30 md:rounded-xl md:p-12"
        >
          <div className="relative flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/60">
                Get Quotation
              </p>
              <h3 className="mt-1 text-base font-semibold md:text-2xl">
                {copy.contact}
              </h3>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15">
              <ArrowRight className="h-5 w-5" />
            </div>
          </div>
        </Link>
        {safePhoneNumber && (
          <a
            href={`tel:${safePhoneNumber.replace(/[^+\d]/g, "")}`}
            className="mt-2 flex items-center justify-center gap-1.5 rounded-xl border border-ink-line bg-white py-3 text-[12px] text-ink-soft"
          >
            <Phone className="h-3.5 w-3.5" />
            {safePhoneNumber}
          </a>
        )}
      </ResponsiveContainer>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(organization) }}
      />
    </div>
  );
}
export default function AboutPage() {
  return AboutPageContent("zh");
}
