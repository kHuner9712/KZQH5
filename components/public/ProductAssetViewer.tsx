"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import { copyText } from "@/lib/client/copy-text";
import { trackAnalyticsEvent } from "@/lib/client/analytics";
import { useDialogFocusTrap } from "@/lib/client/use-dialog-focus-trap";
import { localizeProductAsset } from "@/lib/i18n/content";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/config";
import type { ProductAsset } from "@/types/database";

export const productAssetTypeLabels = {
  zh: { catalog: "产品目录", datasheet: "技术资料", installation: "安装说明", certificate: "证书资料", packaging: "包装资料", other: "其他资料" },
  en: { catalog: "Catalog", datasheet: "Datasheet", installation: "Installation", certificate: "Certificate", packaging: "Packaging", other: "Other" },
} as const;

export function formatProductAssetSize(size: number | null): string | null {
  if (size === null) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function canPreviewProductAsset(asset: ProductAsset): boolean {
  return asset.mime_type === "application/pdf"
    || Boolean(asset.mime_type?.startsWith("image/"))
    || /\.(pdf|png|jpe?g|webp|svg)(?:[?#].*)?$/i.test(asset.file_url);
}

export function ProductAssetViewer({
  asset,
  locale,
  onClose,
}: {
  asset: ProductAsset;
  locale: Locale;
  onClose: () => void;
}) {
  const copy = getDictionary(locale).assets;
  const [isWeChat, setIsWeChat] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap({ active: true, containerRef: dialogRef, onClose });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setIsWeChat(/MicroMessenger/i.test(navigator.userAgent));
    document.body.style.overflow = "hidden";
    trackAnalyticsEvent({ event_name: "catalog_download", locale, product_id: asset.product_id });
    return () => {
      document.body.style.overflow = "";
      previouslyFocused?.focus();
    };
  }, [asset.product_id, locale]);

  const content = localizeProductAsset(asset, locale);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-[80] flex flex-col bg-page/98"
      role="dialog"
      aria-modal="true"
      aria-label={content.title}
    >
      <div className="safe-top flex min-h-16 items-center gap-3 border-b border-white/10 px-4 text-white">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{content.title}</p>
          <p className="mt-0.5 text-[10px] text-white/50">
            {productAssetTypeLabels[locale][asset.asset_type]} · {copy.complete}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10"
          aria-label={locale === "zh" ? "关闭" : "Close"}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-3 md:p-6">
        {isWeChat && (
          <div className="mb-3 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold-light">
            {copy.wechat}
          </div>
        )}
        {canPreviewProductAsset(asset) ? (
          <iframe
            src={asset.file_url}
            title={content.title}
            className="min-h-0 flex-1 rounded-lg border border-white/10 bg-white"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-white/10 bg-surface p-8 text-center text-sm text-white/70">
            {copy.fallback}
          </div>
        )}
        <p className="mt-3 text-center text-xs text-white/50">{copy.fallback}</p>
        <div className="mt-3 flex flex-col justify-center gap-2 sm:flex-row">
          <a href={asset.file_url} target="_blank" rel="noreferrer" className="btn-primary h-11 px-5">
            <ExternalLink className="h-4 w-4" />
            {copy.open}
          </a>
          <button
            type="button"
            onClick={async () => {
              if (await copyText(asset.file_url)) setCopied(true);
            }}
            className="btn-outline h-11 border-white/20 px-5 text-white"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? copy.copied : copy.copy}
          </button>
        </div>
      </div>
    </div>
  );
}
