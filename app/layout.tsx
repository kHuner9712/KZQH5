import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "KZQ | 工程级板材·防火饰面板·海外出口供应商",
    template: "%s | KZQ",
  },
  description:
    "KZQ 专注工程级板材、B 级防火、E0 环保饰面板，服务国内工程精装与海外采购，支持定制规格与 FOB/CIF 出口。",
  keywords: [
    "KZQ",
    "板材",
    "多层板",
    "MDF",
    "三聚氰胺板",
    "防火板",
    "E0环保",
    "B级防火",
    "海外出口",
    "工程板材",
  ],
  openGraph: {
    title: "KZQ | 工程级板材·防火饰面板",
    description:
      "B 级防火 · E0 环保 · 工程交付 · 海外出口，支持定制规格与 FOB/CIF。",
    type: "website",
    locale: "zh_CN",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0b0f14",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
