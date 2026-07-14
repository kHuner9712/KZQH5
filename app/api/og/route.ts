import React from "react";
import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

export function GET(request: NextRequest) {
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
    { width: 1200, height: 630 }
  );
}
