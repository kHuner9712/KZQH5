"use client";

import { useInquiryList } from "./InquiryListProvider";
import { cn } from "@/lib/utils";

export function InquiryCountBadge({ className }: { className?: string }) {
  const { count, loaded } = useInquiryList();
  if (!loaded || count === 0) return null;
  return <span className={cn("inline-flex min-w-5 items-center justify-center rounded-full bg-gold px-1.5 py-0.5 text-[10px] font-bold text-page", className)}>{count > 99 ? "99+" : count}</span>;
}

