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
    <div className={cn("flex flex-col items-center justify-center py-16 px-6 text-center", className)}>
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
        <Icon className="h-8 w-8 text-gray-400" />
      </div>
      <p className="mt-4 text-base font-medium text-graphite">{title}</p>
      <p className="mt-1 text-sm text-gray-500">{description}</p>
    </div>
  );
}
