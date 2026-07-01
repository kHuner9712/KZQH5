import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
  light?: boolean;
}

/**
 * 分区标题
 * - 左侧竖条 + 标题
 * - 可选副标题
 * - 可选右侧操作（如"全部"链接）
 */
export function SectionHeader({
  title,
  subtitle,
  action,
  className,
  light = false,
}: SectionHeaderProps) {
  return (
    <div className={cn("flex items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2
          className={cn(
            "flex items-center text-base font-semibold leading-tight",
            light ? "text-white" : "text-ink"
          )}
        >
          <span
            className={cn(
              "mr-2 inline-block h-4 w-1 rounded-full",
              light ? "bg-brass" : "bg-industrial"
            )}
          />
          {title}
        </h2>
        {subtitle && (
          <p
            className={cn(
              "mt-1.5 pl-3 text-xs leading-relaxed",
              light ? "text-white/60" : "text-ink-mute"
            )}
          >
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
