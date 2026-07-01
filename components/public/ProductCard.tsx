import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Product } from "@/types/database";
import { ProductImage } from "./ProductImage";
import { cn } from "@/lib/utils";

interface ProductCardProps {
  product: Product;
  /** compact = 紧凑 2 列；full = 单列大卡 */
  variant?: "compact" | "full";
}

/**
 * 产品卡片 - B2B 产品目录质感
 * - 统一图片比例
 * - 标签不遮挡图片
 * - 产品名 / 规格 / 防火 / 环保 / 询盘价 清晰分层
 * - 无破图
 */
export function ProductCard({ product, variant = "compact" }: ProductCardProps) {
  const isFull = variant === "full";

  return (
    <Link
      href={`/products/${product.slug}`}
      className={cn(
        "group block card-base",
        isFull ? "flex" : "block"
      )}
    >
      {/* 图片区 */}
      <div
        className={cn(
          "relative shrink-0 overflow-hidden",
          isFull ? "aspect-[4/3] w-2/5" : "aspect-[4/3] w-full"
        )}
      >
        <ProductImage
          src={product.cover_image_url}
          alt={product.name_cn}
          placeholder="product"
          loading="lazy"
        />
        {/* 主推标记 - 不遮挡图片主体，置于左上角小标 */}
        {product.is_featured && (
          <span className="absolute left-2 top-2 rounded-md bg-brass px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm">
            主推
          </span>
        )}
      </div>

      {/* 文案区 */}
      <div className={cn("flex flex-col p-3", isFull ? "flex-1 p-3.5" : "")}>
        <h3 className="line-clamp-1 text-[13px] font-semibold text-ink">
          {product.name_cn}
        </h3>
        {product.name_en && (
          <p className="mt-0.5 line-clamp-1 text-[10px] text-ink-mute">
            {product.name_en}
          </p>
        )}

        {/* 信息胶囊：防火 / 环保 */}
        <div className="mt-2 flex flex-wrap gap-1">
          {product.fire_rating && (
            <span className="chip chip-fire">
              <FlameMini /> {product.fire_rating}
            </span>
          )}
          {product.eco_grade && (
            <span className="chip chip-eco">
              <LeafMini /> {product.eco_grade}
            </span>
          )}
        </div>

        {/* 规格 */}
        {product.size && (
          <p className="mt-2 line-clamp-1 text-[11px] text-ink-soft">
            <span className="text-ink-mute">规格：</span>
            {product.size}
          </p>
        )}

        {/* 底部：询盘价 + 查看详情 */}
        <div className="mt-auto flex items-center justify-between pt-2.5">
          <span className="line-clamp-1 text-[11px] font-medium text-industrial">
            {product.price_display_cn || "Contact for quotation"}
          </span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-ink-mute transition group-hover:text-industrial">
            详情 <ArrowRight className="h-3 w-3" />
          </span>
        </div>
      </div>
    </Link>
  );
}

function FlameMini() {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

function LeafMini() {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.96a1 1 0 0 1 1.8.66c-.4 8-7.6 12.5-12 14.92" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6" />
    </svg>
  );
}
