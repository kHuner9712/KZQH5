"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface BrandLogoProps {
  logoUrl?: string | null;
  alt?: string;
  size?: number;
  className?: string;
  variant?: "mark" | "wordmark";
}

const OFFICIAL_KZQ_LOGO = "/brand/kzq-logo-black-gold.svg";

export function BrandLogo({
  logoUrl,
  alt = "KZQ",
  size = 88,
  className,
  variant = "mark",
}: BrandLogoProps) {
  const [customFailed, setCustomFailed] = useState(false);
  const [officialFailed, setOfficialFailed] = useState(false);
  const wordmark = variant === "wordmark";
  const customSource = logoUrl?.trim() || null;
  const source = customSource && !customFailed ? customSource : OFFICIAL_KZQ_LOGO;
  const showImage = !officialFailed || source !== OFFICIAL_KZQ_LOGO;
  const height = wordmark ? Math.max(24, Math.round(size * 0.31)) : size;

  useEffect(() => {
    setCustomFailed(false);
    setOfficialFailed(false);
  }, [customSource]);

  return (
    <span
      className={cn(
        "brand-monogram relative inline-flex shrink-0 items-center justify-center overflow-hidden",
        wordmark
          ? "rounded-none bg-transparent text-gold"
          : "rounded-xl bg-industrial text-white",
        className,
      )}
      style={{ width: size, height, fontSize: wordmark ? 18 : size * 0.38 }}
    >
      {showImage ? (
        <img
          src={source}
          alt={alt}
          width={size}
          height={height}
          loading="eager"
          decoding="async"
          className={cn(
            "h-full w-full object-contain",
            wordmark && "drop-shadow-[0_1px_5px_rgba(201,162,76,0.18)]",
          )}
          onError={() => {
            if (source === OFFICIAL_KZQ_LOGO) setOfficialFailed(true);
            else setCustomFailed(true);
          }}
        />
      ) : (
        <span className="select-none font-semibold tracking-[0.06em] text-gold">
          KZQ
        </span>
      )}
    </span>
  );
}
