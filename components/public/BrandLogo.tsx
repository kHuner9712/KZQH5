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
 * - 永不出现破图
 */
export function BrandLogo({
  logoUrl,
  alt = "KZQ",
  size = 40,
  className,
}: BrandLogoProps) {
  return (
    <div
      className={cn(
        "brand-monogram shrink-0 overflow-hidden rounded-xl bg-industrial text-white",
        className
      )}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={alt}
          className="h-full w-full object-cover"
          onError={(e) => {
            const target = e.currentTarget;
            target.style.display = "none";
            const parent = target.parentElement;
            if (parent) {
              parent.classList.remove("bg-industrial");
              parent.classList.add("bg-industrial");
              parent.textContent = "KZQ";
            }
          }}
        />
      ) : (
        <span className="select-none">KZQ</span>
      )}
    </div>
  );
}
