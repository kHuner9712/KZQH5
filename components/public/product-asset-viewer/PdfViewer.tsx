"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Maximize, Minimize,
  Minus, Plus, RotateCw, Scan, ScanLine,
} from "lucide-react";
import type { Locale } from "@/lib/i18n/config";
import {
  clampPage, clampZoom, snapZoom, ZOOM_MIN, ZOOM_MAX,
} from "@/lib/client/viewer-utils";
import { trackAnalyticsEvent } from "@/lib/client/analytics";
import { usePdfDocument, type PdfPageProxy, type PdfDocumentProxy } from "./hooks/usePdfDocument";
import { useViewerKeyboard } from "./hooks/useViewerKeyboard";
import { ViewerLoading } from "./ViewerLoading";
import { ViewerError } from "./ViewerError";

const copy = {
  zh: {
    page: "页", of: "共", jumpTo: "跳转到页", prev: "上一页", next: "下一页",
    zoomIn: "放大", zoomOut: "缩小", rotate: "旋转", fitWidth: "适应宽度",
    fitPage: "适应页面", fullscreen: "全屏", exitFullscreen: "退出全屏",
    loadingPage: "渲染页面…",
    renderError: "该页渲染失败。请重试或在新窗口中打开原文件。",
    retryPage: "重试当前页",
  },
  en: {
    page: "Page", of: "of", jumpTo: "Jump to page", prev: "Previous", next: "Next",
    zoomIn: "Zoom in", zoomOut: "Zoom out", rotate: "Rotate", fitWidth: "Fit width",
    fitPage: "Fit page", fullscreen: "Fullscreen", exitFullscreen: "Exit fullscreen",
    loadingPage: "Rendering page…",
    renderError: "This page failed to render. Retry or open the original file in a browser.",
    retryPage: "Retry page",
  },
} as const;

type FitMode = "width" | "page" | "manual";

/**
 * Per-page render state machine. The canvas render call can fail (e.g.
 * pdf.js RenderingCancelledException on rapid page switches, OOM on huge
 * pages, malformed font streams). When it fails we surface a real error UI
 * with retry + open-in-browser — not just a console.error.
 */
type PageRenderState = "idle" | "rendering" | "ready" | "error";

export function PdfViewer({
  url,
  locale,
  isWeChat,
  onClose,
  onDownload,
}: {
  url: string;
  locale: Locale;
  isWeChat: boolean;
  onClose: () => void;
  onDownload: () => void;
}) {
  const { state, retry } = usePdfDocument(url, locale);
  const labels = copy[locale];

  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [fitMode, setFitMode] = useState<FitMode>("width");
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Page render state machine — surfaces render failures as a real UI state.
  const [pageRender, setPageRender] = useState<PageRenderState>("idle");
  // Per-page render attempt counter — bumping it forces the render effect to
  // re-run, which is what "Retry page" needs.
  const [pageRenderToken, setPageRenderToken] = useState(0);
  // Container size state — updated by ResizeObserver. Changing this triggers
  // a proper re-render (not a setState(v=>v) no-op) so fit calculations rerun.
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentRender = useRef<{ cancel: () => void } | null>(null);

  const doc = state.document;
  const pageCount = state.pageCount;
  const isReady = state.status === "ready" && Boolean(doc);

  // Reset page when a new document loads.
  useEffect(() => {
    if (state.status === "ready") {
      setCurrentPage(1);
      setScale(1);
      setRotation(0);
      setFitMode("width");
      setPageRender("idle");
      setPageRenderToken((t) => t + 1);
      // Document-level load success — distinct from page render success.
      // This fires once per document load (not per page render).
      trackAnalyticsEvent({ event_name: "catalog_load_success", locale });
    }
  }, [state.status, locale]);

  // Track document-level load failure. Fires once when the PDF load
  // transitions into the error state (timeout / network / 404 / parse).
  // Page render failures are NOT counted here — they have their own UI.
  const trackedLoadFailure = useRef(false);
  useEffect(() => {
    if (state.status === "error") {
      if (!trackedLoadFailure.current) {
        trackedLoadFailure.current = true;
        trackAnalyticsEvent({ event_name: "catalog_load_failure", locale });
      }
    } else if (state.status === "loading") {
      // Reset on retry — allow a fresh failure event if the retry also fails.
      trackedLoadFailure.current = false;
    }
  }, [state.status, locale]);

  // Track container size for fit calculations. This replaces the old
  // setFitMode((m) => m) no-op with a proper state update.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        setContainerSize((prev) => {
          // Only update when dimensions actually change (avoids loops).
          if (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return prev;
          return { width, height };
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Compute the effective scale for fit modes.
  const computeFitScale = useCallback(
    (page: PdfPageProxy): number => {
      if (fitMode === "manual") return scale;
      const containerW = containerSize.width || 800;
      const containerH = (containerSize.height || 600) - 16;
      const viewport = page.getViewport({ scale: 1, rotation });
      if (fitMode === "width") {
        return clampZoom(containerW / viewport.width);
      }
      // fit page
      return clampZoom(Math.min(containerW / viewport.width, containerH / viewport.height));
    },
    [fitMode, scale, rotation, containerSize.width, containerSize.height],
  );

  // Render the current page to canvas.
  useEffect(() => {
    if (!isReady || !doc) return;
    let cancelled = false;
    const canvas = canvasRef.current;

    const renderPage = async () => {
      try {
        setPageRender("rendering");
        const page = await doc.getPage(currentPage);
        if (cancelled) return;

        const effectiveScale = computeFitScale(page);
        const viewport = page.getViewport({ scale: effectiveScale, rotation });

        if (!canvas) {
          // No canvas mounted — the viewer is in error UI mode. Reset state.
          setPageRender("idle");
          return;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          // Canvas 2D context unavailable (rare). Surface as error.
          setPageRender("error");
          return;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        currentRender.current?.cancel();

        const renderTask = page.render({
          canvasContext: ctx,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          viewport,
        });
        currentRender.current = renderTask;

        await renderTask.promise;
        if (cancelled) return;
        setPageRender("ready");
        if (fitMode !== "manual") {
          setScale(effectiveScale);
        }
      } catch (err) {
        if (cancelled) {
          // Cancelled by the next render — don't touch state.
          return;
        }
        // Cancelled errors are expected on rapid page switches; don't surface
        // them as failures.
        const msg = err instanceof Error ? err.message : String(err);
        if (/cancel/i.test(msg)) {
          setPageRender("idle");
          return;
        }
        // Real render failure — surface it so the user can retry or open
        // the original file. Don't leave a half-drawn canvas on screen.
        if (canvas) {
          const ctx = canvas.getContext("2d");
          ctx?.clearRect(0, 0, canvas.width, canvas.height);
        }
        // eslint-disable-next-line no-console
        console.error("[PdfViewer] page render failed:", err);
        setPageRender("error");
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
      currentRender.current?.cancel();
    };
  }, [doc, currentPage, rotation, fitMode, computeFitScale, isReady, containerSize.width, containerSize.height, pageRenderToken]);

  // Fullscreen handling.
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    if (!document.fullscreenElement) {
      void el.requestFullscreen?.().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      void document.exitFullscreen?.().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Touch swipe for page navigation.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  }, []);
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    const start = touchStart.current;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx > 0) setCurrentPage((p) => clampPage(p - 1, pageCount));
      else setCurrentPage((p) => clampPage(p + 1, pageCount));
    }
    touchStart.current = null;
  }, [pageCount]);

  // --- Action handlers (stable refs for keyboard hook) ---
  const prevPage = useCallback(() => setCurrentPage((p) => clampPage(p - 1, pageCount)), [pageCount]);
  const nextPage = useCallback(() => setCurrentPage((p) => clampPage(p + 1, pageCount)), [pageCount]);
  const firstPage = useCallback(() => setCurrentPage(1), []);
  const lastPage = useCallback(() => setCurrentPage(clampPage(Infinity, pageCount)), [pageCount]);
  const retryPage = useCallback(() => {
    setPageRender("idle");
    setPageRenderToken((t) => t + 1);
  }, []);
  const zoomIn = useCallback(() => { setFitMode("manual"); setScale((s) => snapZoom(s + 0.25)); }, []);
  const zoomOut = useCallback(() => { setFitMode("manual"); setScale((s) => snapZoom(s - 0.25)); }, []);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);
  const fitToggle = useCallback(() => {
    setFitMode((m) => (m === "width" ? "page" : m === "page" ? "manual" : "width"));
  }, []);

  // Wire up keyboard shortcuts (only when the document is ready).
  useViewerKeyboard({
    enabled: isReady,
    onPrevPage: prevPage,
    onNextPage: nextPage,
    onFirstPage: firstPage,
    onLastPage: lastPage,
    onZoomIn: zoomIn,
    onZoomOut: zoomOut,
    onFitToggle: fitToggle,
    onRotate: rotate,
    onClose,
  });

  // --- State-driven UI ---
  if (state.status === "loading") return <ViewerLoading locale={locale} />;
  if (state.status === "error" && state.errorKind) {
    return (
      <ViewerError
        errorKind={state.errorKind}
        locale={locale}
        url={url}
        urlValid
        isWeChat={isWeChat}
        onRetry={retry}
        onClose={onClose}
        onDownload={onDownload}
      />
    );
  }
  if (!isReady) return <ViewerLoading locale={locale} />;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Canvas area */}
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-black/30 safe-top"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <canvas
          ref={canvasRef}
          className="block shadow-2xl"
          aria-label={`${labels.page} ${currentPage} ${labels.of} ${pageCount}`}
          role="img"
        />
        {pageRender === "rendering" && (
          <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-page/80 px-3 py-1 text-[10px] text-white/60" aria-live="polite" data-testid="pdf-page-rendering">
            {labels.loadingPage}
          </div>
        )}
        {pageRender === "error" && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-page/80 p-6 text-center"
            role="alert"
            aria-live="assertive"
            data-testid="pdf-page-render-error"
          >
            <p className="max-w-md text-sm leading-6 text-white/85">{labels.renderError}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button type="button" onClick={retryPage} className="btn-primary h-10 px-4 text-xs" data-testid="pdf-retry-page">
                {labels.retryPage}
              </button>
              <a href={url} target="_blank" rel="noopener noreferrer" className="btn-outline h-10 border-white/20 px-4 text-xs text-white">
                {locale === "zh" ? "在新窗口打开" : "Open in browser"}
              </a>
              <button type="button" onClick={onDownload} className="btn-outline h-10 border-white/20 px-4 text-xs text-white">
                {locale === "zh" ? "下载文件" : "Download"}
              </button>
            </div>
          </div>
        )}

        {/* Floating zoom/rotate/fit controls — inside the canvas container so
            they never overlap the bottom page navigation bar. */}
        <div className="pointer-events-auto absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-white/15 bg-page/90 px-1.5 py-1 shadow-lg">
          <CtrlBtn label={labels.zoomOut} onClick={zoomOut} disabled={scale <= ZOOM_MIN} data-testid="pdf-zoom-out">
            <Minus className="h-4 w-4" />
          </CtrlBtn>
          <span className="min-w-[3rem] text-center text-[11px] tabular-nums text-white/60">
            {Math.round(scale * 100)}%
          </span>
          <CtrlBtn label={labels.zoomIn} onClick={zoomIn} disabled={scale >= ZOOM_MAX} data-testid="pdf-zoom-in">
            <Plus className="h-4 w-4" />
          </CtrlBtn>
          <div className="mx-0.5 h-5 w-px bg-white/15" />
          <CtrlBtn label={labels.fitWidth} onClick={() => setFitMode("width")} active={fitMode === "width"} data-testid="pdf-fit-width">
            <ScanLine className="h-4 w-4" />
          </CtrlBtn>
          <CtrlBtn label={labels.fitPage} onClick={() => setFitMode("page")} active={fitMode === "page"} data-testid="pdf-fit-page">
            <Scan className="h-4 w-4" />
          </CtrlBtn>
          <CtrlBtn label={labels.rotate} onClick={rotate} data-testid="pdf-rotate">
            <RotateCw className="h-4 w-4" />
          </CtrlBtn>
          <CtrlBtn label={isFullscreen ? labels.exitFullscreen : labels.fullscreen} onClick={toggleFullscreen} data-testid="pdf-fullscreen">
            {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </CtrlBtn>
        </div>
      </div>

      {/* Bottom page navigation bar */}
      <div className="safe-bottom flex h-14 shrink-0 items-center justify-center gap-2 border-t border-white/10 bg-page/95 px-3">
        <CtrlBtn label={labels.prev} onClick={prevPage} disabled={currentPage <= 1} large data-testid="pdf-prev-page">
          <ChevronLeft className="h-5 w-5" />
        </CtrlBtn>
        <div className="flex items-center gap-1.5 text-xs text-white/70">
          <input
            type="number"
            min={1}
            max={pageCount}
            value={currentPage}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) setCurrentPage(clampPage(v, pageCount));
            }}
            className="h-9 w-14 rounded-md border border-white/15 bg-white/5 px-2 text-center text-sm text-white outline-none focus:border-gold/50"
            aria-label={labels.jumpTo}
            data-testid="pdf-page-input"
          />
          <span className="text-white/40">/ {pageCount}</span>
        </div>
        <CtrlBtn label={labels.next} onClick={nextPage} disabled={currentPage >= pageCount} large data-testid="pdf-next-page">
          <ChevronRight className="h-5 w-5" />
        </CtrlBtn>
      </div>
    </div>
  );
}

function CtrlBtn({
  label, onClick, disabled, active, large, children, ...rest
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  large?: boolean;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type">) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={[
        "flex items-center justify-center rounded-full transition",
        large ? "h-10 w-10" : "h-8 w-8",
        active ? "bg-gold/20 text-gold-light" : "text-white/70 hover:bg-white/10",
        "disabled:opacity-30 disabled:hover:bg-transparent",
      ].join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
