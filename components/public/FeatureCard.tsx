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
 * - mobile 2x2 网格
 * - desktop 4 列横排
 */
export function FeatureCard({
  icon: Icon,
  title,
  desc,
  className,
}: FeatureCardProps) {
  return (
    <div className={cn("card-base p-4 md:p-5", className)}>
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-industrial-50 md:h-10 md:w-10">
        <Icon className="h-4 w-4 text-industrial md:h-5 md:w-5" />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-ink md:text-base">
        {title}
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-mute md:text-xs">
        {desc}
      </p>
    </div>
  );
}
