import Link from "next/link";
import { RefreshCw } from "lucide-react";
import type { Locale } from "@/lib/i18n/config";
import { localePath } from "@/lib/i18n/config";

export function PublicDataUnavailable({ locale, retryPath }: { locale: Locale; retryPath: string }) {
  const zh = locale === "zh";
  return (
    <section className="flex min-h-[60vh] items-center justify-center px-6 py-16 text-center" role="alert" aria-live="assertive">
      <div className="max-w-md">
        <RefreshCw className="mx-auto h-8 w-8 text-brass" aria-hidden="true" />
        <h1 className="mt-5 text-xl font-semibold text-ink">{zh ? "数据暂时不可用" : "Data is temporarily unavailable"}</h1>
        <p className="mt-2 text-sm leading-6 text-ink-mute">
          {zh ? "网络或数据库可能正在恢复，请稍后重试。页面其他入口仍可正常使用。" : "The network or database may be recovering. Please try again shortly; other site links remain available."}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <a href={retryPath} className="btn-primary h-11 px-6">{zh ? "重试" : "Try again"}</a>
          <Link href={localePath(locale)} className="btn-outline h-11 px-5">{zh ? "返回首页" : "Home"}</Link>
          <Link href={localePath(locale, "/products")} className="btn-outline h-11 px-5">{zh ? "产品中心" : "Products"}</Link>
        </div>
      </div>
    </section>
  );
}

export async function renderPublicPage(
  locale: Locale,
  retryPath: string,
  render: () => React.ReactNode | Promise<React.ReactNode>,
) {
  try {
    return await render();
  } catch (error) {
    console.error("Public page data query failed", error instanceof Error ? error.message : "unknown error");
    return <PublicDataUnavailable locale={locale} retryPath={retryPath} />;
  }
}
