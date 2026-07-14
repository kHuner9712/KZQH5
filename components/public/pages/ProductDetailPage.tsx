import Link from "next/link";
import {
  ArrowLeft,
  Award,
  Boxes,
  CheckCircle2,
  Layers,
  Package,
  Phone,
  Ruler,
  Truck,
} from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { EcoBadge, FireBadge } from "@/components/public/Badge";
import { CertificateGallery } from "@/components/public/CertificateGallery";
import { ImageCarousel } from "@/components/public/ImageCarousel";
import { ProductAssetList } from "@/components/public/ProductAssetList";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { isDemoMode } from "@/lib/demo";
import {
  localizeCategory,
  localizeCertificate,
  localizeProduct,
  localizeProductImage,
  localizeSubcategory,
} from "@/lib/i18n/content";
import { localeConfig, localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import {
  getMockProductBySlug,
  getMockProductImages,
  mockCategories,
  mockCertificates,
  mockCompany,
  mockSubcategories,
} from "@/lib/mock-data";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { serializeJsonLd, siteUrl } from "@/lib/utils";
import type {
  Category,
  Certificate,
  Product,
  ProductImage,
  Subcategory,
} from "@/types/database";
import { AddToInquiryButton } from "@/components/public/inquiry-list/AddToInquiryButton";
import { getPublishedProductAssets } from "@/lib/repositories/product-assets";
import { ContextEventTracker } from "@/components/public/AnalyticsTracker";

export const publicProductDetailRevalidate = 300;

const fetchProduct = cache(async (slug: string): Promise<Product | null> => {
  if (isDemoMode()) return getMockProductBySlug(slug);
  const { data, error } = await createPublicSupabaseClient()
    .from("products")
    .select("*")
    .eq("slug", slug)
    .eq("is_published", true)
    .maybeSingle();
  if (error) throw new Error("PUBLIC_DATA_UNAVAILABLE", { cause: error });
  return (data as Product | null) || null;
});

export async function getProductMetadata(
  locale: Locale,
  slug: string,
): Promise<Metadata> {
  const copy = getDictionary(locale).products;
  let product: Product | null;
  try {
    product = await fetchProduct(slug);
  } catch {
    return buildLocalizedMetadata({
      locale,
      path: `/products/${slug}`,
      title: copy.title,
      description: copy.description,
    });
  }
  if (!product) {
    return {
      ...buildLocalizedMetadata({
        locale,
        path: `/products/${slug}`,
        title: copy.notFound,
        description: copy.notFound,
      }),
      robots: { index: false, follow: false },
    };
  }
  const content = localizeProduct(product, locale);
  return buildLocalizedMetadata({
    locale,
    path: `/products/${slug}`,
    title: content.seoTitle || `${content.name} | KZQ`,
    description: content.seoDescription || content.summary || content.name,
    image: product.cover_image_url,
  });
}
export function generateMetadata({ params }: { params: { slug: string } }) {
  return getProductMetadata("zh", params.slug);
}

export async function ProductDetailPageContent(locale: Locale, slug: string) {
  const product = await fetchProduct(slug);
  if (!product) notFound();
  let images: ProductImage[] = [];
  let category: Category | null = null;
  let subcategory: Subcategory | null = null;
  let certificates: Certificate[] = [];
  let phone: string | null = null;
  if (isDemoMode()) {
    images = getMockProductImages(product.id);
    category =
      mockCategories.find((item) => item.id === product.category_id) || null;
    subcategory =
      mockSubcategories.find((item) => item.id === product.subcategory_id) ||
      null;
    certificates = mockCertificates
      .filter((item) => item.is_published)
      .slice(0, 4);
    phone = mockCompany.phone;
  } else {
    const supabase = createPublicSupabaseClient();
    const [
      imageResult,
      categoryResult,
      subcategoryResult,
      certificateResult,
      companyResult,
    ] = await Promise.all([
      supabase
        .from("product_images")
        .select("*")
        .eq("product_id", product.id)
        .order("sort_order", { ascending: true }),
      product.category_id
        ? supabase
            .from("categories")
            .select("*")
            .eq("id", product.category_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      product.subcategory_id
        ? supabase
            .from("subcategories")
            .select("*")
            .eq("id", product.subcategory_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from("certificates")
        .select("*")
        .eq("is_published", true)
        .order("sort_order", { ascending: true })
        .limit(4),
      supabase.from("company_profile").select("phone").limit(1).maybeSingle(),
    ]);
    const queryError =
      imageResult.error ||
      categoryResult.error ||
      subcategoryResult.error ||
      certificateResult.error ||
      companyResult.error;
    if (queryError)
      throw new Error("PUBLIC_DATA_UNAVAILABLE", { cause: queryError });
    images = (imageResult.data as ProductImage[] | null) || [];
    category = categoryResult.data as Category | null;
    subcategory = subcategoryResult.data as Subcategory | null;
    certificates = (certificateResult.data as Certificate[] | null) || [];
    phone =
      (companyResult.data as { phone: string | null } | null)?.phone || null;
  }
  const content = localizeProduct(product, locale);
  const copy = getDictionary(locale);
  const productUrl = siteUrl(localePath(locale, `/products/${product.slug}`));
  const assets = await getPublishedProductAssets(product.id);
  const carousel = [
    ...(product.cover_image_url
      ? [{ url: product.cover_image_url, alt: content.name }]
      : []),
    ...images
      .filter((image) => image.image_url)
      .map((image) => ({
        url: image.image_url as string,
        alt: localizeProductImage(image, locale, content.name),
      })),
  ];
  const specs = [
    { icon: Ruler, label: copy.products.size, value: product.size },
    { icon: Layers, label: copy.products.material, value: content.material },
    { icon: Package, label: copy.products.packaging, value: content.packaging },
    { icon: Truck, label: copy.products.logistics, value: content.logistics },
    { icon: Boxes, label: copy.products.moq, value: product.moq },
    {
      icon: CheckCircle2,
      label: copy.products.application,
      value: content.application,
    },
  ].filter((item) => item.value);
  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: content.name,
    description: content.summary || content.description || content.name,
    image: carousel.map((image) => image.url),
    sku: product.slug,
    brand: { "@type": "Brand", name: "KZQ" },
    category: category ? localizeCategory(category, locale).name : undefined,
    inLanguage: localeConfig[locale].htmlLang,
    url: productUrl,
  };
  const faqJsonLd = content.faq?.length
    ? {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        inLanguage: localeConfig[locale].htmlLang,
        mainEntity: content.faq.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer },
        })),
      }
    : null;
  const inquiryParams = new URLSearchParams({
    product: content.name,
    product_id: product.id,
    product_slug: product.slug,
    page_url: productUrl,
  });
  const inquiryUrl = `${localePath(locale, "/contact")}?${inquiryParams.toString()}`;
  return (
    <div className="animate-fade-in bg-canvas pb-24 md:pb-0">
      <ContextEventTracker
        eventName="product_view"
        locale={locale}
        productId={product.id}
      />
      <div className="sticky top-0 z-30 border-b border-ink-line bg-white/95 backdrop-blur-lg md:top-16">
        <ResponsiveContainer className="flex items-center gap-3 py-3">
          <Link
            href={localePath(locale, "/products")}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-canvas-warm"
            aria-label={copy.common.back}
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="truncate text-sm font-medium text-ink">
            {content.name}
          </span>
        </ResponsiveContainer>
      </div>
      <ResponsiveContainer className="py-4 md:py-10">
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-10">
          <div className="overflow-hidden rounded-xl border border-ink-line bg-white">
            <ImageCarousel images={carousel} videoUrl={product.video_url} />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-brass">
              {category ? localizeCategory(category, locale).name : "KZQ"}
              {subcategory
                ? ` · ${localizeSubcategory(subcategory, locale).name}`
                : ""}
            </p>
            <h1 className="mt-2 text-2xl font-bold text-ink md:text-4xl">
              {content.name}
            </h1>
            {content.summary && (
              <p className="mt-3 text-sm leading-7 text-ink-soft md:text-base">
                {content.summary}
              </p>
            )}
            <div className="mt-4 flex gap-2">
              {product.fire_rating && (
                <FireBadge rating={product.fire_rating} />
              )}
              {product.eco_grade && <EcoBadge grade={product.eco_grade} />}
            </div>
            <p className="mt-5 text-base font-semibold text-industrial">
              {content.price || copy.products.contactPrice}
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <AddToInquiryButton
                product={product}
                locale={locale}
                className="h-12 sm:px-5"
              />
              <Link
                href={inquiryUrl}
                className="btn-primary h-12 w-full sm:w-auto sm:px-8"
              >
                {copy.common.getQuote}
              </Link>
            </div>
          </div>
        </div>
        {content.description && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold text-ink">
              {copy.products.detailIntro}
            </h2>
            <p className="mt-3 whitespace-pre-line text-sm leading-7 text-ink-soft">
              {content.description}
            </p>
          </section>
        )}
        {specs.length > 0 && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold text-ink">
              {copy.products.specs}
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {specs.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="card-base flex gap-3 p-4">
                    <Icon className="h-5 w-5 shrink-0 text-brass" />
                    <div>
                      <p className="text-xs text-ink-mute">{item.label}</p>
                      <p className="mt-1 text-sm text-ink">{item.value}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {assets.length > 0 && (
          <section className="mt-8">
            <ProductAssetList
              assets={assets}
              locale={locale}
              title={copy.products.assets}
            />
            <p className="mt-3 text-xs text-ink-mute">
              {copy.products.assetsHint}
            </p>
          </section>
        )}
        {content.faq?.length ? (
          <section className="mt-8">
            <h2 className="text-lg font-semibold text-ink">
              {copy.products.faq}
            </h2>
            <div className="mt-4 space-y-3">
              {content.faq.map((item) => (
                <details key={item.question} className="card-base p-4">
                  <summary className="cursor-pointer font-medium text-ink">
                    {item.question}
                  </summary>
                  <p className="mt-3 text-sm leading-7 text-ink-soft">
                    {item.answer}
                  </p>
                </details>
              ))}
            </div>
          </section>
        ) : null}
        {certificates.length > 0 && (
          <section className="mt-8">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <Award className="h-5 w-5 text-brass" />
              {copy.products.relatedCertificates}
            </h2>
            <div className="mt-4">
              <CertificateGallery certificates={certificates} locale={locale} />
            </div>
          </section>
        )}
      </ResponsiveContainer>
      <div className="safe-bottom fixed bottom-0 left-0 z-50 grid w-full grid-cols-3 gap-2 border-t border-white/10 bg-graphite/95 p-3 md:hidden">
        {phone ? (
          <a
            href={`tel:${phone.replace(/[^+\d]/g, "")}`}
            className="btn-outline h-12 border-white/20 px-2 text-xs text-white"
          >
            <Phone className="h-4 w-4" />
            {locale === "zh" ? "联系" : "Contact"}
          </a>
        ) : (
          <Link
            href={localePath(locale, "/contact")}
            className="btn-outline h-12 border-white/20 px-2 text-xs text-white"
          >
            {locale === "zh" ? "联系" : "Contact"}
          </Link>
        )}
        <AddToInquiryButton
          product={product}
          locale={locale}
          className="h-12 border-white/20 px-1 text-center text-[11px] text-gold-light"
        />
        <Link href={inquiryUrl} className="btn-primary h-12 px-2 text-xs">
          {locale === "zh" ? "立即询盘" : "Inquire now"}
        </Link>
      </div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(productJsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(faqJsonLd) }}
        />
      )}
    </div>
  );
}
export default function ProductDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  return ProductDetailPageContent("zh", params.slug);
}
