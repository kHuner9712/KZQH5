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
  canPreviewAsset, deriveExtension, formatProductAssetSize, isImageAsset, isPdfAsset,
  isWeChatBrowser, validateAssetUrl,
} from "@/lib/client/viewer-utils";
import { PdfViewer } from "./PdfViewer";
import { ImageViewer } from "./ImageViewer";
import { ViewerError } from "./ViewerError";
import { useViewerDownload } from "./hooks/useViewerDownload";

export const productAssetTypeLabels = {
  zh: { catalog: "产品目录", datasheet: "技术资料", installation: "安装说明", certificate: "证书资料", packaging: "包装资料", other: "其他资料" },
  en: { catalog: "Catalog", datasheet: "Datasheet", installation: "Installation", certificate: "Certificate", packaging: "Packaging", other: "Other" },
} as const;

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

  const urlValidation = validateAssetUrl(asset.file_url);
  const urlIsValid = urlValidation.ok;
  const safeUrl = urlValidation.resolved || asset.file_url;

  // Derive the proper file extension for downloads.
  const downloadExt = useMemo(
    () => deriveExtension(asset.mime_type, asset.file_url),
    [asset.mime_type, asset.file_url],
  );

  // Use the shared download hook — no duplicate implementation.
  const runDownload = useViewerDownload();

  const download = useCallback(async () => {
    trackAnalyticsEvent({ event_name: "catalog_download", locale, product_id: asset.product_id });
    if (!urlIsValid) return;
    const result = await runDownload(safeUrl, content.title, downloadExt);
    if (result.status === "blocked") {
      alert(locale === "zh" ? "弹出窗口被拦截，请允许弹窗后重试。" : "Popup blocked. Please allow popups and try again.");
    } else if (result.status === "failed" || result.status === "invalid") {
      alert(locale === "zh" ? "下载失败，请稍后重试。" : "Download failed. Please try again later.");
    }
  }, [urlIsValid, safeUrl, content.title, downloadExt, runDownload, locale, asset.product_id]);

  /** Track "open in browser" — distinct from download so analytics can tell
   *  opening a new tab apart from downloading the file. */
  const trackOpenExternal = useCallback(() => {
    trackAnalyticsEvent({ event_name: "catalog_open_external", locale, product_id: asset.product_id });
  }, [locale, asset.product_id]);

  useDialogFocusTrap({ active: true, containerRef: dialogRef, onClose });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setIsWeChat(typeof navigator !== "undefined" && isWeChatBrowser(navigator.userAgent));
    document.body.style.overflow = "hidden";
    // Track viewer open as a distinct event from download. Previously the
    // mount effect sent `catalog_download`, which made every viewer open
    // look like a download in analytics.
    trackAnalyticsEvent({ event_name: "catalog_open", locale, product_id: asset.product_id });
    return () => {
      document.body.style.overflow = "";
      previouslyFocused?.focus();
    };
  }, [asset.product_id, locale]);

  const handleCopy = useCallback(async () => {
    if (await copyText(safeUrl)) {
      setCopied(true);
      // Track copy-link as a distinct event — previously this also fired
      // `catalog_download`, conflating two different user intents.
      trackAnalyticsEvent({ event_name: "catalog_copy_link", locale, product_id: asset.product_id });
    }
  }, [safeUrl, locale, asset.product_id]);

  // URL validation failure → show error with open/download disabled.
  if (!urlIsValid) {
    return (
      <ViewerShell ref={dialogRef} title={content.title} subtitle={labels.unsupported} onClose={onClose} locale={locale}>
        <ViewerError
          errorKind="unknown"
          locale={locale}
          url={safeUrl}
          urlValid={false}
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
          <a href={safeUrl} target="_blank" rel="noopener noreferrer" onClick={trackOpenExternal} className="hidden h-9 items-center gap-1.5 rounded-full px-3 text-xs text-white/70 hover:bg-white/10 sm:flex" aria-label={labels.open}>
            <ExternalLink className="h-4 w-4" /><span>{labels.open}</span>
          </a>
        </>
      }
    >
      {isPdf ? (
        <PdfViewer url={safeUrl} locale={locale} isWeChat={isWeChat} onClose={onClose} onDownload={download} />
      ) : isImage ? (
        <ImageViewer url={safeUrl} locale={locale} onClose={onClose} onDownload={download} />
      ) : (
        <ViewerError
          errorKind="unsupported_mime"
          locale={locale}
          url={safeUrl}
          urlValid
          isWeChat={isWeChat}
          onRetry={onClose}
          onClose={onClose}
          onDownload={download}
        />
      )}
    </ViewerShell>
  );
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
          data-testid="viewer-close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
});
