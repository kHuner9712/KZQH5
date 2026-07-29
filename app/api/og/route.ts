// ============================================================
// OG Image Generation — /api/og
//
// Renders a 1200×630 PNG for social sharing (Open Graph image).
// Uses next/og (ImageResponse) which is CPU-intensive (Satori +
// resvg). Phase 6: switched from Edge to Node runtime so the route
// can import the shared rate-limit helper (http-security.ts uses
// node:net + node:crypto for trusted-proxy IP extraction and HMAC
// sub-bucketing). next/og ImageResponse is supported in Node runtime
// on Next.js 14.2+.
//
// Security contract:
//   - Public, unauthenticated (social crawlers need access).
//   - Rate-limited per IP (30 / 60s) to prevent CPU DoS.
//   - Title is sanitized (control chars stripped, length capped).
//   - Response is cacheable for 1 hour (immutable PNG).
// ============================================================

import React from "react";
import { ImageResponse } from "next/og";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimitKeys } from "@/lib/services/http-security";
import { getOgRateLimiter } from "@/lib/services/rate-limit";

// Node runtime: required for checkRateLimitKeys which imports
// node:net (isIP) and node:crypto (createHmac) for trusted-proxy IP
// extraction and HMAC sub-bucketing. next/og ImageResponse works in
// both Edge and Node runtimes on Next.js 14.2+.
export const runtime = "nodejs";

// Cache the rendered PNG for 1 hour at the CDN edge. Social crawlers
// re-fetch periodically but the image is deterministic for a given
// title+locale, so caching is safe.
export const revalidate = 3600;

export async function GET(request: NextRequest) {
  // --- Rate limit (per IP, two-layer model) ---
  // OG rendering is CPU-intensive. An attacker could DOS the server
  // by requesting many distinct titles. The limit is generous enough
  // for legitimate crawlers + prefetch.
  const rate = await checkRateLimitKeys(request, getOgRateLimiter());
  if (!rate.allowed) {
    return new NextResponse(null, {
      status: 429,
      headers: {
        "Retry-After": String(rate.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    });
  }

  const english = request.nextUrl.searchParams.get("locale") === "en";
  const requestedTitle = request.nextUrl.searchParams.get("title")?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const title = requestedTitle?.slice(0, 90) || (english ? "Engineering Panels" : "工程级板材");
  return new ImageResponse(
    React.createElement(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "84px",
          background: "linear-gradient(135deg, #0D0F10 0%, #1D2023 100%)",
          color: "#FAF8F3",
          fontFamily: "sans-serif",
        },
      },
      React.createElement("div", { style: { color: "#D9BD82", fontSize: 28, letterSpacing: 12 } }, "KZQ"),
      React.createElement("div", { style: { marginTop: 26, fontSize: title.length > 45 ? 46 : 64, fontWeight: 700, lineHeight: 1.15, maxWidth: 1040 } }, title),
      React.createElement("div", { style: { marginTop: 24, width: 120, height: 3, background: "#C5A15A" } }),
      React.createElement("div", { style: { marginTop: 28, fontSize: 26, color: "#B9B8B3" } }, english ? "Product catalog and inquiry" : "产品目录与询盘")
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
      },
    }
  );
}
