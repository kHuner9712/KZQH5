import type { ReactNode } from "react";
import { ResponsiveContainer } from "./ResponsiveContainer";

interface PublicPageHeroProps {
  eyebrow: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  meta?: ReactNode;
}

export function PublicPageHero({
  eyebrow,
  title,
  subtitle,
  description,
  meta,
}: PublicPageHeroProps) {
  return (
    <section className="relative isolate overflow-hidden border-b border-white/10 bg-page text-white">
      <div
        className="pointer-events-none absolute inset-0 opacity-80"
        aria-hidden="true"
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_18%,rgba(197,161,90,0.16),transparent_32%),linear-gradient(120deg,rgba(255,255,255,0.04),transparent_42%)]" />
        <div className="absolute inset-y-0 right-[9%] w-px bg-white/[0.06]" />
        <div className="absolute inset-y-0 right-[31%] w-px bg-white/[0.04]" />
      </div>
      <ResponsiveContainer className="relative flex min-h-[220px] items-end py-9 md:min-h-[300px] md:items-center md:py-16">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2.5 text-gold-light md:gap-3">
            <span className="h-px w-8 bg-gold md:w-10" />
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] md:text-xs md:tracking-[0.26em]">
              {eyebrow}
            </p>
          </div>
          <h1 className="font-display mt-3 text-[32px] font-semibold leading-[1.08] tracking-[-0.025em] md:mt-5 md:text-5xl">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/68 md:mt-4 md:text-base md:leading-7">
              {subtitle}
            </p>
          )}
          {description && (
            <p className="mt-2 line-clamp-2 max-w-2xl text-xs leading-5 text-white/45 md:mt-3 md:line-clamp-3 md:text-sm md:leading-6">
              {description}
            </p>
          )}
          {meta && <div className="mt-5 md:mt-6">{meta}</div>}
        </div>
      </ResponsiveContainer>
    </section>
  );
}
