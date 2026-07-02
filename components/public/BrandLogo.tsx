"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

interface BrandLogoProps {
  logoUrl?: string | null;
  alt?: string;
  size?: number;
  className?: string;
}

/**
 * 品牌徽标
 * - 有 logo_url 时显示图片，加载失败 fallback 到 KZQ 字母标识
 * - 无 logo_url 直接显示字母标识
 * - 使用 useState 管理 fallback 状态，不操作 DOM
 */
export function BrandLogo({
  logoUrl,
  alt = "KZQ",
  size = 40,
  className,
}: BrandLogoProps) {
  const [failed, setFailed] = useState(false);
  const showImage = logoUrl && !failed;

  return (
    <div
      className={cn(
        "brand-monogram shrink-0 overflow-hidden rounded-xl bg-industrial text-white",
        className
      )}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl as string}
          alt={alt}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="select-none">KZQ</span>
      )}
    </div>
  );
}
