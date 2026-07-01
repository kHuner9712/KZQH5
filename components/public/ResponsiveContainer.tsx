import { cn } from "@/lib/utils";

/**
 * 响应式容器
 * - mobile: px-4 满宽
 * - tablet (sm): px-6
 * - desktop (lg): max-w-content (1200px) + px-8 + 居中
 */
export function ResponsiveContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("container-responsive", className)}>{children}</div>
  );
}
