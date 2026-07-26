import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeProduct } from "@/lib/i18n/content";
import { cn } from "@/lib/utils";
import type { Product } from "@/types/database";
import { ProductImage } from "./ProductImage";
import { AddToInquiryButton } from "./inquiry-list/AddToInquiryButton";
import { getHomepageProductArtwork } from "./homeAssets";

type ProductCardVariant = "compact" | "full" | "editorial";

interface ProductCardProps {
  product: Product;
  variant?: ProductCardVariant;
  locale?: Locale;
}

export function ProductCard({
  product,
  variant = "compact",
  locale = "zh",
}: ProductCardProps) {
  const isFull = variant === "full";
  const editorial = variant === "editorial";
  const content = localizeProduct(product, locale);
  const copy = getDictionary(locale);
  const imageSource = editorial
    ? product.cover_image_url || getHomepageProductArtwork(product.slug)
    : product.cover_image_url;
  const editorialTag = [product.fire_rating, product.eco_grade]
    .filter(Boolean)
    .join(" · ");

  if (editorial) {
    return (
      <article className="group min-w-0 overflow-hidden rounded-md border border-black/[0.06] bg-white transition-colors duration-200 hover:border-gold/30 md:rounded-lg">
        <Link
          href={localePath(locale, `/products/${product.slug}`)}
          prefetch={false}
          className="block h-full"
          aria-label={`${content.name} — ${copy.common.viewAll}`}
        >
          <div className="aspect-square w-full overflow-hidden bg-canvas">
            <ProductImage
              src={imageSource}
              alt={content.name}
              placeholder="product"
              sizes="(max-width: 767px) 50vw, (max-width: 1279px) 33vw, 25vw"
              className="transition-transform duration-300 group-hover:scale-[1.025]"
            />
          </div>
          <div className="p-2.5 md:p-4">
            <p className="text-[9px] font-medium uppercase tracking-[0.08em] text-ink-mute md:text-[10px]">
              {content.secondaryName || "KZQ Material"}
            </p>
            <h3 className="mt-1 line-clamp-2 text-[13px] font-semibold leading-[1.35] text-ink md:text-[15px]">
              {content.name}
            </h3>
            {product.size && (
              <p className="mt-1 line-clamp-1 text-[11px] text-ink-mute md:text-xs">
                {product.size}
              </p>
            )}
            <div className="mt-2 flex min-h-6 items-center justify-between gap-2 md:mt-3">
              {editorialTag ? (
                <span className="inline-flex rounded-[3px] border border-gold/30 px-1.5 py-0.5 text-[9px] font-semibold text-gold-dark md:px-2 md:text-[11px]">
                  {editorialTag}
                </span>
              ) : (
                <span />
              )}
              <span className="inline-flex items-center gap-1 text-[10px] text-ink-mute md:text-xs">
                {copy.common.viewAll}
                <ArrowUpRight className="h-3 w-3" />
              </span>
            </div>
          </div>
        </Link>
      </article>
    );
  }

  return (
    <article
      className={cn(
        "group overflow-hidden rounded-lg border border-ink-line bg-canvas-warm transition duration-300 hover:-translate-y-0.5 hover:shadow-card-hover",
        isFull && "flex",
      )}
    >
      <Link
        href={localePath(locale, `/products/${product.slug}`)}
        // Keep disabled: this is the verified navigation-stability fix for
        // product grids with many simultaneously visible detail links.
        prefetch={false}
        className={cn(isFull ? "flex flex-1" : "block")}
      >
        <div
          className={cn(
            "relative shrink-0 overflow-hidden",
            isFull
              ? "aspect-[4/3] w-2/5"
              : "aspect-[4/3] w-full md:aspect-[16/10]",
          )}
        >
          <ProductImage
            src={imageSource}
            alt={content.name}
            placeholder="product"
            loading="lazy"
            sizes={
              isFull
                ? "(max-width: 768px) 40vw, 360px"
                : "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            }
          />
          {product.is_featured && (
            <span className="absolute left-2 top-2 rounded-sm bg-page/[0.85] px-2 py-1 text-[9px] font-medium tracking-wide text-gold-light backdrop-blur-sm">
              {copy.products.featured}
            </span>
          )}
        </div>
        <div
          className={cn(
            "flex min-h-[154px] flex-col p-3 md:min-h-[158px] md:p-3.5",
            isFull && "flex-1 p-3.5 md:p-5",
          )}
        >
          <p className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-gold-dark">
            KZQ material
          </p>
          <h3 className="line-clamp-2 text-[13px] font-semibold leading-[1.35] text-ink md:text-[15px]">
            {content.name}
          </h3>
          {content.secondaryName && (
            <p className="mt-0.5 line-clamp-1 text-[10px] text-ink-mute md:text-[11px]">
              {content.secondaryName}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {product.fire_rating && (
              <span className="chip chip-fire">{product.fire_rating}</span>
            )}
            {product.eco_grade && (
              <span className="chip chip-eco">{product.eco_grade}</span>
            )}
          </div>
          {product.size && (
            <p className="mt-2 line-clamp-1 text-[10px] text-ink-soft md:text-xs">
              <span className="text-ink-mute">
                {copy.products.specification}{" "}
              </span>
              {product.size}
            </p>
          )}
          <div className="mt-auto flex items-center justify-between pt-2.5">
            <span className="line-clamp-1 text-[10px] font-medium text-ink md:text-xs">
              {content.price || copy.products.contactPrice}
            </span>
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ink-line text-ink-mute transition group-hover:border-gold/60 group-hover:text-gold-dark">
              <ArrowUpRight className="h-3 w-3" />
            </span>
          </div>
        </div>
      </Link>
      <div
        className={cn(
          "border-t border-ink-line p-2.5",
          isFull && "flex items-center border-l border-t-0",
        )}
      >
        <AddToInquiryButton
          product={product}
          locale={locale}
          compact
          className="w-full"
        />
      </div>
    </article>
  );
}
