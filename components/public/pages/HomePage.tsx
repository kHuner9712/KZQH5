import Link from "next/link";
import {
  ArrowRight,
  Flame,
  Globe2,
  Leaf,
  ShieldCheck,
  Truck,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import { CategoryCard } from "@/components/public/CategoryCard";
import { CertificateCard } from "@/components/public/CertificateCard";
import {
  HomeHeroCarousel,
  type HomeHeroCarouselSlide,
} from "@/components/public/HomeHeroCarousel";
import { ProductCard } from "@/components/public/ProductCard";
import { ProductImage } from "@/components/public/ProductImage";
import { SectionHeader } from "@/components/public/SectionHeader";
import { HOME_HERO_ARTWORK } from "@/components/public/homeAssets";
import { isDemoMode } from "@/lib/demo";
import {
  localizedValue,
  localizeCompany,
  localizeHomepage,
  localizeProject,
  localizeSiteSettings,
} from "@/lib/i18n/content";
import { localeConfig, localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import {
  getMockFeaturedProducts,
  mockCategories,
  mockCertificates,
  mockCompany,
} from "@/lib/mock-data";
import { fetchHomepageContent, fetchSiteSettings } from "@/lib/queries/cms";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { serializeJsonLd, siteUrl } from "@/lib/utils";
import {
  safeAddress,
  safeEmail,
  safePhone,
  sanitizeCompany,
} from "@/lib/content/placeholder-detection";
import { PublicDataUnavailableError } from "@/lib/repositories/public-types";
import {
  PRODUCT_FIELDS,
  CATEGORY_FIELDS,
  CERTIFICATE_FIELDS,
  COMPANY_PROFILE_FIELDS,
} from "@/lib/repositories/public-fields";
import type {
  Category,
  Certificate,
  CompanyProfile,
  HomeFeatureItem,
  Product,
  Project,
} from "@/types/database";
import { getFeaturedProjects } from "@/lib/repositories/projects";

export const publicHomeRevalidate = 300;

const featureIcons: Record<string, LucideIcon> = {
  flame: Flame,
  leaf: Leaf,
  truck: Truck,
  globe: Globe2,
  shield: ShieldCheck,
};

const fallbackFeatures: Record<Locale, HomeFeatureItem[]> = {
  zh: [
    {
      icon: "flame",
      title: "B 级防火",
      description: "具体等级以产品详情与公开检测资料为准",
    },
    { icon: "leaf", title: "E0 环保", description: "适用于室内工程与装饰应用" },
    {
      icon: "truck",
      title: "工程交付",
      description: "支持工程批量供货与规格定制",
    },
    {
      icon: "globe",
      title: "海外采购",
      description: "支持多语言询盘与 FOB/CIF 出口",
    },
  ],
  en: [
    {
      icon: "flame",
      title: "B Fire Rating",
      description: "Refer to product details and published test documents.",
    },
    {
      icon: "leaf",
      title: "E0 Grade",
      description: "For indoor project and decorative applications.",
    },
    {
      icon: "truck",
      title: "Project Supply",
      description: "Bulk project supply and custom specifications.",
    },
    {
      icon: "globe",
      title: "Overseas Inquiry",
      description: "Multilingual inquiries and FOB/CIF export support.",
    },
  ],
};

function localizedHomepageHref(locale: Locale, href: string): string {
  return href.startsWith("#") ? href : localePath(locale, href);
}

export async function getHomeMetadata(locale: Locale): Promise<Metadata> {
  const settings = localizeSiteSettings(await fetchSiteSettings(), locale);
  const copy = getDictionary(locale).home;
  return buildLocalizedMetadata({
    locale,
    path: "/",
    title: settings.metaTitle || `KZQ | ${copy.heroTitle}`,
    description: settings.metaDescription || copy.heroDescription,
    absolute: true,
  });
}

export function generateMetadata() {
  return getHomeMetadata("zh");
}

export async function HomePageContent(locale: Locale) {
  let featuredProducts: Product[] = [];
  let categories: Category[] = [];
  let certificates: Certificate[] = [];
  let company: CompanyProfile | null = null;

  if (isDemoMode()) {
    featuredProducts = getMockFeaturedProducts(8);
    categories = [...mockCategories].sort(
      (a, b) => a.sort_order - b.sort_order,
    );
    certificates = mockCertificates
      .filter((item) => item.is_published)
      .sort((a, b) => a.sort_order - b.sort_order)
      .slice(0, 3);
    company = sanitizeCompany(mockCompany);
  } else {
    const supabase = createPublicSupabaseClient();
    const [productsResult, categoryResult, certificateResult, companyResult] =
      await Promise.all([
        supabase
          .from("products")
          .select(PRODUCT_FIELDS)
          .eq("is_published", true)
          .eq("is_featured", true)
          .order("sort_order", { ascending: true })
          .limit(8),
        supabase
          .from("categories")
          .select(CATEGORY_FIELDS)
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
        supabase
          .from("certificates")
          .select(CERTIFICATE_FIELDS)
          .eq("is_published", true)
          .order("sort_order", { ascending: true })
          .limit(3),
        supabase
          .from("company_profile")
          .select(COMPANY_PROFILE_FIELDS)
          .limit(1)
          .maybeSingle(),
      ]);
    const queryError =
      productsResult.error ||
      categoryResult.error ||
      certificateResult.error ||
      companyResult.error;
    if (queryError) {
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", {
        cause: queryError,
      });
    }
    featuredProducts = (productsResult.data as unknown as Product[] | null) || [];
    categories = (categoryResult.data as unknown as Category[] | null) || [];
    certificates =
      (certificateResult.data as unknown as Certificate[] | null) || [];
    company = sanitizeCompany(companyResult.data as CompanyProfile | null);
  }

  let featuredProjects: Project[] = [];
  try {
    featuredProjects = await getFeaturedProjects(3);
  } catch (error) {
    console.error(
      "Optional featured projects query failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }

  const homepageContent = await fetchHomepageContent();
  const home = localizeHomepage(homepageContent, locale);
  const localizedCompany = localizeCompany(company, locale);
  const dictionary = getDictionary(locale);
  const copy = dictionary.home;
  const homepageSource = homepageContent as unknown as Record<string, unknown> | null;
  const trustItems = home.features.length
    ? home.features
    : localizedCompany.advantages.length
      ? localizedCompany.advantages
      : fallbackFeatures[locale];

  const configuredHeroSlides: HomeHeroCarouselSlide[] = (
    homepageContent?.hero_slides || []
  )
    .filter((slide) => slide.enabled && Boolean(slide.desktop_image_url))
    .slice(0, 5)
    .map((slide) => {
      const source = slide as unknown as Record<string, unknown>;
      const title =
        localizedValue<string>(source, "title", locale) ||
        home.heroTitle ||
        copy.heroTitle;
      return {
        id: slide.id,
        desktopImageUrl: slide.desktop_image_url,
        mobileImageUrl: slide.mobile_image_url,
        alt:
          localizedValue<string>(source, "alt", locale) ||
          title ||
          "KZQ engineering boards",
        eyebrow:
          localizedValue<string>(source, "eyebrow", locale) ||
          home.heroEyebrow ||
          "Engineering Boards · Decorative Panels",
        title,
        highlight:
          localizedValue<string>(source, "highlight", locale) ||
          home.heroHighlight ||
          copy.heroHighlight,
        description:
          localizedValue<string>(source, "description", locale) ||
          home.heroDescription ||
          copy.heroDescription,
        primaryCtaText:
          localizedValue<string>(source, "primary_cta_text", locale) ||
          home.primaryCta ||
          copy.browse,
        primaryCtaHref: localizedHomepageHref(
          locale,
          slide.primary_cta_href || "/products",
        ),
        secondaryCtaText:
          localizedValue<string>(source, "secondary_cta_text", locale) ||
          home.secondaryCta ||
          copy.inquiry,
        secondaryCtaHref: localizedHomepageHref(
          locale,
          slide.secondary_cta_href || "/contact",
        ),
        focalX: slide.focal_x ?? 50,
        focalY: slide.focal_y ?? 50,
        overlayOpacity: slide.overlay_opacity ?? 0.42,
      };
    });

  const heroSlides: HomeHeroCarouselSlide[] = configuredHeroSlides.length
    ? configuredHeroSlides
    : [
        {
          id: "default-home-hero",
          desktopImageUrl: HOME_HERO_ARTWORK,
          mobileImageUrl: null,
          alt: home.heroTitle || copy.heroTitle,
          eyebrow:
            home.heroEyebrow || "Engineering Boards · Decorative Panels",
          title: home.heroTitle || copy.heroTitle,
          highlight: home.heroHighlight || copy.heroHighlight,
          description: home.heroDescription || copy.heroDescription,
          primaryCtaText: home.primaryCta || copy.browse,
          primaryCtaHref: localePath(locale, "/products"),
          secondaryCtaText: home.secondaryCta || copy.inquiry,
          secondaryCtaHref: localePath(locale, "/contact"),
          focalX: 57,
          focalY: 50,
          overlayOpacity: 0.34,
        },
      ];

  const certificatesTitle =
    localizedValue<string>(
      homepageSource,
      "certificates_section_title",
      locale,
    ) || copy.certificates;
  const certificatesNote =
    localizedValue<string>(homepageSource, "certificates_note", locale) ||
    copy.certificateNote;
  const projectsTitle =
    localizedValue<string>(homepageSource, "projects_section_title", locale) ||
    dictionary.projects.featured;
  const projectsSubtitle =
    localizedValue<string>(
      homepageSource,
      "projects_section_subtitle",
      locale,
    ) || dictionary.projects.subtitle;
  const bottomCtaEyebrow =
    localizedValue<string>(homepageSource, "bottom_cta_eyebrow", locale) ||
    "Project Inquiry";
  const bottomCtaButton =
    localizedValue<string>(homepageSource, "bottom_cta_button_text", locale) ||
    copy.inquiry;

  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "KZQ",
    url: siteUrl(localePath(locale)),
    logo: company?.logo_url || undefined,
    description: localizedCompany.description || undefined,
    inLanguage: localeConfig[locale].htmlLang,
    address: safeAddress(localizedCompany.address)
      ? {
          "@type": "PostalAddress",
          streetAddress: safeAddress(localizedCompany.address),
        }
      : undefined,
    contactPoint: {
      "@type": "ContactPoint",
      telephone: safePhone(company?.phone) || undefined,
      email: safeEmail(company?.email) || undefined,
      contactType: "sales",
    },
  };

  return (
    <div className="bg-canvas text-ink">
      <HomeHeroCarousel
        slides={heroSlides}
        previousLabel={locale === "zh" ? "上一张" : "Previous slide"}
        nextLabel={locale === "zh" ? "下一张" : "Next slide"}
        slideLabel={locale === "zh" ? "首页主视觉" : "Homepage hero"}
      />

      <section
        className="border-b border-ink-line bg-canvas-warm px-2 py-3 md:px-12 md:py-10"
        aria-label={copy.trustTitle}
      >
        <div className="mx-auto grid max-w-content grid-cols-4">
          {trustItems.slice(0, 4).map((item, index) => {
            const Icon = featureIcons[item.icon] || ShieldCheck;
            return (
              <div
                key={`${item.title}-${index}`}
                className="min-w-0 border-l border-ink-line px-1 text-center first:border-l-0 md:px-6 md:text-left md:first:pl-0 md:last:pr-0"
              >
                <Icon className="mx-auto h-4 w-4 text-gold md:mx-0 md:h-6 md:w-6" />
                <h2 className="mt-1.5 line-clamp-2 text-[10px] font-semibold leading-tight text-ink md:mt-3 md:text-base">
                  {item.title}
                </h2>
                <p className="mt-1 hidden text-[13px] leading-[1.6] text-ink-mute md:block">
                  {item.description}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section
        id="categories"
        className="scroll-mt-12 bg-canvas py-8 md:scroll-mt-16 md:py-20"
      >
        <div className="container-responsive">
          <SectionHeader
            eyebrow="Categories"
            title={home.categoryTitle || copy.categoryTitle}
            subtitle={home.categorySubtitle || copy.categorySubtitle}
            action={
              <Link
                href={localePath(locale, "/products")}
                prefetch={false}
                className="text-[11px] font-medium text-gold-dark hover:text-gold md:text-[13px]"
              >
                {dictionary.common.viewAll} →
              </Link>
            }
            size="large"
          />
          {categories.length > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-2.5 md:mt-10 md:grid-cols-3 md:gap-6">
              {categories.map((category) => (
                <CategoryCard
                  key={category.id}
                  category={category}
                  locale={locale}
                />
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-ink-line bg-canvas-warm px-5 py-10 text-center text-sm text-ink-mute md:mt-10">
              {dictionary.products.empty}
            </div>
          )}
        </div>
      </section>

      <section className="border-y border-ink-line bg-canvas-warm py-8 md:py-20">
        <div className="container-responsive">
          <SectionHeader
            eyebrow="Featured Products"
            title={home.featuredTitle || copy.featuredTitle}
            subtitle={home.featuredSubtitle || copy.featuredSubtitle}
            action={
              <Link
                href={localePath(locale, "/products")}
                prefetch={false}
                className="text-[11px] font-medium text-gold-dark hover:text-gold md:text-[13px]"
              >
                {dictionary.common.viewAll} →
              </Link>
            }
            size="large"
          />
          {featuredProducts.length > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-2.5 md:mt-10 md:grid-cols-2 md:gap-5 lg:grid-cols-3 xl:grid-cols-4">
              {featuredProducts.slice(0, 4).map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  variant="editorial"
                  locale={locale}
                />
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-ink-line bg-white px-5 py-10 text-center text-sm text-ink-mute md:mt-10">
              {dictionary.products.empty}
            </div>
          )}
        </div>
      </section>

      <section className="bg-graphite py-10 text-white md:py-24">
        <div className="container-responsive grid gap-8 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeader
              eyebrow="Why KZQ"
              title={home.featureTitle || copy.trustTitle}
              subtitle={home.featureSubtitle || copy.trustSubtitle}
              light
              size="large"
            />
            {localizedCompany.description && (
              <p className="mt-3 text-xs leading-[1.7] text-white/55 md:mt-6 md:text-[15px] md:leading-7">
                {localizedCompany.description}
              </p>
            )}
            <div className="mt-6 grid grid-cols-2 gap-4 md:mt-10 md:gap-8">
              {trustItems.slice(0, 4).map((item, index) => {
                const Icon = featureIcons[item.icon] || ShieldCheck;
                return (
                  <div key={`${item.title}-${index}`}>
                    <span className="mb-2 block h-px w-6 bg-gold md:mb-3 md:w-8" />
                    <Icon className="h-[18px] w-[18px] text-gold md:h-5 md:w-5" />
                    <h3 className="mt-2 text-[13px] font-medium text-white md:text-[15px]">
                      {item.title}
                    </h3>
                    <p className="mt-1 text-[11px] leading-[1.5] text-white/45 md:text-xs md:leading-[1.6]">
                      {item.description}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="min-w-0 lg:pl-1">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white md:text-xl">
                {certificatesTitle}
              </h2>
              <Link
                href={localePath(locale, "/certificates")}
                prefetch={false}
                className="text-[11px] font-medium text-gold hover:text-gold-light md:text-xs"
              >
                {dictionary.common.viewAll} →
              </Link>
            </div>
            {certificates.length > 0 ? (
              <div className="no-scrollbar mt-3 flex gap-2.5 overflow-x-auto pb-1 md:mt-6 md:grid md:grid-cols-3 md:gap-4 md:overflow-visible">
                {certificates.map((certificate) => (
                  <div
                    key={certificate.id}
                    className="w-[140px] shrink-0 md:w-auto"
                  >
                    <CertificateCard
                      cert={certificate}
                      variant="homepage"
                      locale={locale}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 flex h-32 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-xs text-white/40 md:mt-6 md:h-[196px]">
                {dictionary.certificates.empty}
              </div>
            )}
            <p className="mt-2.5 text-[10px] leading-4 text-white/35 md:mt-4 md:text-[11px]">
              {certificatesNote}
            </p>
          </div>
        </div>
      </section>

      <section className="bg-canvas py-8 md:py-20">
        <div className="container-responsive">
          <SectionHeader
            eyebrow="Projects"
            title={projectsTitle}
            subtitle={projectsSubtitle}
            action={
              <Link
                href={localePath(locale, "/projects")}
                prefetch={false}
                className="text-[11px] font-medium text-gold-dark hover:text-gold md:text-[13px]"
              >
                {dictionary.common.viewAll} →
              </Link>
            }
            size="large"
          />
          {featuredProjects.length > 0 ? (
            <div className="no-scrollbar mt-3 flex gap-3 overflow-x-auto pb-1 md:mt-10 md:grid md:grid-cols-2 md:gap-6 md:overflow-visible">
              {featuredProjects.slice(0, 2).map((project) => {
                const content = localizeProject(project, locale);
                return (
                  <Link
                    key={project.id}
                    href={localePath(locale, `/projects/${project.slug}`)}
                    prefetch={false}
                    className="group w-[260px] shrink-0 overflow-hidden rounded-md border border-ink-line bg-canvas-warm transition-colors hover:border-gold/30 md:w-auto md:rounded-lg"
                  >
                    <div className="aspect-[16/10] overflow-hidden">
                      <ProductImage
                        src={project.cover_image_url}
                        alt={content.title}
                        sizes="(max-width: 767px) 260px, 50vw"
                        className="transition-transform duration-300 group-hover:scale-[1.02]"
                      />
                    </div>
                    <div className="p-3 md:p-5">
                      {content.projectType && (
                        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gold-dark md:text-[11px]">
                          {content.projectType}
                        </p>
                      )}
                      <h3 className="mt-1 text-[15px] font-semibold text-ink md:text-lg">
                        {content.title}
                      </h3>
                      {content.country && (
                        <p className="mt-1 text-[11px] text-ink-mute md:text-xs">
                          {content.country}
                        </p>
                      )}
                      {content.summary && (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-[1.5] text-ink-soft md:mt-2 md:text-[13px] md:leading-[1.6]">
                          {content.summary}
                        </p>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-ink-line bg-canvas-warm px-5 py-10 text-center md:mt-10 md:py-14">
              <p className="text-sm font-medium text-ink">
                {dictionary.projects.empty}
              </p>
              <p className="mt-1 text-xs text-ink-mute">
                {dictionary.projects.emptyHint}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="bg-canvas px-4 py-6 md:px-12 md:py-16">
        <div className="mx-auto max-w-content rounded-lg bg-page px-5 py-6 text-white md:rounded-xl md:px-16 md:py-14">
          <div className="flex flex-col items-start justify-between gap-3 md:flex-row md:items-center md:gap-8">
            <div>
              <div className="flex items-center gap-2 text-gold md:gap-3">
                <span className="h-px w-6 bg-gold md:w-8" />
                <p className="text-[10px] font-medium uppercase tracking-[0.2em] md:text-xs md:tracking-[0.24em]">
                  {bottomCtaEyebrow}
                </p>
              </div>
              <h2 className="font-display mt-2 text-[22px] font-semibold leading-tight md:mt-4 md:text-4xl">
                {home.bottomCtaTitle || copy.ctaTitle}
              </h2>
              <p className="mt-1.5 text-xs leading-5 text-white/50 md:mt-3 md:text-sm">
                {home.bottomCtaDescription || copy.ctaDescription}
              </p>
            </div>
            <Link
              href={localePath(locale, "/contact")}
              prefetch={false}
              className="btn-primary h-11 w-full rounded-md px-5 text-[13px] md:h-12 md:w-auto md:rounded-lg md:px-7 md:text-sm"
            >
              {bottomCtaButton}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(organization) }}
      />
    </div>
  );
}

export default function HomePage() {
  return HomePageContent("zh");
}
