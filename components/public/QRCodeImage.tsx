"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

interface QRCodeImageProps {
  src?: string | null;
  alt?: string;
  className?: string;
}

/**
 * 微信二维码图片
 * - 加载失败时显示占位文字
 * - 使用 useState 管理 fallback 状态，不操作 DOM
 */
export function QRCodeImage({
  src,
  alt = "微信二维码",
  className,
}: QRCodeImageProps) {
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;

  if (showImage) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src as string}
        alt={alt}
        className={cn("rounded object-cover", className)}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center text-ink-mute",
        className
      )}
    >
      <span className="text-[10px]">二维码待上传</span>
    </div>
  );
}
