import Link from "next/link";
import { Award, BookOpen, MessageCircle, Palette, PanelsTopLeft, Sparkles, type LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import { CatalogTopicGrid, type CatalogTopicGridItem } from "@/components/public/CatalogTopicGrid";
import { ProductAssetList } from "@/components/public/ProductAssetList";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { findCatalogTopicAsset, sortCatalogAssets } from "@/lib/catalog-assets";
import { catalogTopics, catalogTopicSections, type CatalogTopic, type CatalogTopicSection } from "@/lib/catalog-topics";
import { localeConfig, localePath, type Locale } from "@/lib/i18n/config";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { getPublishedProductAssets } from "@/lib/repositories/product-assets";
import { serializeJsonLd, siteUrl } from "@/lib/utils";

const pageCopy = {
  zh: {
    eyebrow: "KZQ DOCUMENT CENTER",
    title: "产品目录与色卡",
    subtitle: "集中查看 KZQ 产品手册、色卡、系统资料、认证文件与新品资料。",
    description: "KZQ 产品目录与色卡中心，覆盖 WPC 墙板、门、地板、型材、软石、吸音格栅、收边系统及木纹、石纹、金属、纯色和布纹饰面资料。",
    request: "联系销售获取",
    publishedTitle: "全部在线资料",
    publishedDescription: "以下资料已由 KZQ 后台发布，可在线预览、在浏览器中打开或复制链接。",
    noPublished: "目录主题已经建立，具体文件将由 KZQ 后台逐项发布。",
    note: "产品参数、花色、认证范围与可供应情况以 KZQ 当前确认并发布的版本为准。",
    certificates: "检测与认证",
    certificatesDescription: "已确认可公开展示的检测报告、认证和产品合规资料。",
    releases: "新品资料",
    releasesDescription: "按发布日期展示近期发布的产品目录和选型资料。",
  },
  en: {
    eyebrow: "KZQ DOCUMENT CENTER",
    title: "Catalogs & Color Cards",
    subtitle: "Browse KZQ catalogs, color cards, system documents, certifications and new releases.",
    description: "KZQ catalog and color-card center covering WPC wall panels, doors, flooring, profiles, soft stone, acoustic grilles, finishing systems and wood, stone, metal, solid-color and fabric finishes.",
    request: "Request from sales",
    publishedTitle: "All Online Documents",
    publishedDescription: "These KZQ files are published for online preview, browser access and link sharing.",
    noPublished: "The catalog structure is ready. Files will be published progressively through the KZQ CMS.",
    note: "Specifications, finishes, certification scope and availability are subject to the latest version confirmed and published by KZQ.",
    certificates: "Testing & Certifications",
    certificatesDescription: "Confirmed public test reports, certifications and product compliance documents.",
    releases: "New Releases",
    releasesDescription: "Recently published product catalogs and selection references, ordered by publication date.",
  },
} as const;

const sectionIcons: Record<CatalogTopicSection, LucideIcon> = {
  catalogs: BookOpen,
  systems: PanelsTopLeft,
  finishes: Palette,
};

export function getDocumentsMetadata(locale: Locale): Metadata {
  const copy = pageCopy[locale];
  // Root layout applies the `| KZQ` template suffix automatically — pages
  // must NOT append `| KZQ` themselves, otherwise the final title becomes
  // "产品目录与色卡 | KZQ | KZQ".
  return buildLocalizedMetadata({ locale, path: "/documents", title: copy.title, description: copy.description });
}

function topicContactUrl(locale: Locale, topic: CatalogTopic): string {
  const params = new URLSearchParams({
    product: locale === "zh" ? topic.titleCn : topic.titleEn,
    source: "document-center",
    page_url: siteUrl(localePath(locale, "/documents")),
  });
  return `${localePath(locale, "/contact")}?${params.toString()}`;
}

function topicGridItems(locale: Locale, topics: CatalogTopic[], assets: Awaited<ReturnType<typeof getPublishedProductAssets>>): CatalogTopicGridItem[] {
  return topics.map((topic) => ({
    topic,
    asset: findCatalogTopicAsset(topic, assets),
    index: catalogTopics.indexOf(topic),
    contactHref: topicContactUrl(locale, topic),
  }));
}

export async function DocumentsPageContent(locale: Locale) {
  const copy = pageCopy[locale];
  const assets = sortCatalogAssets(await getPublishedProductAssets(null));
  const publishedTopicCount = catalogTopics.filter((topic) => findCatalogTopicAsset(topic, assets)).length;
  const certificates = assets.filter((asset) => asset.asset_type === "certificate");
  const releases = assets.filter((asset) => asset.published_at).slice(0, 6);
  const pageUrl = siteUrl(localePath(locale, "/documents"));
  const collectionJsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: copy.title,
    description: copy.description,
    url: pageUrl,
    inLanguage: localeConfig[locale].htmlLang,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: catalogTopics.length,
      itemListElement: catalogTopics.map((topic, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: locale === "zh" ? topic.titleCn : topic.titleEn,
        url: `${pageUrl}#${topic.id}`,
      })),
    },
  };

  return (
    <div className="bg-canvas pb-16 text-ink md:pb-20">
      <section className="border-b border-white/10 bg-page text-white">
        <ResponsiveContainer className="py-10 md:py-16">
          <div className="max-w-3xl">
            <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-gold-light">{copy.eyebrow}</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] md:text-5xl">{copy.title}</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-white/60 md:text-base">{copy.subtitle}</p>
            <div className="mt-6 flex flex-wrap gap-3 text-[11px] text-white/55">
              <span className="rounded-full border border-white/15 px-3 py-1.5">{catalogTopics.length} {locale === "zh" ? "个资料主题" : "document topics"}</span>
              <span className="rounded-full border border-white/15 px-3 py-1.5">{publishedTopicCount} {locale === "zh" ? "个已匹配文件" : "matched files"}</span>
              <span className="rounded-full border border-white/15 px-3 py-1.5">{assets.length} {locale === "zh" ? "份在线资料" : "online files"}</span>
            </div>
          </div>
        </ResponsiveContainer>
      </section>

      {catalogTopicSections.map((section) => {
        const Icon = sectionIcons[section.id];
        const topics = catalogTopics.filter((topic) => topic.section === section.id);
        return (
          <section key={section.id} className="border-b border-ink-line py-9 md:py-14">
            <ResponsiveContainer>
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brass/10 text-brass"><Icon className="h-5 w-5" /></span>
                <div>
                  <h2 className="text-xl font-semibold text-ink md:text-2xl">{locale === "zh" ? section.titleCn : section.titleEn}</h2>
                  <p className="mt-1 text-xs leading-5 text-ink-mute md:text-sm">{locale === "zh" ? section.descriptionCn : section.descriptionEn}</p>
                </div>
              </div>
              <div className="mt-6"><CatalogTopicGrid items={topicGridItems(locale, topics, assets)} locale={locale} /></div>
            </ResponsiveContainer>
          </section>
        );
      })}

      {certificates.length > 0 && (
        <section className="border-b border-ink-line bg-canvas-warm py-9 md:py-14">
          <ResponsiveContainer>
            <div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brass/10 text-brass"><Award className="h-5 w-5" /></span><div><h2 className="text-xl font-semibold md:text-2xl">{copy.certificates}</h2><p className="mt-1 text-xs text-ink-mute md:text-sm">{copy.certificatesDescription}</p></div></div>
            <div className="mt-6"><ProductAssetList assets={certificates} locale={locale} /></div>
          </ResponsiveContainer>
        </section>
      )}

      {releases.length > 0 && (
        <section className="border-b border-ink-line py-9 md:py-14">
          <ResponsiveContainer>
            <div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brass/10 text-brass"><Sparkles className="h-5 w-5" /></span><div><h2 className="text-xl font-semibold md:text-2xl">{copy.releases}</h2><p className="mt-1 text-xs text-ink-mute md:text-sm">{copy.releasesDescription}</p></div></div>
            <div className="mt-6"><ProductAssetList assets={releases} locale={locale} /></div>
          </ResponsiveContainer>
        </section>
      )}

      <section id="published-documents" className="scroll-mt-24 py-9 md:py-14">
        <ResponsiveContainer>
          <div className="max-w-2xl"><h2 className="text-xl font-semibold text-ink md:text-2xl">{copy.publishedTitle}</h2><p className="mt-2 text-xs leading-6 text-ink-mute md:text-sm">{copy.publishedDescription}</p></div>
          {assets.length > 0 ? <div className="mt-6"><ProductAssetList assets={assets} locale={locale} /></div> : <div className="mt-6 rounded-xl border border-dashed border-ink-line bg-canvas-warm p-8 text-center"><p className="text-sm text-ink-soft">{copy.noPublished}</p><Link href={localePath(locale, "/contact")} className="btn-primary mt-5 h-11 px-5 text-xs"><MessageCircle className="h-4 w-4" />{copy.request}</Link></div>}
          <p className="mt-5 text-xs leading-6 text-ink-mute">{copy.note}</p>
        </ResponsiveContainer>
      </section>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(collectionJsonLd) }} />
    </div>
  );
}
