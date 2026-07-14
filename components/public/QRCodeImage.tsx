"use client";

import { useState } from "react";
import Image from "next/image";
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
    return (
      <Image
        src={src as string}
        alt={alt}
        width={288}
        height={288}
        sizes="144px"
        className={cn("rounded object-cover", className)}
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
