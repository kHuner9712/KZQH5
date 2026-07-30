import type { Metadata, Viewport } from "next";
import "../globals.css";

// Admin routes use nonce-based enforcing CSP (set by middleware). Nonce
// injection requires the page to be dynamically rendered so middleware
// runs on every request. If admin pages are statically prerendered, the
// HTML is generated without middleware (no nonce), but the runtime CSP
// header still demands a nonce — blocking all inline scripts (RSC
// payload) and breaking hydration. force-dynamic fixes this.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0D0F10",
};

export default function AdminLayout({
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
