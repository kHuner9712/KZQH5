import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
  light?: boolean;
  /** 大屏模式：desktop 标题更大 */
  size?: "default" | "large";
}

/**
 * 分区标题
 * - 左侧竖条 + 标题
 * - mobile 紧凑，desktop 标题更大
 */
export function SectionHeader({
  title,
  subtitle,
  action,
  className,
  light = false,
  size = "default",
}: SectionHeaderProps) {
  return (
    <div className={cn("flex items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2
          className={cn(
            "flex items-center font-semibold leading-tight",
            size === "large"
              ? "text-base md:text-2xl"
              : "text-base md:text-xl",
            light ? "text-white" : "text-ink"
          )}
        >
          <span
            className={cn(
              "mr-2 inline-block w-1 rounded-full",
              size === "large" ? "h-4 md:h-5" : "h-4",
              light ? "bg-brass" : "bg-industrial"
            )}
          />
          {title}
        </h2>
        {subtitle && (
          <p
            className={cn(
              "mt-1.5 pl-3 text-xs leading-relaxed md:text-sm",
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
