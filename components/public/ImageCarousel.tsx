"use client";

import { useState, useRef } from "react";
import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import { cn } from "@/lib/utils";

interface CarouselImage {
  url: string;
  alt: string;
}

export function ImageCarousel({
  images,
  videoUrl,
}: {
  images: CarouselImage[];
  videoUrl?: string | null;
}) {
  const hasVideo = !!videoUrl;
  // 视频 + 图片统一为一组 slides
  const slides: Array<{ type: "video" | "image"; url: string; alt: string }> = [];
  if (hasVideo) {
    slides.push({ type: "video", url: videoUrl!, alt: "产品视频" });
  }
  images.forEach((img) => slides.push({ type: "image", url: img.url, alt: img.alt }));

  const [active, setActive] = useState(0);
  const touchStartX = useRef<number | null>(null);

  const go = (idx: number) => {
    const n = slides.length;
    setActive((idx + n) % n);
  };

  if (slides.length === 0) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center bg-gray-100 text-gray-300">
        <span className="text-3xl font-bold">KZQ</span>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden bg-graphite">
      <div
        className="flex transition-transform duration-300 ease-out"
        style={{ transform: `translateX(-${active * 100}%)` }}
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0].clientX;
        }}
        onTouchEnd={(e) => {
          if (touchStartX.current === null) return;
          const dx = e.changedTouches[0].clientX - touchStartX.current;
          if (dx > 40) go(active - 1);
          else if (dx < -40) go(active + 1);
          touchStartX.current = null;
        }}
      >
        {slides.map((s, i) => (
          <div key={i} className="aspect-[4/3] w-full shrink-0">
            {s.type === "video" ? (
              <video
                src={s.url}
                controls
                playsInline
                className="h-full w-full object-cover"
                poster={images[0]?.url}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={s.url}
                alt={s.alt}
                className="h-full w-full object-cover"
                loading={i === 0 ? "eager" : "lazy"}
              />
            )}
          </div>
        ))}
      </div>

      {/* 左右箭头（仅图片数大于 1 时） */}
      {slides.length > 1 && (
        <>
          <button
            onClick={() => go(active - 1)}
            className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60"
            aria-label="上一张"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => go(active + 1)}
            className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60"
            aria-label="下一张"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          {/* 指示器 */}
          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1.5">
            {slides.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === active ? "w-4 bg-white" : "w-1.5 bg-white/50"
                )}
              />
            ))}
          </div>

          {/* 视频角标 */}
          {hasVideo && (
            <div className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
              <Play className="mr-0.5 inline h-2.5 w-2.5" /> 视频
            </div>
          )}
        </>
      )}
    </div>
  );
}
