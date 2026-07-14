import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeProduct } from "@/lib/i18n/content";
import { cn } from "@/lib/utils";
import type { Product } from "@/types/database";
import { ProductImage } from "./ProductImage";
import { AddToInquiryButton } from "./inquiry-list/AddToInquiryButton";

export function ProductCard({ product, variant = "compact", locale = "zh" }: { product: Product; variant?: "compact" | "full"; locale?: Locale }) {
  const isFull = variant === "full";
  const content = localizeProduct(product, locale);
  const copy = getDictionary(locale);
  return (
    <article className={cn("group overflow-hidden rounded-lg border border-ink-line bg-canvas-warm transition duration-300 hover:-translate-y-0.5 hover:shadow-card-hover", isFull && "flex")}>
      <Link href={localePath(locale, `/products/${product.slug}`)} className={cn(isFull ? "flex flex-1" : "block")}>
      <div className={cn("relative shrink-0 overflow-hidden", isFull ? "aspect-[4/3] w-2/5" : "aspect-[4/3] w-full md:aspect-[16/10]")}>
        <ProductImage src={product.cover_image_url} alt={content.name} placeholder="product" loading="lazy" sizes={isFull ? "(max-width: 768px) 40vw, 360px" : "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"} />
        {product.is_featured && <span className="absolute left-2 top-2 rounded-sm bg-page/[0.85] px-2 py-1 text-[9px] font-medium tracking-wide text-gold-light backdrop-blur-sm">{copy.products.featured}</span>}
      </div>
      <div className={cn("flex min-h-[154px] flex-col p-3 md:min-h-[158px] md:p-3.5", isFull && "flex-1 p-3.5 md:p-5")}>
        <p className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-gold-dark">KZQ material</p>
        <h3 className="line-clamp-2 text-[13px] font-semibold leading-[1.35] text-ink md:text-[15px]">{content.name}</h3>
        {content.secondaryName && <p className="mt-0.5 line-clamp-1 text-[10px] text-ink-mute md:text-[11px]">{content.secondaryName}</p>}
        <div className="mt-2 flex flex-wrap gap-1">{product.fire_rating && <span className="chip chip-fire">{product.fire_rating}</span>}{product.eco_grade && <span className="chip chip-eco">{product.eco_grade}</span>}</div>
        {product.size && <p className="mt-2 line-clamp-1 text-[10px] text-ink-soft md:text-xs"><span className="text-ink-mute">{copy.products.specification} </span>{product.size}</p>}
        <div className="mt-auto flex items-center justify-between pt-2.5"><span className="line-clamp-1 text-[10px] font-medium text-ink md:text-xs">{content.price || copy.products.contactPrice}</span><span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ink-line text-ink-mute transition group-hover:border-gold/60 group-hover:text-gold-dark"><ArrowUpRight className="h-3 w-3" /></span></div>
      </div>
      </Link>
      <div className={cn("border-t border-ink-line p-2.5", isFull && "flex items-center border-l border-t-0")}>
        <AddToInquiryButton product={product} locale={locale} compact className="w-full" />
      </div>
    </article>
  );
}
