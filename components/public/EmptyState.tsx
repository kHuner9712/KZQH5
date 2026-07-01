import { cn } from "@/lib/utils";
import { PackageOpen } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  className?: string;
}

export function EmptyState({
  title = "暂无数据",
  description = "稍后再来看看吧",
  icon: Icon = PackageOpen,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center",
        className
      )}
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-canvas-warm">
        <Icon className="h-7 w-7 text-ink-mute" />
      </div>
      <p className="mt-4 text-base font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink-mute">{description}</p>
    </div>
  );
}
