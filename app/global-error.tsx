"use client";

import Link from "next/link";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: "#F4F1EA", color: "#25282B", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }} role="alert">
          <div><h1 style={{ fontSize: 22 }}>服务暂时不可用 / Service unavailable</h1><p style={{ lineHeight: 1.7, color: "#5B5F62" }}>请检查网络后重试。<br />Check your connection and try again.</p><button type="button" onClick={reset} style={{ minHeight: 44, padding: "0 22px", border: 0, borderRadius: 6, background: "#C5A15A", color: "#0D0F10", fontWeight: 700 }}>重试 / Retry</button><p><Link href="/" style={{ color: "#25282B" }}>返回首页 / Return home</Link></p></div>
        </main>
      </body>
    </html>
  );
}
