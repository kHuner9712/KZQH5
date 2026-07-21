"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Check, Copy, Download, ExternalLink, Minus, Plus, RotateCw } from "lucide-react";
import type { Locale } from "@/lib/i18n/config";
import { snapZoom, ZOOM_MIN, ZOOM_MAX, type ViewerErrorKind } from "@/lib/client/viewer-utils";
import { copyText } from "@/lib/client/copy-text";
import { trackAnalyticsEvent } from "@/lib/client/analytics";
import { ViewerError } from "./ViewerError";
import { ViewerLoading } from "./ViewerLoading";

const copy = {
  zh: { zoomIn: "放大", zoomOut: "缩小", rotate: "旋转" },
  en: { zoomIn: "Zoom in", zoomOut: "Zoom out", rotate: "Rotate" },
} as const;

type ImageStatus = "loading" | "ready" | "error";

/**
 * ImageViewer — full state machine for inline image preview.
 *
 * States:
 *   - loading: <img> is loading (onLoad not yet fired). Shows a spinner.
 *   - ready:   onLoad fired successfully. Image is interactive (zoom/rotate).
 *   - error:   onError fired (404, non-image, decode failure, CORS). Shows
 *              the shared ViewerError UI with retry, open-in-browser, copy
 *              link, download, and close actions. The previous image is
 *              removed so no broken-image icon or stale frame is left.
 *
 * Switching the `url` resets state back to "loading" and remounts the
 * <img> via the `key` prop — this guarantees onLoad/onError fire for the
 * new src even when the browser serves it from cache.
 */
export function ImageViewer({
  url,
  locale,
  onClose,
  onDownload,
}: {
  url: string;
  locale: Locale;
  onClose: () => void;
  onDownload: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [status, setStatus] = useState<ImageStatus>("loading");
  const [errorKind, setErrorKind] = useState<ViewerErrorKind>("unknown");
  const [loadToken, setLoadToken] = useState(0);
  const [copied, setCopied] = useState(false);

  const zoomIn = useCallback(() => setScale((s) => snapZoom(s + 0.25)), []);
  const zoomOut = useCallback(() => setScale((s) => snapZoom(s - 0.25)), []);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

  const retry = useCallback(() => {
    // Bump the loadToken so a new <img> element is mounted (via `key`).
    // This forces the browser to re-request the src, bypassing any cached
    // error response and giving onError another chance to fire.
    setStatus("loading");
    setErrorKind("unknown");
    setLoadToken((t) => t + 1);
  }, []);

  // Reset zoom/rotation/loading state when the URL changes.
  useEffect(() => {
    setScale(1);
    setRotation(0);
    setStatus("loading");
    setErrorKind("unknown");
    setLoadToken((t) => t + 1);
  }, [url]);

  const handleCopy = useCallback(async () => {
    if (await copyText(url)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }, [url]);

  // Error state: no stale image, full recovery options.
  if (status === "error") {
    return (
      <ViewerError
        errorKind={errorKind}
        locale={locale}
        url={url}
        urlValid
        isWeChat={false}
        onRetry={retry}
        onClose={onClose}
        onDownload={onDownload}
      />
    );
  }

  // Loading AND ready states share the same layout — the <img> must always
  // be mounted in the DOM so onLoad/onError can fire. Without this, the
  // state machine gets stuck in "loading" forever (onLoad never fires if
  // <img> is not in the DOM). During loading we overlay the spinner on top
  // of the (still blank) image area; once onLoad fires the overlay
  // disappears and the image becomes interactive.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/30"
      >
        <img
          key={`${url}-${loadToken}`}
          src={url}
          alt=""
          className="max-h-full max-w-full select-none object-contain transition-transform duration-200"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            transformOrigin: "center center",
          }}
          onLoad={() => {
            setStatus("ready");
            trackAnalyticsEvent({ event_name: "catalog_load_success", locale });
          }}
          onError={() => {
            setErrorKind("unknown");
            setStatus("error");
            trackAnalyticsEvent({ event_name: "catalog_load_failure", locale });
          }}
          draggable={false}
        />
        {status === "loading" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <ViewerLoading locale={locale} />
          </div>
        )}
      </div>
      <ZoomControls
        locale={locale}
        scale={scale}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
        rotate={rotate}
        disabled={status !== "ready"}
      />
      {/* Floating copy-link / open-external actions — only when ready. */}
      {status === "ready" && (
        <div className="pointer-events-auto absolute right-3 top-3 flex items-center gap-1 rounded-full border border-white/15 bg-page/90 px-1.5 py-1 shadow-lg">
          <button
            type="button"
            onClick={handleCopy}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 hover:bg-white/10"
            aria-label={locale === "zh" ? "复制链接" : "Copy link"}
            data-testid="image-copy-link"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 hover:bg-white/10"
            aria-label={locale === "zh" ? "在新窗口打开" : "Open in browser"}
            data-testid="image-open-external"
            onClick={() => trackAnalyticsEvent({ event_name: "catalog_open_external", locale })}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <button
            type="button"
            onClick={onDownload}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 hover:bg-white/10"
            aria-label={locale === "zh" ? "下载" : "Download"}
            data-testid="image-download"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function ZoomControls({
  locale,
  scale,
  zoomIn,
  zoomOut,
  rotate,
  disabled,
}: {
  locale: Locale;
  scale: number;
  zoomIn: () => void;
  zoomOut: () => void;
  rotate: () => void;
  disabled?: boolean;
}) {
  const labels = copy[locale];
  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-page/90 px-2 py-1 shadow-lg safe-bottom">
      <button
        type="button"
        onClick={zoomOut}
        disabled={disabled || scale <= ZOOM_MIN}
        className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/10 disabled:opacity-30"
        aria-label={labels.zoomOut}
      >
        <Minus className="h-4 w-4" />
      </button>
      <span className="min-w-[3rem] text-center text-xs tabular-nums text-white/60">
        {Math.round(scale * 100)}%
      </span>
      <button
        type="button"
        onClick={zoomIn}
        disabled={disabled || scale >= ZOOM_MAX}
        className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/10 disabled:opacity-30"
        aria-label={labels.zoomIn}
      >
        <Plus className="h-4 w-4" />
      </button>
      <div className="mx-1 h-5 w-px bg-white/15" />
      <button
        type="button"
        onClick={rotate}
        disabled={disabled}
        className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/10 disabled:opacity-30"
        aria-label={labels.rotate}
      >
        <RotateCw className="h-4 w-4" />
      </button>
    </div>
  );
}
