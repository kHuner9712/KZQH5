"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface ProductImageProps {
  src?: string | null;
  alt: string;
  className?: string;
  fit?: "cover" | "contain";
  placeholder?: "product" | "cert";
  fallbackText?: React.ReactNode;
  loading?: "eager" | "lazy";
  sizes?: string;
}

const PANEL_GRADIENTS = [
  {
    base: "linear-gradient(145deg, #EEEAE1 0%, #D9D4CA 52%, #BBB5AA 100%)",
    grain: "rgba(70, 66, 60, 0.10)",
  },
  {
    base: "linear-gradient(145deg, #303438 0%, #202428 52%, #141719 100%)",
    grain: "rgba(255, 255, 255, 0.045)",
  },
  {
    base: "linear-gradient(145deg, #FAF8F3 0%, #E9E4DA 52%, #CEC7BA 100%)",
    grain: "rgba(82, 73, 60, 0.08)",
  },
];

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function ProductImage({
  src,
  alt,
  className,
  fit = "cover",
  placeholder = "product",
  fallbackText,
  loading = "lazy",
  sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw",
}: ProductImageProps) {
  const [error, setError] = useState(false);
  const showImage = src && !error;
  const palette = useMemo(() => {
    const index = hashString(alt || "kzq") % PANEL_GRADIENTS.length;
    return PANEL_GRADIENTS[index];
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
    [palette],
  );

  if (showImage) {
    return (
      <div className={cn("relative h-full w-full bg-canvas", className)}>
        <Image
          src={src as string}
          alt={alt}
          fill
          sizes={sizes}
          priority={loading === "eager"}
          loading={loading === "lazy" ? "lazy" : undefined}
          className={cn(
            fit === "contain" ? "object-contain p-3 md:p-5" : "object-cover",
          )}
          onError={() => setError(true)}
        />
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={alt}
      className={cn(
        "relative h-full w-full overflow-hidden",
        placeholder === "cert" && "cert-placeholder",
        className,
      )}
      style={placeholder === "product" ? placeholderStyle : undefined}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="select-none text-[11px] font-semibold tracking-[0.2em] text-white/65">
          {fallbackText !== undefined ? fallbackText : "KZQ"}
        </span>
      </div>
    </div>
  );
}
