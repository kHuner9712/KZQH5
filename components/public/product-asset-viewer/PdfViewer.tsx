"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Download, ExternalLink, Maximize, Minimize,
  Minus, Plus, RotateCw, Scan, ScanLine,
} from "lucide-react";
import type { Locale } from "@/lib/i18n/config";
import {
  clampPage, clampZoom, snapZoom, ZOOM_MIN, ZOOM_MAX,
} from "@/lib/client/viewer-utils";
import { usePdfDocument, type PdfPageProxy, type PdfDocumentProxy } from "./hooks/usePdfDocument";
import { ViewerLoading } from "./ViewerLoading";
import { ViewerError } from "./ViewerError";

const copy = {
  zh: {
    page: "页", of: "共", jumpTo: "跳转到页", prev: "上一页", next: "下一页",
    zoomIn: "放大", zoomOut: "缩小", rotate: "旋转", fitWidth: "适应宽度",
    fitPage: "适应页面", fullscreen: "全屏", exitFullscreen: "退出全屏",
    download: "下载", open: "新窗口打开", loadingPage: "渲染页面…",
  },
  en: {
    page: "Page", of: "of", jumpTo: "Jump to page", prev: "Previous", next: "Next",
    zoomIn: "Zoom in", zoomOut: "Zoom out", rotate: "Rotate", fitWidth: "Fit width",
    fitPage: "Fit page", fullscreen: "Fullscreen", exitFullscreen: "Exit fullscreen",
    download: "Download", open: "Open in new window", loadingPage: "Rendering page…",
  },
} as const;

type FitMode = "width" | "page" | "manual";

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
  const [pageRendering, setPageRendering] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentRender = useRef<{ cancel: () => void } | null>(null);
  const containerWidth = useRef(0);

  const doc = state.document;
  const pageCount = state.pageCount;

  // Reset page when a new document loads.
  useEffect(() => {
    if (state.status === "ready") {
      setCurrentPage(1);
      setScale(1);
      setRotation(0);
      setFitMode("width");
    }
  }, [state.status]);

  // Track container width for fit calculations.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        containerWidth.current = entry.contentRect.width;
        if (fitMode !== "manual") {
          // Trigger re-fit by toggling a dep; we just re-run the render effect.
          setFitMode((m) => m); // no-op set to retrigger
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitMode]);

  // Compute the effective scale for fit modes.
  const computeFitScale = useCallback(
    (page: PdfPageProxy): number => {
      if (fitMode === "manual") return scale;
      const containerW = containerWidth.current || 800;
      const containerH = (containerRef.current?.clientHeight || 600) - 16;
      const viewport = page.getViewport({ scale: 1, rotation });
      if (fitMode === "width") {
        return clampZoom(containerW / viewport.width);
      }
      // fit page
      return clampZoom(Math.min(containerW / viewport.width, containerH / viewport.height));
    },
    [fitMode, scale, rotation],
  );

  // Render the current page to canvas.
  useEffect(() => {
    if (state.status !== "ready" || !doc) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderPage = async () => {
      try {
        const page = await doc.getPage(currentPage);
        if (cancelled) return;

        const effectiveScale = computeFitScale(page);
        const viewport = page.getViewport({ scale: effectiveScale, rotation });

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // HiDPI: use devicePixelRatio for crisp rendering, capped at 2.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        // Cancel any previous render.
        currentRender.current?.cancel();

        setPageRendering(true);
        const renderTask = page.render({
          canvasContext: ctx,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          viewport,
        });
        currentRender.current = renderTask;

        await renderTask.promise;
        if (!cancelled) {
          setPageRendering(false);
          if (fitMode !== "manual") {
            setScale(effectiveScale);
          }
        }
      } catch (err) {
        if (!cancelled) setPageRendering(false);
        // RenderingCancelledException is expected on rapid navigation; ignore.
        if (!/cancel/i.test(err instanceof Error ? err.message : String(err))) {
          // eslint-disable-next-line no-console
          console.error("[PdfViewer] render error:", err);
        }
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
      currentRender.current?.cancel();
    };
  }, [doc, currentPage, rotation, fitMode, computeFitScale, state.status]);

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
    // Horizontal swipe dominant and large enough.
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx > 0) setCurrentPage((p) => clampPage(p - 1, pageCount));
      else setCurrentPage((p) => clampPage(p + 1, pageCount));
    }
    touchStart.current = null;
  }, [pageCount]);

  // --- State-driven UI ---
  if (state.status === "loading") return <ViewerLoading locale={locale} />;
  if (state.status === "error" && state.errorKind) {
    return (
      <ViewerError
        errorKind={state.errorKind}
        locale={locale}
        url={url}
        isWeChat={isWeChat}
        onRetry={retry}
        onClose={onClose}
        onDownload={onDownload}
      />
    );
  }
  if (state.status !== "ready" || !doc) return <ViewerLoading locale={locale} />;

  const zoomIn = () => { setFitMode("manual"); setScale((s) => snapZoom(s + 0.25)); };
  const zoomOut = () => { setFitMode("manual"); setScale((s) => snapZoom(s - 0.25)); };
  const fitWidth = () => setFitMode("width");
  const fitPage = () => setFitMode("page");
  const rotate = () => setRotation((r) => (r + 90) % 360);
  const prevPage = () => setCurrentPage((p) => clampPage(p - 1, pageCount));
  const nextPage = () => setCurrentPage((p) => clampPage(p + 1, pageCount));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        {pageRendering && (
          <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-page/80 px-3 py-1 text-[10px] text-white/60" aria-live="polite">
            {labels.loadingPage}
          </div>
        )}
      </div>

      {/* Floating zoom/rotate/fit controls */}
      <div className="pointer-events-auto absolute bottom-16 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-white/15 bg-page/90 px-1.5 py-1 shadow-lg md:bottom-4">
        <CtrlBtn label={labels.zoomOut} onClick={zoomOut} disabled={scale <= ZOOM_MIN}>
          <Minus className="h-4 w-4" />
        </CtrlBtn>
        <span className="min-w-[3rem] text-center text-[11px] tabular-nums text-white/60">
          {Math.round(scale * 100)}%
        </span>
        <CtrlBtn label={labels.zoomIn} onClick={zoomIn} disabled={scale >= ZOOM_MAX}>
          <Plus className="h-4 w-4" />
        </CtrlBtn>
        <div className="mx-0.5 h-5 w-px bg-white/15" />
        <CtrlBtn label={labels.fitWidth} onClick={fitWidth} active={fitMode === "width"}>
          <ScanLine className="h-4 w-4" />
        </CtrlBtn>
        <CtrlBtn label={labels.fitPage} onClick={fitPage} active={fitMode === "page"}>
          <Scan className="h-4 w-4" />
        </CtrlBtn>
        <CtrlBtn label={labels.rotate} onClick={rotate}>
          <RotateCw className="h-4 w-4" />
        </CtrlBtn>
        <CtrlBtn label={isFullscreen ? labels.exitFullscreen : labels.fullscreen} onClick={toggleFullscreen}>
          {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </CtrlBtn>
      </div>

      {/* Bottom page navigation bar */}
      <div className="safe-bottom flex h-14 shrink-0 items-center justify-center gap-2 border-t border-white/10 bg-page/95 px-3">
        <CtrlBtn label={labels.prev} onClick={prevPage} disabled={currentPage <= 1} large>
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
          />
          <span className="text-white/40">/ {pageCount}</span>
        </div>
        <CtrlBtn label={labels.next} onClick={nextPage} disabled={currentPage >= pageCount} large>
          <ChevronRight className="h-5 w-5" />
        </CtrlBtn>
      </div>
    </div>
  );
}

function CtrlBtn({
  label, onClick, disabled, active, large, children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  large?: boolean;
  children: React.ReactNode;
}) {
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
    >
      {children}
    </button>
  );
}
