"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

interface ProductImageProps {
  src?: string | null;
  alt: string;
  className?: string;
  /** 占位样式：product / cert */
  placeholder?: "product" | "cert";
  /** 占位时显示的内容（文字或节点） */
  fallbackText?: React.ReactNode;
  loading?: "eager" | "lazy";
}

/**
 * 产品图片组件
 * - 有 src 时正常显示，加载失败自动 fallback 到渐变占位
 * - 无 src 直接显示占位
 * - 永不出现破图图标
 */
export function ProductImage({
  src,
  alt,
  className,
  placeholder = "product",
  fallbackText = "KZQ",
  loading = "lazy",
}: ProductImageProps) {
  const [error, setError] = useState(false);
  const showImage = src && !error;

  return (
    <div
      className={cn(
        "relative h-full w-full",
        placeholder === "product" ? "product-placeholder" : "cert-placeholder",
        className
      )}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          className="h-full w-full object-cover"
          loading={loading}
          onError={() => setError(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="select-none text-2xl font-semibold tracking-tight text-ink-mute/40">
            {fallbackText}
          </span>
        </div>
      )}
    </div>
  );
}
