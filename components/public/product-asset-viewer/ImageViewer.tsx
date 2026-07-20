"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Minus, Plus, RotateCw } from "lucide-react";
import type { Locale } from "@/lib/i18n/config";
import { clampZoom, snapZoom, ZOOM_MIN, ZOOM_MAX } from "@/lib/client/viewer-utils";

const copy = {
  zh: { zoomIn: "放大", zoomOut: "缩小", rotate: "旋转" },
  en: { zoomIn: "Zoom in", zoomOut: "Zoom out", rotate: "Rotate" },
} as const;

export function ImageViewer({
  url,
  locale,
}: {
  url: string;
  locale: Locale;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const labels = copy[locale];

  const zoomIn = useCallback(() => setScale((s) => snapZoom(s + 0.25)), []);
  const zoomOut = useCallback(() => setScale((s) => snapZoom(s - 0.25)), []);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

  // Reset zoom/rotation when the image changes.
  useEffect(() => {
    setScale(1);
    setRotation(0);
  }, [url]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/30"
      >
        <img
          src={url}
          alt=""
          className="max-h-full max-w-full select-none object-contain transition-transform duration-200"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            transformOrigin: "center center",
          }}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          draggable={false}
        />
      </div>
      {/* Floating zoom controls */}
      <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-page/90 px-2 py-1 shadow-lg safe-bottom">
        <button
          type="button"
          onClick={zoomOut}
          disabled={scale <= ZOOM_MIN}
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
          disabled={scale >= ZOOM_MAX}
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/10 disabled:opacity-30"
          aria-label={labels.zoomIn}
        >
          <Plus className="h-4 w-4" />
        </button>
        <div className="mx-1 h-5 w-px bg-white/15" />
        <button
          type="button"
          onClick={rotate}
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 hover:bg-white/10"
          aria-label={labels.rotate}
        >
          <RotateCw className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
