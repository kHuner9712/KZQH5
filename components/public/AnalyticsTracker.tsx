"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { trackAnalyticsEvent } from "@/lib/client/analytics";
import type { Locale } from "@/lib/i18n/config";
import type { AnalyticsEventName } from "@/types/database";

export function PageViewTracker({ locale }: { locale: Locale }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const lastPath = useRef("");

  useEffect(() => {
    const pagePath = `${pathname}${query ? `?${query}` : ""}`;
    if (lastPath.current === pagePath) return;
    lastPath.current = pagePath;
    trackAnalyticsEvent({ event_name: "page_view", locale, page_path: pagePath });
  }, [locale, pathname, query]);
  return null;
}

export function ContextEventTracker({
  eventName,
  locale,
  productId,
  projectId,
  pagePath,
}: {
  eventName: AnalyticsEventName;
  locale: Locale;
  productId?: string | null;
  projectId?: string | null;
  pagePath?: string;
}) {
  const tracked = useRef(false);
  useEffect(() => {
    if (tracked.current) return;
    tracked.current = true;
    trackAnalyticsEvent({
      event_name: eventName,
      locale,
      product_id: productId,
      project_id: projectId,
      page_path: pagePath,
    });
  }, [eventName, locale, pagePath, productId, projectId]);
  return null;
}
