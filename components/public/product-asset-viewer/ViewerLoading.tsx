"use client";

import { Loader2 } from "lucide-react";
import type { Locale } from "@/lib/i18n/config";

const copy = {
  zh: { loading: "正在加载文件…" },
  en: { loading: "Loading file…" },
} as const;

export function ViewerLoading({ locale }: { locale: Locale }) {
  return (
    <div
      className="flex flex-1 items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3 text-white/60">
        <Loader2 className="h-7 w-7 animate-spin text-gold-light" />
        <p className="text-sm">{copy[locale].loading}</p>
      </div>
    </div>
  );
}
