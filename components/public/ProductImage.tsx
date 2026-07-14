"use client";

import { useState, useMemo } from "react";
import Image from "next/image";
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
  sizes?: string;
}

/**
 * 板材色系渐变 - 根据 hash 生成不同的木纹/工业色调
 * 用于无图或加载失败时的占位，呈现真实板材质感
 */
const PANEL_GRADIENTS = [
  // 暖橡木
  {
    base: "linear-gradient(135deg, #D4B373 0%, #B08542 50%, #8A6630 100%)",
    grain: "rgba(74, 61, 40, 0.18)",
  },
  // 胡桃木
  {
    base: "linear-gradient(135deg, #8B5A2B 0%, #5A3A1A 50%, #3D2410 100%)",
    grain: "rgba(40, 20, 8, 0.25)",
  },
  // 浅灰石材
  {
    base: "linear-gradient(135deg, #E8E6E1 0%, #C8C5BE 50%, #A8A49C 100%)",
    grain: "rgba(60, 56, 50, 0.15)",
  },
  // 工业蓝石墨
  {
    base: "linear-gradient(135deg, #4A7BA8 0%, #2E5E8A 50%, #1E3A5F 100%)",
    grain: "rgba(20, 30, 45, 0.2)",
  },
  // 暖米白
  {
    base: "linear-gradient(135deg, #FAF8F4 0%, #F0EBE0 50%, #E0D8C8 100%)",
    grain: "rgba(120, 100, 70, 0.12)",
  },
  // 深石墨黑
  {
    base: "linear-gradient(135deg, #2A2E33 0%, #1A1D21 50%, #0F1114 100%)",
    grain: "rgba(255, 255, 255, 0.05)",
  },
];

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * 产品图片组件
 * - 有 src 时正常显示，加载失败自动 fallback 到板材纹理渐变占位
 * - 无 src 直接显示按 alt hash 着色的板材纹理占位
 * - 永不出现破图图标
 */
export function ProductImage({
  src,
  alt,
  className,
  placeholder = "product",
  fallbackText,
  loading = "lazy",
  sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw",
}: ProductImageProps) {
  const [error, setError] = useState(false);
  const showImage = src && !error;

  // 占位样式：按 alt hash 选择色系，保证同一产品占位稳定一致
  const palette = useMemo(() => {
    const idx = hashString(alt || "kzq") % PANEL_GRADIENTS.length;
    return PANEL_GRADIENTS[idx];
  }, [alt]);

  const placeholderStyle = useMemo<React.CSSProperties>(
    () => ({
      background: `${palette.grain} 0`,
      backgroundImage: `
        repeating-linear-gradient(
          90deg,
          ${palette.grain} 0,
          ${palette.grain} 1px,
          transparent 1px,
          transparent 18px
        ),
        repeating-linear-gradient(
          0deg,
          rgba(0,0,0,0.04) 0,
          rgba(0,0,0,0.04) 1px,
          transparent 1px,
          transparent 80px
        ),
        ${palette.base}
      `,
    }),
    [palette]
  );

  if (showImage) {
    return (
      <div
        className={cn(
          "relative h-full w-full bg-canvas",
          className
        )}
      >
        <Image
          src={src as string}
          alt={alt}
          fill
          sizes={sizes}
          priority={loading === "eager"}
          loading={loading === "lazy" ? "lazy" : undefined}
          className="object-cover"
          onError={() => setError(true)}
        />
      </div>
    );
  }

  // 占位：板材纹理渐变 + KZQ 水印
  return (
    <div
      role="img"
      aria-label={alt}
      className={cn(
        "relative h-full w-full overflow-hidden",
        placeholder === "cert" && "cert-placeholder",
        className
      )}
      style={placeholder === "product" ? placeholderStyle : undefined}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="select-none text-[11px] font-semibold tracking-[0.2em] text-white/60">
          {fallbackText !== undefined ? fallbackText : "KZQ"}
        </span>
      </div>
    </div>
  );
}
