"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 浮动询盘按钮
 * - 在非询盘页 / 非产品详情页右下角浮动
 * - 产品详情页有专属底部 CTA，此组件自动隐藏
 */
export function FloatingInquiryBar() {
  const pathname = usePathname();

  // 产品详情页已有底部固定 CTA，联系页本身是表单，首页不显示
  const hiddenOn =
    pathname === "/contact" ||
    pathname.startsWith("/products/");

  if (hiddenOn) return null;

  return (
    <Link
      href="/contact"
      className={cn(
        "fixed bottom-20 left-1/2 z-40 -translate-x-1/2 transition-all",
        "max-w-h5 w-full px-4"
      )}
    >
      <div className="flex justify-end">
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full bg-industrial px-4 py-2.5 text-[12px] font-medium text-white shadow-lg",
            "shadow-industrial/30 active:scale-95 transition"
          )}
          style={{ boxShadow: "0 8px 20px rgba(30,58,95,0.28)" }}
        >
          <MessageCircle className="h-4 w-4" />
          立即询盘
        </span>
      </div>
    </Link>
  );
}
