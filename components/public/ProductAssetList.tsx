"use client";

import { useState } from "react";
import { ExternalLink, FileText } from "lucide-react";
import { localizeProductAsset } from "@/lib/i18n/content";
import type { Locale } from "@/lib/i18n/config";
import type { ProductAsset } from "@/types/database";
import {
  formatProductAssetSize,
  productAssetTypeLabels,
  ProductAssetViewer,
} from "./ProductAssetViewer";

export function ProductAssetList({
  assets,
  locale,
  title,
}: {
  assets: ProductAsset[];
  locale: Locale;
  title?: string;
}) {
  const [selected, setSelected] = useState<ProductAsset | null>(null);
  if (!assets.length) return null;

  return (
    <section>
      {title && <h2 className="text-lg font-semibold text-ink">{title}</h2>}
      <div className={title ? "mt-4 grid gap-3 md:grid-cols-2" : "grid gap-3 md:grid-cols-2"}>
        {assets.map((asset) => {
          const content = localizeProductAsset(asset, locale);
          return (
            <button
              key={asset.id}
              type="button"
              onClick={() => setSelected(asset)}
              className="card-base flex min-h-20 items-center gap-3 p-4 text-left transition hover:border-gold/50"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brass/10 text-brass">
                <FileText className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] uppercase tracking-wider text-gold-dark">
                  {productAssetTypeLabels[locale][asset.asset_type]}
                </span>
                <span className="mt-1 block truncate text-sm font-medium text-ink">{content.title}</span>
                <span className="mt-1 block text-[11px] text-ink-mute">
                  {[asset.mime_type, formatProductAssetSize(asset.file_size)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <ExternalLink className="h-4 w-4 shrink-0 text-ink-mute" />
            </button>
          );
        })}
      </div>
      {selected && <ProductAssetViewer asset={selected} locale={locale} onClose={() => setSelected(null)} />}
    </section>
  );
}
