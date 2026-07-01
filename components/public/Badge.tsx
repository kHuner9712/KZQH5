import { cn } from "@/lib/utils";

/**
 * 防火等级徽章
 */
export function FireBadge({
  rating = "B级",
  className,
}: {
  rating?: string;
  className?: string;
}) {
  return (
    <span className={cn("chip chip-fire", className)}>
      <FireMini /> {rating}
    </span>
  );
}

/**
 * 环保等级徽章
 */
export function EcoBadge({
  grade = "E0级",
  className,
}: {
  grade?: string;
  className?: string;
}) {
  return (
    <span className={cn("chip chip-eco", className)}>
      <LeafMini /> {grade}
    </span>
  );
}

function FireMini() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

function LeafMini() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.96a1 1 0 0 1 1.8.66c-.4 8-7.6 12.5-12 14.92" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6" />
    </svg>
  );
}
