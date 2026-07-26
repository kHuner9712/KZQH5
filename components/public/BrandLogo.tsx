"use client";

import { useState } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface BrandLogoProps {
  logoUrl?: string | null;
  alt?: string;
  size?: number;
  className?: string;
  variant?: "mark" | "wordmark";
}

export function BrandLogo({
  logoUrl,
  alt = "KZQ",
  size = 40,
  className,
  variant = "mark",
}: BrandLogoProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(logoUrl) && !failed;
  const wordmark = variant === "wordmark";

  return (
    <span
      className={cn(
        "brand-monogram relative shrink-0 overflow-hidden",
        wordmark
          ? "h-7 rounded-none bg-transparent text-gold"
          : "rounded-xl bg-industrial text-white",
        className,
      )}
      style={{
        width: wordmark ? size : size,
        height: wordmark ? 28 : size,
        fontSize: wordmark ? 18 : size * 0.38,
      }}
    >
      {showImage ? (
        <Image
          src={logoUrl as string}
          alt={alt}
          fill
          sizes={`${size}px`}
          className={wordmark ? "object-contain object-left" : "object-cover"}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="select-none font-semibold tracking-[0.06em]">KZQ</span>
      )}
    </span>
  );
}
