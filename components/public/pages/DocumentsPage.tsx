import Link from "next/link";
import {
  BookOpen,
  CheckCircle2,
  FileSearch,
  MessageCircle,
  Palette,
  PanelsTopLeft,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import { ProductAssetList } from "@/components/public/ProductAssetList";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import {
  catalogTopics,
  catalogTopicSections,
  findCatalogTopicAsset,
  type CatalogTopic,
  type CatalogTopicSection,
} from "@/lib/catalog-topics";
import { localeConfig, localePath, type Locale } from "@/lib/i18n/config";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { getPublishedProductAssets } from "@/lib/repositories/product-assets";
import { serializeJsonLd, siteUrl } from "@/lib/utils";
import type { ProductAsset } from "@/types/database";

const pageCopy = {
  zh: {
    eyebrow: "KZQ DOCUMENT CENTER",
    title: "产品目录与色卡",
    subtitle: "集中查看 KZQ 产品手册、色卡、系统资料与饰面选型参考。",
    description:
      "KZQ 产品目录与色卡中心，覆盖 WPC 墙板、门、地板、型材、软石、吸音格栅、收边系统及木纹、石纹、金属、纯色和布纹饰面资料。",
    published: "已发布",
    view: "查看已发布资料",
    request: "联系销售获取",
    publishedTitle: "在线资料",
    publishedDescription: "以下资料已由 KZQ 后台发布，可在线预览或在浏览器中打开。",
    noPublished: "目录主题已经建立，具体文件将由 KZQ 后台逐项发布。",
    note: "产品参数、花色与可供应范围以 KZQ 当前确认并发布的版本为准。",
  },
  en: {
    eyebrow: "KZQ DOCUMENT CENTER",
    title: "Catalogs & Color Cards",
    subtitle: "Browse KZQ catalogs, color cards, system documents and finish references.",
    description:
      "KZQ catalog and color-card center covering WPC wall panels, doors, flooring, profiles, soft stone, acoustic grilles, finishing systems and wood, stone, metal, solid-color and fabric finishes.",
    published: "Published",
    view: "View published document",
    request: "Request from sales",
    publishedTitle: "Online Documents",
    publishedDescription: "The following files are published by KZQ and can be previewed or opened in a browser.",
    noPublished: "The catalog structure is ready. Files will be published progressively through the KZQ CMS.",
    note: "Specifications, finishes and availability are subject to the latest version confirmed and published by KZQ.",
  },
} as const;

const sectionIcons: Record<CatalogTopicSection, LucideIcon> = {
  catalogs: BookOpen,
  systems: PanelsTopLeft,
  finishes: Palette,
};

export function getDocumentsMetadata(locale: Locale): Metadata {
  const copy = pageCopy[locale];
  return buildLocalizedMetadata({
    locale,
    path: "/documents",
    title: `${copy.title} | KZQ`,
    description: copy.description,
  });
}

function topicContactUrl(locale: Locale, topic: CatalogTopic): string {
  const params = new URLSearchParams({
    product: locale === "zh" ? topic.titleCn : topic.titleEn,
    source: "document-center",
    page_url: siteUrl(localePath(locale, "/documents")),
  });
  return `${localePath(locale, "/contact")}?${params.toString()}`;
}

function CatalogTopicCard({
  topic,
  asset,
  index,
  locale,
}: {
  topic: CatalogTopic;
  asset: ProductAsset | null;
  index: number;
  locale: Locale;
}) {
  const copy = pageCopy[locale];
  const title = locale === "zh" ? topic.titleCn : topic.titleEn;
  const subtitle = locale === "zh" ? topic.titleEn : topic.titleCn;
  const description = locale === "zh" ? topic.descriptionCn : topic.descriptionEn;
  const actionHref = asset ? "#published-documents" : topicContactUrl(locale, topic);

  return (
    <article className="card-base group overflow-hidden">
      <div className="relative aspect-[4/3] overflow-hidden bg-page p-5 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_12%,rgba(184,151,92,0.35),transparent_35%),linear-gradient(145deg,rgba(255,255,255,0.06),transparent_45%)]" />
        <div className="relative flex h-full flex-col justify-between">
          <div className="flex items-start justify-between gap-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.24em] text-gold-light">KZQ</span>
            <span className="text-[10px] tabular-nums text-white/40">{String(index + 1).padStart(2, "0")}</span>
          </div>
          <div>
            <p className="max-w-[15rem] text-lg font-semibold leading-tight md:text-xl">{title}</p>
            <p className="mt-2 line-clamp-1 text-[10px] uppercase tracking-[0.12em] text-white/45">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="p-4">
        <div className="flex min-h-5 items-center gap-2">
          {asset ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700">
              <CheckCircle2 className="h-3 w-3" />
              {copy.published}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-brass/10 px-2 py-1 text-[10px] font-medium text-gold-dark">
              <FileSearch className="h-3 w-3" />
              {copy.request}
            </span>
          )}
        </div>
        <p className="mt-3 min-h-10 text-xs leading-5 text-ink-soft">{description}</p>
        <Link
          href={actionHref}
          className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-industrial transition group-hover:text-gold-dark"
        >
          {asset ? copy.view : copy.request}
          {asset ? <BookOpen className="h-3.5 w-3.5" /> : <MessageCircle className="h-3.5 w-3.5" />}
        </Link>
      </div>
    </article>
  );
}

export async function DocumentsPageContent(locale: Locale) {
  const copy = pageCopy[locale];
  const assets = await getPublishedProductAssets(null);
  const publishedTopicCount = catalogTopics.filter((topic) => findCatalogTopicAsset(topic, assets)).length;
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
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brass/10 text-brass">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="text-xl font-semibold text-ink md:text-2xl">{locale === "zh" ? section.titleCn : section.titleEn}</h2>
                  <p className="mt-1 text-xs leading-5 text-ink-mute md:text-sm">{locale === "zh" ? section.descriptionCn : section.descriptionEn}</p>
                </div>
              </div>
              <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {topics.map((topic) => (
                  <div key={topic.id} id={topic.id} className="scroll-mt-24">
                    <CatalogTopicCard
                      topic={topic}
                      asset={findCatalogTopicAsset(topic, assets)}
                      index={catalogTopics.indexOf(topic)}
                      locale={locale}
                    />
                  </div>
                ))}
              </div>
            </ResponsiveContainer>
          </section>
        );
      })}

      <section id="published-documents" className="scroll-mt-24 py-9 md:py-14">
        <ResponsiveContainer>
          <div className="max-w-2xl">
            <h2 className="text-xl font-semibold text-ink md:text-2xl">{copy.publishedTitle}</h2>
            <p className="mt-2 text-xs leading-6 text-ink-mute md:text-sm">{copy.publishedDescription}</p>
          </div>
          {assets.length > 0 ? (
            <div className="mt-6">
              <ProductAssetList assets={assets} locale={locale} />
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-dashed border-ink-line bg-canvas-warm p-8 text-center">
              <p className="text-sm text-ink-soft">{copy.noPublished}</p>
              <Link href={localePath(locale, "/contact")} className="btn-primary mt-5 h-11 px-5 text-xs">
                <MessageCircle className="h-4 w-4" />
                {copy.request}
              </Link>
            </div>
          )}
          <p className="mt-5 text-xs leading-6 text-ink-mute">{copy.note}</p>
        </ResponsiveContainer>
      </section>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(collectionJsonLd) }} />
    </div>
  );
}
