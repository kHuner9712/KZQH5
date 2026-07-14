import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0D0F10" };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
