"use client";

import Link from "next/link";
import { useState } from "react";
import { BookOpen, CheckCircle2, FileSearch, MessageCircle } from "lucide-react";
import type { CatalogTopic } from "@/lib/catalog-topics";
import type { Locale } from "@/lib/i18n/config";
import type { ProductAsset } from "@/types/database";
import { ProductAssetViewer } from "./ProductAssetViewer";

export interface CatalogTopicGridItem {
  topic: CatalogTopic;
  asset: ProductAsset | null;
  index: number;
  contactHref: string;
}

const copy = {
  zh: {
    published: "已发布",
    view: "在线查看",
    request: "联系销售获取",
    date: "发布日期",
  },
  en: {
    published: "Published",
    view: "View online",
    request: "Request from sales",
    date: "Published",
  },
} as const;

function CardCover({ item, locale }: { item: CatalogTopicGridItem; locale: Locale }) {
  const title = locale === "zh" ? item.topic.titleCn : item.topic.titleEn;
  const subtitle = locale === "zh" ? item.topic.titleEn : item.topic.titleCn;
  const cover = item.asset?.cover_image_url;

  return (
    <div
      className="relative aspect-[4/3] overflow-hidden bg-page p-5 text-white"
      style={cover ? { backgroundImage: `linear-gradient(rgba(13,15,16,.42),rgba(13,15,16,.72)),url(${cover})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
    >
      {!cover && <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_12%,rgba(184,151,92,0.35),transparent_35%),linear-gradient(145deg,rgba(255,255,255,0.06),transparent_45%)]" />}
      <div className="relative flex h-full flex-col justify-between">
        <div className="flex items-start justify-between gap-3">
          <span className="text-[10px] font-medium uppercase tracking-[0.24em] text-gold-light">KZQ</span>
          <span className="text-[10px] tabular-nums text-white/55">{String(item.index + 1).padStart(2, "0")}</span>
        </div>
        <div>
          <p className="max-w-[15rem] text-lg font-semibold leading-tight md:text-xl">{title}</p>
          <p className="mt-2 line-clamp-1 text-[10px] uppercase tracking-[0.12em] text-white/60">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}

export function CatalogTopicGrid({ items, locale }: { items: CatalogTopicGridItem[]; locale: Locale }) {
  const [selected, setSelected] = useState<ProductAsset | null>(null);
  const labels = copy[locale];

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => {
          const description = locale === "zh" ? item.topic.descriptionCn : item.topic.descriptionEn;
          const cardBody = (
            <>
              <CardCover item={item} locale={locale} />
              <div className="p-4">
                <div className="flex min-h-5 items-center gap-2">
                  {item.asset ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700">
                      <CheckCircle2 className="h-3 w-3" />
                      {labels.published}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-brass/10 px-2 py-1 text-[10px] font-medium text-gold-dark">
                      <FileSearch className="h-3 w-3" />
                      {labels.request}
                    </span>
                  )}
                </div>
                <p className="mt-3 min-h-10 text-xs leading-5 text-ink-soft">{description}</p>
                {item.asset?.published_at && (
                  <p className="mt-2 text-[10px] text-ink-mute">{labels.date}: {item.asset.published_at}</p>
                )}
                <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-industrial transition group-hover:text-gold-dark">
                  {item.asset ? labels.view : labels.request}
                  {item.asset ? <BookOpen className="h-3.5 w-3.5" /> : <MessageCircle className="h-3.5 w-3.5" />}
                </span>
              </div>
            </>
          );

          return (
            <article key={item.topic.id} id={item.topic.id} className="card-base group scroll-mt-24 overflow-hidden">
              {item.asset ? (
                <button
                  type="button"
                  onClick={() => setSelected(item.asset)}
                  className="block w-full text-left"
                  data-testid={`catalog-topic-${item.topic.id}`}
                >
                  {cardBody}
                </button>
              ) : (
                <Link href={item.contactHref} className="block" data-testid={`catalog-topic-${item.topic.id}`}>
                  {cardBody}
                </Link>
              )}
            </article>
          );
        })}
      </div>
      {selected && <ProductAssetViewer asset={selected} locale={locale} onClose={() => setSelected(null)} />}
    </>
  );
}
