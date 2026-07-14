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
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="h-px w-7 bg-gold" />
          <span className={cn("text-[9px] font-medium uppercase tracking-[0.2em]", light ? "text-gold-light" : "text-gold-dark")}>
            KZQ Collection
          </span>
        </div>
        <h2
          className={cn(
            "font-semibold leading-tight tracking-tight",
            size === "large"
              ? "text-lg md:text-2xl"
              : "text-base md:text-xl",
            light ? "text-white" : "text-ink"
          )}
        >
          {title}
        </h2>
        {subtitle && (
          <p
            className={cn(
              "mt-1.5 max-w-2xl text-xs leading-relaxed md:text-sm",
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
