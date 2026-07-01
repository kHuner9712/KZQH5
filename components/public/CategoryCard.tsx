import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Category } from "@/types/database";

interface CategoryCardProps {
  category: Category;
  /** 卡片高度 */
  className?: string;
}

/**
 * 类目入口卡
 * - 使用基于 slug 的稳定渐变背景 + 大字标题
 * - 不使用数字水印，更像产品入口
 * - 英文副标题 + "查看产品" 行动入口
 */
export function CategoryCard({ category, className }: CategoryCardProps) {
  const gradient = getGradientForSlug(category.slug);

  return (
    <Link
      href={`/products?category=${category.slug}`}
      className={cn(
        "card-base relative block overflow-hidden p-5",
        className
      )}
    >
      {/* 渐变背景层 */}
      <div
        className="absolute inset-0 opacity-90"
        style={{ background: gradient }}
      />
      {/* 板材纹理细线 */}
      <div
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, rgba(255,255,255,0.6) 0, rgba(255,255,255,0.6) 1px, transparent 1px, transparent 28px)",
        }}
      />
      <div className="relative flex h-full flex-col justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">
            {category.name_cn}
          </h3>
          {category.name_en && (
            <p className="mt-0.5 text-[11px] uppercase tracking-wider text-white/70">
              {category.name_en}
            </p>
          )}
          {category.description_cn && (
            <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-white/60">
              {category.description_cn}
            </p>
          )}
        </div>
        <span className="mt-3 inline-flex items-center gap-1 self-start rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
          查看产品 <ArrowRight className="h-3 w-3" />
        </span>
      </div>
    </Link>
  );
}

/** 基于 slug hash 生成稳定的深色渐变（板材质感） */
function getGradientForSlug(slug: string): string {
  const palettes: string[] = [
    // 工业蓝深
    "linear-gradient(135deg, #1E3A5F 0%, #2E5E8A 100%)",
    // 暖石墨 + 金
    "linear-gradient(135deg, #2A2E33 0%, #4A3D28 100%)",
    // 深工业 + 钢
    "linear-gradient(135deg, #16293F 0%, #1E3A5F 100%)",
    // 暖棕（木纹质感）
    "linear-gradient(135deg, #3D2E1F 0%, #5A4632 100%)",
  ];
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash << 5) - hash + slug.charCodeAt(i);
    hash |= 0;
  }
  return palettes[Math.abs(hash) % palettes.length];
}
