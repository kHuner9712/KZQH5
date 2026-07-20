"use client";

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink, X } from "lucide-react";
import type { Locale } from "@/lib/i18n/config";
import type { ProductAsset } from "@/types/database";
import { localizeProductAsset } from "@/lib/i18n/content";
import { copyText } from "@/lib/client/copy-text";
import { trackAnalyticsEvent } from "@/lib/client/analytics";
import { useDialogFocusTrap } from "@/lib/client/use-dialog-focus-trap";
import {
  canPreviewAsset, formatProductAssetSize, isImageAsset, isPdfAsset,
  isWeChatBrowser, sanitizeFilename, validateAssetUrl,
} from "@/lib/client/viewer-utils";
import { PdfViewer } from "./PdfViewer";
import { ImageViewer } from "./ImageViewer";
import { ViewerError } from "./ViewerError";

export const productAssetTypeLabels = {
  zh: { catalog: "产品目录", datasheet: "技术资料", installation: "安装说明", certificate: "证书资料", packaging: "包装资料", other: "其他资料" },
  en: { catalog: "Catalog", datasheet: "Datasheet", installation: "Installation", certificate: "Certificate", packaging: "Packaging", other: "Other" },
} as const;

// Re-export for backward-compatible imports from ProductAssetList etc.
export { canPreviewAsset as canPreviewProductAsset, formatProductAssetSize };

const toolbarCopy = {
  zh: { close: "关闭", download: "下载", copy: "复制链接", copied: "已复制", open: "在新窗口打开", unsupported: "不支持在线预览该文件类型，请下载或在浏览器中打开。" },
  en: { close: "Close", download: "Download", copy: "Copy link", copied: "Copied", open: "Open in browser", unsupported: "This file type cannot be previewed online. Download or open in a browser." },
} as const;

export function ProductAssetViewer({
  asset,
  locale,
  onClose,
}: {
  asset: ProductAsset;
  locale: Locale;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [isWeChat, setIsWeChat] = useState(false);
  const labels = toolbarCopy[locale];
  const content = useMemo(() => localizeProductAsset(asset, locale), [asset, locale]);

  useDialogFocusTrap({ active: true, containerRef: dialogRef, onClose });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setIsWeChat(typeof navigator !== "undefined" && isWeChatBrowser(navigator.userAgent));
    document.body.style.overflow = "hidden";
    // Analytics: all viewer interactions map to the existing `catalog_download`
    // event (the DB enum does not yet have dedicated PDF events; see
    // docs/CATALOG_CENTER.md for the mapping table).
    trackAnalyticsEvent({ event_name: "catalog_download", locale, product_id: asset.product_id });
    return () => {
      document.body.style.overflow = "";
      previouslyFocused?.focus();
    };
  }, [asset.product_id, locale]);

  const urlValidation = validateAssetUrl(asset.file_url);
  const safeUrl = urlValidation.resolved || asset.file_url;

  const download = useViewerDownloadCallback(asset, content.title, safeUrl, locale);

  const handleCopy = useCallback(async () => {
    if (await copyText(safeUrl)) {
      setCopied(true);
      trackAnalyticsEvent({ event_name: "catalog_download", locale, product_id: asset.product_id });
    }
  }, [safeUrl, locale, asset.product_id]);

  // URL validation failure → show error.
  if (!urlValidation.ok) {
    return (
      <ViewerShell ref={dialogRef} title={content.title} subtitle={labels.unsupported} onClose={onClose} locale={locale}>
        <ViewerError
          errorKind="unknown"
          locale={locale}
          url={asset.file_url}
          isWeChat={isWeChat}
          onRetry={onClose}
          onClose={onClose}
          onDownload={download}
        />
      </ViewerShell>
    );
  }

  const isPdf = isPdfAsset(asset);
  const isImage = isImageAsset(asset);

  return (
    <ViewerShell
      ref={dialogRef}
      title={content.title}
      subtitle={[productAssetTypeLabels[locale][asset.asset_type], formatProductAssetSize(asset.file_size)].filter(Boolean).join(" · ")}
      onClose={onClose}
      locale={locale}
      actions={
        <>
          <button type="button" onClick={download} className="hidden h-9 items-center gap-1.5 rounded-full px-3 text-xs text-white/70 hover:bg-white/10 sm:flex" aria-label={labels.download}>
            <Download className="h-4 w-4" /><span>{labels.download}</span>
          </button>
          <button type="button" onClick={handleCopy} className="hidden h-9 items-center gap-1.5 rounded-full px-3 text-xs text-white/70 hover:bg-white/10 sm:flex" aria-label={labels.copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span>{copied ? labels.copied : labels.copy}</span>
          </button>
          <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="hidden h-9 items-center gap-1.5 rounded-full px-3 text-xs text-white/70 hover:bg-white/10 sm:flex" aria-label={labels.open}>
            <ExternalLink className="h-4 w-4" /><span>{labels.open}</span>
          </a>
        </>
      }
    >
      {isPdf ? (
        <PdfViewer url={safeUrl} locale={locale} isWeChat={isWeChat} onClose={onClose} onDownload={download} />
      ) : isImage ? (
        <ImageViewer url={safeUrl} locale={locale} />
      ) : (
        <ViewerError
          errorKind="unsupported_mime"
          locale={locale}
          url={safeUrl}
          isWeChat={isWeChat}
          onRetry={onClose}
          onClose={onClose}
          onDownload={download}
        />
      )}
    </ViewerShell>
  );
}

// --- Download helper hook ---
function useViewerDownloadCallback(asset: ProductAsset, title: string, url: string, locale: Locale) {
  return useCallback(async () => {
    trackAnalyticsEvent({ event_name: "catalog_download", locale, product_id: asset.product_id });
    const ext = isPdfAsset(asset) ? ".pdf" : isImageAsset(asset) ? "" : ".bin";
    // Use the inline fetch-based download with fallback.
    const validation = validateAssetUrl(url);
    if (!validation.ok || !validation.resolved) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      const response = await fetch(validation.resolved, { mode: "cors", credentials: "same-origin" });
      if (response.ok) {
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = sanitizeFilename(title, "document", ext);
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
        return;
      }
    } catch {
      // fall through
    }
    // Fallback: anchor click or new window.
    const link = document.createElement("a");
    link.href = validation.resolved;
    link.download = sanitizeFilename(title, "document", ext);
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [asset, title, url, locale]);
}

// --- Dialog shell with toolbar ---

const ViewerShell = forwardRef<
  HTMLDivElement,
  {
    title: string;
    subtitle?: string;
    onClose: () => void;
    locale: Locale;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }
>(function ViewerShell({ title, subtitle, onClose, locale, actions, children }, ref) {
  const closeLabel = locale === "zh" ? "关闭" : "Close";
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-dialog-autofocus
      className="fixed inset-0 z-[80] flex flex-col bg-page/98"
      style={{ height: "100dvh" }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Top toolbar */}
      <div className="safe-top flex h-14 shrink-0 items-center gap-2 border-b border-white/10 bg-page/95 px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{title}</p>
          {subtitle && <p className="mt-0.5 truncate text-[10px] text-white/40">{subtitle}</p>}
        </div>
        {actions}
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          aria-label={closeLabel}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      {/* Content */}
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
});
