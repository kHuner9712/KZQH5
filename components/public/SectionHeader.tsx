import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  action?: React.ReactNode;
  className?: string;
  light?: boolean;
  size?: "default" | "large";
}

export function SectionHeader({
  title,
  subtitle,
  eyebrow = "KZQ Collection",
  action,
  className,
  light = false,
  size = "default",
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 md:items-end",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2.5 md:gap-3">
          <span className="h-px w-6 shrink-0 bg-gold md:w-8" />
          <span
            className={cn(
              "text-[10px] font-medium uppercase tracking-[0.2em] md:text-xs md:tracking-[0.24em]",
              light ? "text-gold-light" : "text-gold-dark",
            )}
          >
            {eyebrow}
          </span>
        </div>
        <h2
          className={cn(
            "mt-1.5 font-semibold leading-tight tracking-[-0.015em] md:mt-3",
            size === "large" ? "text-xl md:text-[28px]" : "text-lg md:text-2xl",
            light ? "text-white" : "text-ink",
          )}
        >
          {title}
        </h2>
        {subtitle && (
          <p
            className={cn(
              "mt-1 max-w-2xl text-xs leading-5 md:mt-1.5 md:text-sm",
              light ? "text-white/55" : "text-ink-mute",
            )}
          >
            {subtitle}
          </p>
        )}
      </div>
      {action && (
        <div className="shrink-0 pt-1 text-right md:pb-1">{action}</div>
      )}
    </div>
  );
}
