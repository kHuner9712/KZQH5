"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface HomeHeroCarouselSlide {
  id: string;
  desktopImageUrl: string;
  mobileImageUrl?: string | null;
  alt: string;
  eyebrow?: string | null;
  title: string;
  highlight?: string | null;
  description?: string | null;
  primaryCtaText: string;
  primaryCtaHref: string;
  secondaryCtaText: string;
  secondaryCtaHref: string;
  focalX: number;
  focalY: number;
  overlayOpacity: number;
}

interface HomeHeroCarouselProps {
  slides: HomeHeroCarouselSlide[];
  previousLabel: string;
  nextLabel: string;
  slideLabel: string;
}

const AUTOPLAY_MS = 6000;
const SWIPE_THRESHOLD = 48;

export function HomeHeroCarousel({
  slides,
  previousLabel,
  nextLabel,
  slideLabel,
}: HomeHeroCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const slideCount = slides.length;

  const showPrevious = useCallback(() => {
    setActiveIndex((current) => (current - 1 + slideCount) % slideCount);
  }, [slideCount]);

  const showNext = useCallback(() => {
    setActiveIndex((current) => (current + 1) % slideCount);
  }, [slideCount]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (slideCount < 2 || paused || reducedMotion) return;
    const timer = window.setInterval(showNext, AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [paused, reducedMotion, showNext, slideCount]);

  useEffect(() => {
    if (activeIndex >= slideCount) setActiveIndex(0);
  }, [activeIndex, slideCount]);

  if (slideCount === 0) return null;

  return (
    <section
      className="relative isolate h-[calc(100svh-3rem)] min-h-[580px] overflow-hidden bg-page lg:h-[calc(100svh-4rem)] lg:min-h-[680px]"
      aria-roledescription="carousel"
      aria-label={slideLabel}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const start = touchStartX.current;
        const end = event.changedTouches[0]?.clientX;
        touchStartX.current = null;
        if (start == null || end == null || slideCount < 2) return;
        const distance = end - start;
        if (Math.abs(distance) < SWIPE_THRESHOLD) return;
        if (distance > 0) showPrevious();
        else showNext();
      }}
    >
      {slides.map((slide, index) => {
        const active = index === activeIndex;
        return (
          <article
            key={slide.id}
            className={cn(
              "absolute inset-0 transition-opacity duration-1000 ease-out",
              active ? "z-10 opacity-100" : "pointer-events-none z-0 opacity-0",
            )}
            aria-roledescription="slide"
            aria-label={`${index + 1} / ${slideCount}`}
            aria-hidden={!active}
          >
            <picture className="absolute inset-0 block h-full w-full">
              {slide.mobileImageUrl && (
                <source media="(max-width: 767px)" srcSet={slide.mobileImageUrl} />
              )}
              <img
                src={slide.desktopImageUrl}
                alt={slide.alt}
                loading={index === 0 ? "eager" : "lazy"}
                fetchPriority={index === 0 ? "high" : "auto"}
                className={cn(
                  "h-full w-full object-cover",
                  !reducedMotion && active && "animate-[hero-ken-burns_8s_ease-out_both]",
                )}
                style={{ objectPosition: `${slide.focalX}% ${slide.focalY}%` }}
              />
            </picture>

            <div
              className="absolute inset-0 bg-black"
              style={{ opacity: slide.overlayOpacity }}
            />
            <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(8,10,11,0.94)_0%,rgba(8,10,11,0.54)_48%,rgba(8,10,11,0.10)_100%)] md:bg-[linear-gradient(90deg,rgba(8,10,11,0.88)_0%,rgba(8,10,11,0.62)_38%,rgba(8,10,11,0.16)_72%,rgba(8,10,11,0.04)_100%)]" />

            <div className="container-responsive relative z-10 flex h-full items-end pb-24 pt-12 md:items-center md:pb-16 md:pt-0 lg:pb-10">
              <div className="w-full max-w-[720px] md:w-[62%] lg:w-[54%]">
                {slide.eyebrow && (
                  <div className="flex items-center gap-3 text-gold">
                    <span className="h-px w-8 bg-gold md:w-11" />
                    <p className="line-clamp-1 text-[10px] font-medium uppercase tracking-[0.2em] text-gold md:text-xs md:tracking-[0.26em] md:text-gold-light">
                      {slide.eyebrow}
                    </p>
                  </div>
                )}

                <h1 className="font-display mt-3 text-[clamp(2rem,9vw,3.25rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-white md:mt-6 md:text-[clamp(3.25rem,5.2vw,5.8rem)] md:leading-[1.02]">
                  {slide.title}
                  {slide.highlight && (
                    <span className="mt-2 block text-[0.78em] font-medium tracking-[-0.025em] text-white/74 md:mt-4">
                      {slide.highlight}
                    </span>
                  )}
                </h1>

                {slide.description && (
                  <p className="mt-4 max-w-[34rem] text-[13px] leading-6 text-white/68 md:mt-7 md:text-[15px] md:leading-7">
                    {slide.description}
                  </p>
                )}

                <div className="mt-6 flex flex-wrap gap-3 md:mt-10 md:gap-4">
                  <Link
                    href={slide.primaryCtaHref}
                    prefetch={false}
                    className="btn-primary h-11 rounded-md px-5 text-[13px] md:h-13 md:rounded-lg md:px-7 md:text-sm"
                    tabIndex={active ? 0 : -1}
                  >
                    {slide.primaryCtaText}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href={slide.secondaryCtaHref}
                    prefetch={false}
                    className="btn-secondary-dark h-11 px-5 text-[13px] md:h-13 md:px-7 md:text-sm"
                    tabIndex={active ? 0 : -1}
                  >
                    {slide.secondaryCtaText}
                    <ArrowUpRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            </div>
          </article>
        );
      })}

      {slideCount > 1 && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-30 md:bottom-8">
            <div className="container-responsive flex items-center justify-between">
              <div className="pointer-events-auto flex items-center gap-2" role="tablist">
                {slides.map((slide, index) => (
                  <button
                    key={slide.id}
                    type="button"
                    role="tab"
                    aria-selected={index === activeIndex}
                    aria-label={`${slideLabel} ${index + 1}`}
                    onClick={() => setActiveIndex(index)}
                    className={cn(
                      "relative h-8 w-9 overflow-hidden rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold",
                      index === activeIndex ? "text-gold" : "text-white/42 hover:text-white/75",
                    )}
                  >
                    <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current" />
                    {index === activeIndex && !paused && !reducedMotion && (
                      <span className="absolute inset-x-0 top-1/2 h-[2px] origin-left -translate-y-1/2 animate-[hero-progress_6s_linear_both] bg-gold-light" />
                    )}
                  </button>
                ))}
              </div>
              <div className="pointer-events-auto hidden items-center gap-2 md:flex">
                <button
                  type="button"
                  onClick={showPrevious}
                  aria-label={previousLabel}
                  className="grid h-11 w-11 place-items-center rounded-full border border-white/25 bg-black/15 text-white backdrop-blur-sm transition hover:border-gold/70 hover:text-gold"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={showNext}
                  aria-label={nextLabel}
                  className="grid h-11 w-11 place-items-center rounded-full border border-white/25 bg-black/15 text-white backdrop-blur-sm transition hover:border-gold/70 hover:text-gold"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
            </div>
          </div>
          <div className="sr-only" aria-live="polite">
            {activeIndex + 1} / {slideCount}
          </div>
        </>
      )}

      <a
        href="#categories"
        className="absolute bottom-7 left-1/2 z-30 hidden -translate-x-1/2 items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-white/55 transition hover:text-gold lg:flex"
      >
        <ArrowLeft className="h-3.5 w-3.5 -rotate-90" />
        Scroll
      </a>
    </section>
  );
}
