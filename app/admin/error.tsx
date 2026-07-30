"use client";

import { useEffect } from "react";

/**
 * Admin route error boundary.
 *
 * Catches render-time errors in any admin page (including /admin/login).
 * Without this boundary, a render-time crash (e.g. a client-side
 * initialization error) causes React 19 to unmount the entire component
 * tree, leaving only the black <html> background (#0D0F10) — the
 * "black screen" symptom.
 *
 * This boundary ensures the user always sees a actionable message
 * instead of a blank black page.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log a coarse code only — never the error message or stack.
    console.warn("ADMIN_RENDER_ERROR");
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          background: "#0D0F10",
          color: "#F4F1EA",
          fontFamily: "system-ui, sans-serif",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <main style={{ textAlign: "center", maxWidth: 400 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 56,
              height: 56,
              borderRadius: 12,
              background: "rgba(197,161,90,0.12)",
              color: "#C5A15A",
              fontWeight: 700,
              fontSize: 20,
              marginBottom: 16,
            }}
          >
            KZQ
          </div>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>
            页面加载异常
          </h1>
          <p style={{ color: "#8D9093", lineHeight: 1.6, fontSize: 14 }}>
            管理后台页面加载失败，可能是网络或配置问题。
            <br />
            请刷新重试，或清除浏览器缓存后重新访问。
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 44,
              padding: "0 22px",
              marginTop: 20,
              border: 0,
              borderRadius: 8,
              background: "#C5A15A",
              color: "#0D0F10",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </main>
      </body>
    </html>
  );
}
