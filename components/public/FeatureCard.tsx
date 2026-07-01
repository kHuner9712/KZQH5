import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  desc: string;
  className?: string;
}

/**
 * 核心优势卡片
 * - 用于首页 2x2 网格或横向滑动
 * - 图标 + 标题 + 简短描述
 */
export function FeatureCard({
  icon: Icon,
  title,
  desc,
  className,
}: FeatureCardProps) {
  return (
    <div className={cn("card-base p-4", className)}>
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-industrial-50">
        <Icon className="h-4 w-4 text-industrial" />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-mute">{desc}</p>
    </div>
  );
}
