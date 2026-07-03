"use client";

import { usePathname } from "next/navigation";
import { BottomNav } from "./BottomNav";
import type { SiteSettings } from "@/types/database";

/**
 * 移动端底部导航控制器
 * - 根据当前路径决定是否渲染 BottomNav
 * - 产品详情页（/products/[slug]）有自己的 fixed 底部询盘 CTA，
 *   隐藏 BottomNav 避免两者重叠
 * - /products 列表页与其它页面正常显示 BottomNav
 */
export function MobileNavController({
  siteSettings,
}: {
  siteSettings?: SiteSettings | null;
}) {
  const pathname = usePathname();

  // 产品详情页：/products/[slug]（pathname 形如 "/products/xxx"）
  // /products 列表页 pathname 为 "/products"，不匹配 "/products/"，不受影响
  if (pathname.startsWith("/products/")) {
    return null;
  }

  return <BottomNav siteSettings={siteSettings} />;
}
