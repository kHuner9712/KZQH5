import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { localePath, type Locale } from "@/lib/i18n/config";
import { localizeCategory } from "@/lib/i18n/content";
import { cn } from "@/lib/utils";
import type { Category } from "@/types/database";

export function CategoryCard({ category, className, locale = "zh" }: { category: Category; className?: string; locale?: Locale }) {
  const content = localizeCategory(category, locale);
  return (
    <Link href={`${localePath(locale, "/products")}?category=${category.slug}`} className={cn("group block overflow-hidden rounded-lg border border-ink-line bg-canvas-warm transition duration-300 hover:-translate-y-0.5 hover:shadow-card-hover", className)}>
      <div className={cn("relative aspect-[16/9] overflow-hidden md:aspect-[21/8]", patternFor(category.slug))}><div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-white/5" /><span className="absolute bottom-2.5 left-3 text-[9px] uppercase tracking-[0.18em] text-white/[0.65]">Material collection</span></div>
      <div className="flex min-h-[82px] items-start justify-between gap-2 p-3 md:min-h-[92px] md:p-3.5"><div className="min-w-0"><h3 className="text-sm font-semibold text-ink md:text-base">{content.name}</h3>{content.secondaryName && <p className="mt-1 truncate text-[9px] uppercase tracking-[0.1em] text-ink-mute md:text-[10px]">{content.secondaryName}</p>}{content.description && <p className="mt-2 hidden text-[10px] leading-4 text-ink-soft md:line-clamp-2 md:text-xs md:leading-5">{content.description}</p>}</div><span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink-line text-ink-mute transition group-hover:border-gold/60 group-hover:text-gold-dark"><ArrowRight className="h-3.5 w-3.5" /></span></div>
    </Link>
  );
}

function patternFor(slug: string) { const patterns = ["material-pattern-0", "material-pattern-1", "material-pattern-2", "material-pattern-3"] as const; let hash = 0; for (let index = 0; index < slug.length; index += 1) { hash = (hash << 5) - hash + slug.charCodeAt(index); hash |= 0; } return patterns[Math.abs(hash) % patterns.length]; }
