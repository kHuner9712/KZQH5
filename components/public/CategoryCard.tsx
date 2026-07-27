import Link from "next/link";
import { localePath, type Locale } from "@/lib/i18n/config";
import { localizeCategory } from "@/lib/i18n/content";
import { cn } from "@/lib/utils";
import type { Category } from "@/types/database";
import { ProductImage } from "./ProductImage";
import { getHomepageCategoryArtwork } from "./homeAssets";

interface CategoryCardProps {
  category: Category;
  className?: string;
  locale?: Locale;
}

export function CategoryCard({
  category,
  className,
  locale = "zh",
}: CategoryCardProps) {
  const content = localizeCategory(category, locale);
  const number = String(category.sort_order).padStart(2, "0");
  const artwork = getHomepageCategoryArtwork(category.slug);

  return (
    <Link
      href={`${localePath(locale, "/products")}?category=${category.slug}`}
      prefetch={false}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden rounded-md border border-black/[0.06] bg-canvas-warm transition-colors duration-200 hover:border-gold/30 md:rounded-lg md:border-black/[0.08]",
        className,
      )}
    >
      <div className="aspect-[4/3] w-full overflow-hidden bg-canvas">
        <ProductImage
          src={artwork}
          alt={content.name}
          sizes="(max-width: 767px) 50vw, 33vw"
          className="transition-transform duration-300 group-hover:scale-[1.025]"
        />
      </div>
      <div className="flex flex-1 flex-col p-2.5 md:p-5">
        <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-gold-dark md:text-[11px]">
          {number}
        </span>
        <h3 className="mt-1 text-sm font-semibold leading-tight text-ink md:mt-2 md:text-lg">
          {content.name}
        </h3>
        {content.secondaryName && (
          <p className="mt-0.5 truncate text-[10px] text-ink-mute md:text-xs">
            {content.secondaryName}
          </p>
        )}
        {content.description && (
          <p className="mt-1 line-clamp-2 text-[11px] leading-[1.5] text-ink-mute md:mt-2 md:text-[13px] md:leading-[1.6] md:text-ink-soft">
            {content.description}
          </p>
        )}
      </div>
    </Link>
  );
}
