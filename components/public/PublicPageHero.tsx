import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ResponsiveContainer } from "./ResponsiveContainer";

type PublicPageHeroVariant = "catalog" | "brand" | "utility";

interface PublicPageHeroProps {
  eyebrow: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  meta?: ReactNode;
  variant?: PublicPageHeroVariant;
}

const heightClasses: Record<PublicPageHeroVariant, string> = {
  catalog: "min-h-[190px] py-8 md:min-h-[270px] md:py-14",
  brand: "min-h-[250px] py-10 md:min-h-[360px] md:py-20",
  utility: "min-h-[150px] py-7 md:min-h-[210px] md:py-12",
};

const titleClasses: Record<PublicPageHeroVariant, string> = {
  catalog: "text-[30px] md:text-5xl",
  brand: "text-[34px] md:text-[56px]",
  utility: "text-[28px] md:text-[44px]",
};

export function PublicPageHero({
  eyebrow,
  title,
  subtitle,
  description,
  meta,
  variant = "catalog",
}: PublicPageHeroProps) {
  return (
    <section className="relative isolate overflow-hidden border-b border-white/10 bg-page text-white">
      <div
        className="hero-ambient pointer-events-none absolute -inset-[3%]"
        aria-hidden="true"
      >
        <div
          className={cn(
            "absolute inset-0",
            variant === "brand"
              ? "bg-[radial-gradient(circle_at_78%_18%,rgba(197,161,90,0.24),transparent_34%),radial-gradient(circle_at_15%_100%,rgba(255,255,255,0.06),transparent_38%)]"
              : "bg-[radial-gradient(circle_at_82%_18%,rgba(197,161,90,0.16),transparent_32%),linear-gradient(120deg,rgba(255,255,255,0.04),transparent_42%)]",
          )}
        />
        <div className="absolute inset-y-0 right-[9%] w-px bg-white/[0.06]" />
        <div className="absolute inset-y-0 right-[31%] w-px bg-white/[0.04]" />
        {variant === "brand" && (
          <div className="absolute right-[8%] top-[18%] hidden h-[64%] w-[28%] border border-gold/20 md:block" />
        )}
      </div>

      <ResponsiveContainer
        className={cn(
          "relative flex items-end md:items-center",
          heightClasses[variant],
        )}
      >
        <div className="animate-slide-up max-w-3xl">
          <div className="flex items-center gap-2.5 text-gold-light md:gap-3">
            <span className="h-px w-8 bg-gold md:w-10" />
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] md:text-xs md:tracking-[0.26em]">
              {eyebrow}
            </p>
          </div>
          <h1
            className={cn(
              "font-display mt-3 font-semibold leading-[1.08] tracking-[-0.025em] md:mt-5",
              titleClasses[variant],
            )}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70 md:mt-4 md:text-base md:leading-7">
              {subtitle}
            </p>
          )}
          {description && (
            <p className="mt-2 max-w-2xl text-xs leading-5 text-white/60 md:mt-3 md:text-sm md:leading-6">
              {description}
            </p>
          )}
          {meta && <div className="mt-4 md:mt-6">{meta}</div>}
        </div>
      </ResponsiveContainer>
    </section>
  );
}
