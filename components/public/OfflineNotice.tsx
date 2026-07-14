"use client";

import { useEffect, useState } from "react";
import type { Locale } from "@/lib/i18n/config";

export function OfflineNotice({ locale }: { locale: Locale }) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="sticky top-0 z-[70] bg-amber-100 px-4 py-2 text-center text-xs text-amber-900" role="status" aria-live="assertive">
      {locale === "zh"
        ? "网络已断开。已加载的内容仍可浏览，提交与新页面将在恢复连接后可用。"
        : "You are offline. Loaded content remains available; submissions and new pages need a connection."}
    </div>
  );
}
