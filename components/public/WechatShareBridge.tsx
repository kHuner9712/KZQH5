"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

interface WechatSdk {
  config(options: Record<string, unknown>): void;
  ready(callback: () => void): void;
  error(callback: () => void): void;
  updateAppMessageShareData(options: Record<string, unknown>): void;
  updateTimelineShareData(options: Record<string, unknown>): void;
}

declare global { interface Window { wx?: WechatSdk } }

let sdkPromise: Promise<WechatSdk> | null = null;
function loadWechatSdk(): Promise<WechatSdk> {
  if (window.wx) return Promise.resolve(window.wx);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://res.wx.qq.com/open/js/jweixin-1.6.0.js";
    script.async = true;
    script.onload = () => window.wx ? resolve(window.wx) : reject(new Error("WeChat SDK missing"));
    script.onerror = () => reject(new Error("WeChat SDK failed to load"));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export function WechatShareBridge() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  useEffect(() => {
    if (!/MicroMessenger/i.test(navigator.userAgent)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    const pageUrl = window.location.href.split("#")[0];
    void Promise.all([
      fetch(`/api/wechat/jssdk?url=${encodeURIComponent(pageUrl)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
        if (!response.ok || response.status === 204) throw new Error("WeChat configuration unavailable");
        return response.json() as Promise<{ appId: string; timestamp: number; nonceStr: string; signature: string }>;
      }),
      loadWechatSdk(),
    ]).then(([config, wx]) => {
      wx.config({ ...config, debug: false, jsApiList: ["updateAppMessageShareData", "updateTimelineShareData"] });
      wx.ready(() => {
        const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content || "";
        const imgUrl = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content || "";
        const share = { title: document.title, desc: description, link: pageUrl, imgUrl };
        wx.updateAppMessageShareData(share);
        wx.updateTimelineShareData({ title: document.title, link: pageUrl, imgUrl });
      });
      wx.error(() => undefined);
    }).catch(() => undefined).finally(() => window.clearTimeout(timer));
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [pathname, query]);
  return null;
}
