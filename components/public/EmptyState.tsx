import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title: string;
  description: string;
  icon: LucideIcon;
  className?: string;
  action?: ReactNode;
}

export function EmptyState({
  title,
  description,
  icon: Icon,
  className,
  action,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-md border border-dashed border-ink-line bg-canvas-warm px-6 py-12 text-center md:py-16",
        className,
      )}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-md border border-ink-line bg-white md:h-16 md:w-16">
        <Icon className="h-6 w-6 text-ink-mute md:h-7 md:w-7" />
      </div>
      <p className="mt-4 text-base font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-md text-sm leading-6 text-ink-mute">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
