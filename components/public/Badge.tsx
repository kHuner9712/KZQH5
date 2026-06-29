import { cn } from "@/lib/utils";
import { Flame, Leaf } from "lucide-react";

export function FireBadge({ rating = "B级", className }: { rating?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700 ring-1 ring-inset ring-orange-200",
        className
      )}
    >
      <Flame className="h-3 w-3" />
      {rating}防火
    </span>
  );
}

export function EcoBadge({ grade = "E0级", className }: { grade?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200",
        className
      )}
    >
      <Leaf className="h-3 w-3" />
      {grade}环保
    </span>
  );
}
