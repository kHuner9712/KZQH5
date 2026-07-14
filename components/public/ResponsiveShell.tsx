import { Suspense } from "react";
import type { CompanyProfile, SiteSettings } from "@/types/database";
import type { Locale } from "@/lib/i18n/config";
import { DesktopHeader } from "./DesktopHeader";
import { Footer } from "./Footer";
import { MobileHeader } from "./MobileHeader";
import { MobileNavController } from "./MobileNavController";
import { InquiryAttributionCapture } from "./InquiryAttributionCapture";
import { InquiryListProvider } from "./inquiry-list/InquiryListProvider";
import { PageViewTracker } from "./AnalyticsTracker";
import { OfflineNotice } from "./OfflineNotice";
import { WechatShareBridge } from "./WechatShareBridge";

export function ResponsiveShell({
  children,
  company,
  siteSettings,
  locale,
  wechatEnabled = false,
}: {
  children: React.ReactNode;
  company?: CompanyProfile | null;
  siteSettings?: SiteSettings | null;
  locale: Locale;
  wechatEnabled?: boolean;
}) {
  return (
    <InquiryListProvider><div className="flex min-h-screen flex-col overflow-x-clip bg-canvas">
      <Suspense fallback={null}>
        <InquiryAttributionCapture />
        <PageViewTracker locale={locale} />
        {wechatEnabled && <WechatShareBridge />}
      </Suspense>
      <OfflineNotice locale={locale} />
      <DesktopHeader company={company} siteSettings={siteSettings} locale={locale} />
      <MobileHeader company={company} siteSettings={siteSettings} locale={locale} />
      <main className="flex-1 pb-[calc(5.25rem+env(safe-area-inset-bottom))] md:pb-0">
        {children}
      </main>
      <Footer company={company} siteSettings={siteSettings} locale={locale} />
      <MobileNavController locale={locale} />
    </div></InquiryListProvider>
  );
}
