"use client";

import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProductImage } from "./ProductImage";
import { localeFromPathname, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

interface CarouselImage {
  url: string;
  alt: string;
}

interface CarouselSlide {
  type: "video" | "image";
  url: string;
  alt: string;
}

export function ImageCarousel({
  images,
  videoUrl,
  locale,
}: {
  images: CarouselImage[];
  videoUrl?: string | null;
  locale?: Locale;
}) {
  const pathname = usePathname();
  const copy = getDictionary(locale || localeFromPathname(pathname)).products;
  const slides: CarouselSlide[] = [
    ...(videoUrl
      ? [{ type: "video" as const, url: videoUrl, alt: copy.productVideo }]
      : []),
    ...images.map((image) => ({ type: "image" as const, ...image })),
  ];
  const [active, setActive] = useState(0);
  const touchStartX = useRef<number | null>(null);

  const go = (index: number) => {
    setActive((index + slides.length) % slides.length);
  };

  if (slides.length === 0) {
    return (
      <div className="aspect-[4/3] w-full">
        <ProductImage
          src={null}
          alt="KZQ"
          placeholder="product"
          fit="contain"
          loading="eager"
        />
      </div>
    );
  }

  return (
    <div className="bg-canvas-cool">
      <div className="relative overflow-hidden">
        <div
          className="flex transition-transform duration-300 ease-out"
          style={{ transform: `translateX(-${active * 100}%)` }}
          onTouchStart={(event) => {
            touchStartX.current = event.touches[0].clientX;
          }}
          onTouchEnd={(event) => {
            if (touchStartX.current === null) return;
            const deltaX =
              event.changedTouches[0].clientX - touchStartX.current;
            if (deltaX > 40) go(active - 1);
            else if (deltaX < -40) go(active + 1);
            touchStartX.current = null;
          }}
        >
          {slides.map((slide, index) => (
            <div
              key={`${slide.type}-${slide.url}`}
              className="aspect-[4/3] w-full shrink-0"
            >
              {slide.type === "video" ? (
                <video
                  src={slide.url}
                  controls
                  playsInline
                  className="h-full w-full bg-page object-contain"
                  poster={images[0]?.url}
                />
              ) : (
                <ProductImage
                  src={slide.url}
                  alt={slide.alt}
                  placeholder="product"
                  fit="contain"
                  loading={index === 0 ? "eager" : "lazy"}
                />
              )}
            </div>
          ))}
        </div>

        {slides.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(active - 1)}
              className="absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition hover:bg-black/70"
              aria-label={copy.previousImage}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => go(active + 1)}
              className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition hover:bg-black/70"
              aria-label={copy.nextImage}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <span className="absolute bottom-3 right-3 rounded bg-page/75 px-2 py-1 text-[10px] tabular-nums text-white md:hidden">
              {active + 1} / {slides.length}
            </span>
          </>
        )}

        {videoUrl && (
          <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/55 px-2 py-1 text-[10px] text-white">
            <Play className="mr-1 inline h-3 w-3" />
            {copy.productVideo}
          </div>
        )}
      </div>

      {slides.length > 1 && (
        <div className="hidden gap-2 overflow-x-auto border-t border-black/[0.06] p-3 md:flex">
          {slides.map((slide, index) => (
            <button
              key={`thumb-${slide.type}-${slide.url}`}
              type="button"
              onClick={() => go(index)}
              className={cn(
                "relative h-16 w-20 shrink-0 overflow-hidden rounded-md border bg-white transition-colors",
                index === active
                  ? "border-gold"
                  : "border-black/[0.08] hover:border-gold/45",
              )}
              aria-label={`${index + 1} / ${slides.length}: ${slide.alt}`}
              aria-current={index === active ? "true" : undefined}
            >
              {slide.type === "video" ? (
                <span className="flex h-full items-center justify-center bg-page text-gold-light">
                  <Play className="h-5 w-5" />
                </span>
              ) : (
                <ProductImage
                  src={slide.url}
                  alt=""
                  fit="contain"
                  sizes="80px"
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
