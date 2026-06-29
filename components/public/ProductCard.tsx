import Link from "next/link";
import type { Product } from "@/types/database";
import { FireBadge, EcoBadge } from "./Badge";
import { ArrowRight } from "lucide-react";

export function ProductCard({ product }: { product: Product }) {
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group block overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100 transition hover:shadow-md"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-gray-100">
        {product.cover_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.cover_image_url}
            alt={product.name_cn}
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-gray-300">
            <span className="text-3xl font-bold">KZQ</span>
          </div>
        )}
        {product.is_featured && (
          <span className="absolute left-2 top-2 rounded-md bg-gold px-2 py-0.5 text-[10px] font-semibold text-graphite">
            主推
          </span>
        )}
      </div>
      <div className="p-3.5">
        <h3 className="line-clamp-1 text-sm font-semibold text-graphite">{product.name_cn}</h3>
        {product.summary_cn && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-500">
            {product.summary_cn}
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <FireBadge rating={product.fire_rating || "B级"} />
          <EcoBadge grade={product.eco_grade || "E0级"} />
        </div>
        {product.size && (
          <p className="mt-2 text-[11px] text-gray-400">规格：{product.size}</p>
        )}
        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-xs font-medium text-steel">
            {product.price_display_cn || "请联系销售获取报价"}
          </span>
          <span className="inline-flex items-center gap-0.5 text-[11px] text-gray-400 transition group-hover:text-steel">
            详情 <ArrowRight className="h-3 w-3" />
          </span>
        </div>
      </div>
    </Link>
  );
}
