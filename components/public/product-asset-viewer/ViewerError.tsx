"use client";

import { AlertCircle, Copy, Check, Download, ExternalLink, RotateCw, X } from "lucide-react";
import { useState } from "react";
import type { Locale } from "@/lib/i18n/config";
import { copyText } from "@/lib/client/copy-text";
import { viewerErrorMessage, type ViewerErrorKind } from "@/lib/client/viewer-utils";

const copy = {
  zh: {
    retry: "重试",
    open: "在新窗口打开",
    download: "下载文件",
    copyLink: "复制链接",
    copied: "已复制",
    close: "关闭",
    wechatHint: "微信内可能无法直接预览，请点击右上角菜单选择「在浏览器中打开」。",
  },
  en: {
    retry: "Retry",
    open: "Open in browser",
    download: "Download",
    copyLink: "Copy link",
    copied: "Copied",
    close: "Close",
    wechatHint: "WeChat may block previews. Tap the top-right menu and choose “Open in browser”.",
  },
} as const;

export interface ViewerErrorProps {
  errorKind: ViewerErrorKind;
  locale: Locale;
  url: string;
  isWeChat: boolean;
  onRetry: () => void;
  onClose: () => void;
  onDownload: () => void;
}

export function ViewerError({
  errorKind,
  locale,
  url,
  isWeChat,
  onRetry,
  onClose,
  onDownload,
}: ViewerErrorProps) {
  const [copied, setCopied] = useState(false);
  const labels = copy[locale];
  const message = viewerErrorMessage(errorKind, locale);

  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
      role="alert"
      aria-live="assertive"
    >
      <AlertCircle className="h-10 w-10 text-gold-light" />
      <p className="max-w-sm text-sm leading-6 text-white/80">{message}</p>

      {isWeChat && (
        <p className="max-w-sm rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold-light">
          {labels.wechatHint}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {errorKind !== "password" && errorKind !== "unsupported_mime" && (
          <button
            type="button"
            onClick={onRetry}
            className="btn-primary h-10 px-4 text-xs"
          >
            <RotateCw className="h-3.5 w-3.5" />
            {labels.retry}
          </button>
        )}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-outline h-10 border-white/20 px-4 text-xs text-white"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {labels.open}
        </a>
        <button
          type="button"
          onClick={onDownload}
          className="btn-outline h-10 border-white/20 px-4 text-xs text-white"
        >
          <Download className="h-3.5 w-3.5" />
          {labels.download}
        </button>
        <button
          type="button"
          onClick={async () => {
            if (await copyText(url)) setCopied(true);
          }}
          className="btn-outline h-10 border-white/20 px-4 text-xs text-white"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? labels.copied : labels.copyLink}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="btn-outline h-10 border-white/20 px-4 text-xs text-white"
          aria-label={labels.close}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
