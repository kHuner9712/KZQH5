import { describe, expect, it } from "vitest";
import {
  validateAssetUrl,
  sanitizeFilename,
  deriveExtension,
  isPdfAsset,
  isImageAsset,
  isSvgAsset,
  canPreviewAsset,
  isWeChatBrowser,
  isWeComBrowser,
  clampPage,
  clampZoom,
  snapZoom,
  mapPdfError,
  viewerErrorMessage,
  formatProductAssetSize,
  ZOOM_MIN,
  ZOOM_MAX,
} from "@/lib/client/viewer-utils";
import type { ProductAsset } from "@/types/database";

function asset(overrides: Partial<ProductAsset> = {}): ProductAsset {
  return {
    id: "a1", product_id: null, asset_type: "catalog", catalog_topic_id: null,
    title_cn: "t", title_en: "t", description_cn: null, description_en: null,
    file_url: "/test.pdf", cover_image_url: null, file_size: null,
    mime_type: "application/pdf", published_at: null, content_hash: null,
    is_published: true, sort_order: 0, created_at: "", updated_at: "",
    ...overrides,
  };
}

describe("validateAssetUrl", () => {
  it("accepts https URLs", () => {
    expect(validateAssetUrl("https://example.com/file.pdf").ok).toBe(true);
  });
  it("accepts relative paths", () => {
    expect(validateAssetUrl("/demo/test.pdf").ok).toBe(true);
    expect(validateAssetUrl("./test.pdf").ok).toBe(true);
    expect(validateAssetUrl("../test.pdf").ok).toBe(true);
  });
  it("accepts http only for localhost / loopback or when allowed for testing", () => {
    expect(validateAssetUrl("http://localhost:3000/test.pdf").ok).toBe(true);
    expect(validateAssetUrl("http://127.0.0.1:3000/test.pdf").ok).toBe(true);
    expect(validateAssetUrl("http://[::1]:3000/test.pdf").ok).toBe(true);
    expect(validateAssetUrl("http://example.com/test.pdf", true).ok).toBe(true);
  });
  it("rejects public http URLs", () => {
    const r = validateAssetUrl("http://example.com/test.pdf");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("insecure_http");
    expect(validateAssetUrl("http://10.0.0.1/test.pdf").ok).toBe(false);
    expect(validateAssetUrl("http://192.168.1.1/test.pdf").ok).toBe(false);
  });
  it("rejects javascript: URLs", () => {
    const r = validateAssetUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
  });
  it("rejects data: URLs", () => {
    expect(validateAssetUrl("data:text/html,<script>alert(1)</script>").ok).toBe(false);
  });
  it("rejects file: URLs", () => {
    expect(validateAssetUrl("file:///etc/passwd").ok).toBe(false);
  });
  it("rejects protocol-relative URLs (//evil.example.com)", () => {
    const r = validateAssetUrl("//evil.example.com/file.pdf");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("protocol_relative_url");
    expect(validateAssetUrl("//evil.example.com").ok).toBe(false);
    expect(validateAssetUrl("//evil.example.com:8443/x").ok).toBe(false);
  });
  it("rejects triple-slash URLs that resolve to a foreign origin", () => {
    // `///evil.example.com/x` starts with `/` so it enters the relative-path
    // branch. WHATWG URL parses it as `//evil.example.com/x` relative to the
    // base, which resolves to a foreign origin — the origin check rejects it.
    const r = validateAssetUrl("///evil.example.com/file.pdf");
    expect(r.ok).toBe(false);
  });
  it("rejects backslash tricks that try to escape the origin", () => {
    // `/\/evil.example.com/x` — the URL parser normalizes backslashes to
    // forward slashes inside the path, so this stays same-origin (a weird
    // local path). But a bare `\\evil.example.com\x` (UNC-style) is rejected
    // because it doesn't start with `/`, `./`, or `../` and isn't a valid URL.
    expect(validateAssetUrl("\\\\evil.example.com\\file.pdf").ok).toBe(false);
  });
  it("rejects vbscript: URLs", () => {
    const r = validateAssetUrl("vbscript:msgbox(1)");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unsupported_protocol");
  });
  it("rejects URLs whose relative form would escape the base origin", () => {
    // A path like `//evil.com/x` is caught by the explicit protocol-relative
    // guard. A path like `\\\\evil.com/x` (UNC-style) parses to the same
    // origin via WHATWG normalization, so we don't pretend to defend against
    // it — we just make sure the explicit `//` guard rejects it.
    expect(validateAssetUrl("//evil.com/x").ok).toBe(false);
  });
  it("accepts plain same-origin /, ./, ../ paths and returns them as-is", () => {
    expect(validateAssetUrl("/documents/file.pdf")).toEqual({ ok: true, resolved: "/documents/file.pdf" });
    expect(validateAssetUrl("./file.pdf")).toEqual({ ok: true, resolved: "./file.pdf" });
    expect(validateAssetUrl("../file.pdf")).toEqual({ ok: true, resolved: "../file.pdf" });
  });
  it("rejects empty URLs", () => {
    expect(validateAssetUrl("").ok).toBe(false);
    expect(validateAssetUrl("   ").ok).toBe(false);
  });
  it("rejects malformed URLs", () => {
    expect(validateAssetUrl("not a url at all").ok).toBe(false);
  });
  it("rejects blob: URLs", () => {
    const r = validateAssetUrl("blob:https://example.com/uuid");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unsupported_protocol");
  });
  it("rejects ftp: URLs", () => {
    const r = validateAssetUrl("ftp://example.com/file.pdf");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unsupported_protocol");
  });
  it("rejects ws/wss: URLs", () => {
    expect(validateAssetUrl("ws://example.com/socket").ok).toBe(false);
    expect(validateAssetUrl("wss://example.com/socket").ok).toBe(false);
  });
  it("does not allow public http even with port", () => {
    expect(validateAssetUrl("http://example.com:8080/file.pdf").ok).toBe(false);
  });
  it("allows http on localhost with any port", () => {
    expect(validateAssetUrl("http://localhost:5173/file.pdf").ok).toBe(true);
    expect(validateAssetUrl("http://127.0.0.1:8080/file.pdf").ok).toBe(true);
  });
});

describe("sanitizeFilename", () => {
  it("keeps clean names with extension", () => {
    expect(sanitizeFilename("catalog.pdf", "doc", ".pdf")).toBe("catalog.pdf");
  });
  it("adds extension when missing", () => {
    expect(sanitizeFilename("catalog", "doc", ".pdf")).toBe("catalog.pdf");
  });
  it("strips illegal characters", () => {
    expect(sanitizeFilename('file<>:"/\\|?*.pdf', "doc", ".pdf")).toBe("file.pdf");
  });
  it("collapses whitespace", () => {
    expect(sanitizeFilename("my  catalog   name.pdf", "doc", ".pdf")).toBe("my catalog name.pdf");
  });
  it("falls back when name is empty", () => {
    expect(sanitizeFilename("", "fallback", ".pdf")).toBe("fallback.pdf");
  });
  it("falls back when name is only illegal chars", () => {
    expect(sanitizeFilename('<>:"', "fallback", ".pdf")).toBe("fallback.pdf");
  });
  it("handles Windows reserved names", () => {
    expect(sanitizeFilename("CON", "doc", ".pdf")).toBe("CON-file.pdf");
  });
  it("preserves Chinese characters", () => {
    expect(sanitizeFilename("产品目录.pdf", "doc", ".pdf")).toBe("产品目录.pdf");
  });
  it("strips leading/trailing dots", () => {
    expect(sanitizeFilename("...catalog.pdf...", "doc", ".pdf")).toBe("catalog.pdf");
  });
  it("does not add a lone dot when preferredExt is empty", () => {
    expect(sanitizeFilename("catalog", "doc", "")).toBe("catalog");
    expect(sanitizeFilename("catalog.png", "doc", "")).toBe("catalog.png");
  });
  it("forces .pdf extension for PDF targets", () => {
    expect(sanitizeFilename("catalog.png", "doc", ".pdf")).toBe("catalog.pdf");
    expect(sanitizeFilename("catalog", "doc", ".pdf")).toBe("catalog.pdf");
  });
  it("prevents double extensions", () => {
    expect(sanitizeFilename("catalog.pdf", "doc", ".pdf")).toBe("catalog.pdf");
  });
  it("prevents double extensions for images", () => {
    // Image filenames keep their original extension; preferredExt is only a
    // hint and we never append a second extension (no "image.jpg.png").
    expect(sanitizeFilename("image.jpg", "doc", ".png")).toBe("image.jpg");
    expect(sanitizeFilename("image.png", "doc", ".png")).toBe("image.png");
  });
  it("preserves existing correct extension", () => {
    expect(sanitizeFilename("report.pdf", "doc", ".pdf")).toBe("report.pdf");
    expect(sanitizeFilename("photo.jpg", "doc", ".jpg")).toBe("photo.jpg");
  });
  it("strips directory traversal sequences", () => {
    expect(sanitizeFilename("../etc/passwd", "doc", ".pdf")).toBe("etcpasswd.pdf");
    expect(sanitizeFilename("..\\..\\secret", "doc", ".pdf")).toBe("secret.pdf");
  });
  it("strips trailing dots", () => {
    expect(sanitizeFilename("catalog.", "doc", ".pdf")).toBe("catalog.pdf");
    expect(sanitizeFilename("catalog...", "doc", "")).toBe("catalog");
  });
  it("handles preferredExt with leading dot", () => {
    expect(sanitizeFilename("catalog", "doc", ".pdf")).toBe("catalog.pdf");
  });
  it("handles preferredExt without leading dot", () => {
    expect(sanitizeFilename("catalog", "doc", "pdf")).toBe("catalog.pdf");
  });
  it("forces pdf extension even when current ext is image", () => {
    expect(sanitizeFilename("scan.jpg", "doc", ".pdf")).toBe("scan.pdf");
    expect(sanitizeFilename("scan.png", "doc", ".pdf")).toBe("scan.pdf");
  });
});

describe("deriveExtension", () => {
  it("derives from MIME type", () => {
    expect(deriveExtension("application/pdf", null)).toBe(".pdf");
    expect(deriveExtension("image/jpeg", null)).toBe(".jpg");
    expect(deriveExtension("image/png", null)).toBe(".png");
    expect(deriveExtension("image/webp", null)).toBe(".webp");
    expect(deriveExtension("image/svg+xml", null)).toBe(".svg");
  });
  it("derives from URL when MIME is missing", () => {
    expect(deriveExtension(null, "/doc.pdf")).toBe(".pdf");
    expect(deriveExtension(null, "/photo.JPG")).toBe(".jpg");
    expect(deriveExtension(null, "/image.jpeg")).toBe(".jpg");
    expect(deriveExtension(null, "/pic.webp?x=1")).toBe(".webp");
  });
  it("returns empty string for unknown types", () => {
    expect(deriveExtension("application/zip", "/file.zip")).toBe("");
    expect(deriveExtension(null, "/noext")).toBe("");
    expect(deriveExtension(null, null)).toBe("");
  });
  it("prefers MIME over URL", () => {
    expect(deriveExtension("image/png", "/photo.jpg")).toBe(".png");
  });
});

describe("asset type detection", () => {
  it("isPdfAsset detects by mime", () => {
    expect(isPdfAsset(asset({ mime_type: "application/pdf" }))).toBe(true);
  });
  it("isPdfAsset detects by extension", () => {
    expect(isPdfAsset(asset({ mime_type: null, file_url: "/doc.PDF" }))).toBe(true);
  });
  it("isPdfAsset rejects images", () => {
    expect(isPdfAsset(asset({ mime_type: "image/jpeg", file_url: "/img.jpg" }))).toBe(false);
  });
  it("isImageAsset detects by mime", () => {
    expect(isImageAsset(asset({ mime_type: "image/png", file_url: "/x" }))).toBe(true);
  });
  it("isImageAsset detects by extension", () => {
    expect(isImageAsset(asset({ mime_type: null, file_url: "/photo.webp" }))).toBe(true);
  });
  it("isSvgAsset detects SVG", () => {
    expect(isSvgAsset(asset({ mime_type: "image/svg+xml", file_url: "/x" }))).toBe(true);
    expect(isSvgAsset(asset({ mime_type: null, file_url: "/diagram.svg" }))).toBe(true);
  });
  it("canPreviewAsset covers PDF and images", () => {
    expect(canPreviewAsset(asset({ mime_type: "application/pdf" }))).toBe(true);
    expect(canPreviewAsset(asset({ mime_type: "image/jpeg", file_url: "/x.jpg" }))).toBe(true);
    expect(canPreviewAsset(asset({ mime_type: "application/zip", file_url: "/x.zip" }))).toBe(false);
  });
});

describe("WeChat detection", () => {
  it("detects WeChat browser", () => {
    expect(isWeChatBrowser("Mozilla/5.0 (Linux; Android 10) MicroMessenger/8.0")).toBe(true);
  });
  it("detects non-WeChat browser", () => {
    expect(isWeChatBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) Safari/604")).toBe(false);
  });
  it("handles empty UA", () => {
    expect(isWeChatBrowser("")).toBe(false);
  });
  it("detects Enterprise WeChat (WeCom)", () => {
    expect(isWeComBrowser("Mozilla/5.0 wxwork/4.1.27 MicroMessenger")).toBe(true);
  });
  it("WeCom is also WeChat", () => {
    const ua = "Mozilla/5.0 wxwork/4.1.27 MicroMessenger";
    expect(isWeChatBrowser(ua)).toBe(true);
    expect(isWeComBrowser(ua)).toBe(true);
  });
});

describe("page and zoom bounds", () => {
  it("clampPage clamps to [1, total]", () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(5, 10)).toBe(5);
    expect(clampPage(15, 10)).toBe(10);
    expect(clampPage(-1, 10)).toBe(1);
  });
  it("clampPage returns 1 for invalid total", () => {
    expect(clampPage(5, 0)).toBe(1);
    expect(clampPage(5, -1)).toBe(1);
    expect(clampPage(5, NaN)).toBe(1);
  });
  it("clampZoom clamps to [ZOOM_MIN, ZOOM_MAX]", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(10)).toBe(ZOOM_MAX);
  });
  it("clampZoom handles invalid values", () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(-5)).toBe(1);
  });
  it("snapZoom rounds to 0.25 steps", () => {
    expect(snapZoom(1.1)).toBe(1);
    expect(snapZoom(1.3)).toBe(1.25);
    expect(snapZoom(2.4)).toBe(2.5);
  });
});

describe("error mapping", () => {
  it("maps password errors", () => {
    expect(mapPdfError(new Error("Password required"))).toBe("password");
  });
  it("maps CORS errors", () => {
    expect(mapPdfError(new Error("Cross-origin access denied"))).toBe("cors");
  });
  it("maps 404 errors", () => {
    expect(mapPdfError(new Error("404 not found"))).toBe("not_found");
  });
  it("maps network errors", () => {
    expect(mapPdfError(new Error("failed to fetch"))).toBe("network");
  });
  it("maps timeout errors", () => {
    expect(mapPdfError(new Error("timeout"))).toBe("timeout");
  });
  it("maps corrupted PDF errors", () => {
    expect(mapPdfError(new Error("invalid PDF format"))).toBe("corrupted");
  });
  it("maps unknown errors", () => {
    expect(mapPdfError(new Error("something else"))).toBe("unknown");
    expect(mapPdfError(null)).toBe("unknown");
  });
  it("provides localized messages", () => {
    expect(viewerErrorMessage("password", "zh")).toContain("密码");
    expect(viewerErrorMessage("password", "en")).toContain("password");
    expect(viewerErrorMessage("timeout", "zh")).toContain("超时");
    expect(viewerErrorMessage("timeout", "en")).toContain("timed out");
  });
});

describe("formatProductAssetSize", () => {
  it("formats bytes", () => {
    expect(formatProductAssetSize(512)).toBe("512 B");
  });
  it("formats kilobytes", () => {
    expect(formatProductAssetSize(2048)).toBe("2.0 KB");
  });
  it("formats megabytes", () => {
    expect(formatProductAssetSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
  it("returns null for null input", () => {
    expect(formatProductAssetSize(null)).toBe(null);
  });
});
