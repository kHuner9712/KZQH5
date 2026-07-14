import type { Metadata, Viewport } from "next";
import { DocumentLanguage } from "@/components/public/DocumentLanguage";
import "./globals.css";

export const metadata: Metadata = {
  title: "KZQ",
  description: "KZQ",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0D0F10",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.lang=location.pathname==='/en'||location.pathname.startsWith('/en/')?'en':'zh-CN'" }} />
      </head>
      <body className="min-h-screen antialiased"><DocumentLanguage />{children}</body>
    </html>
  );
}
