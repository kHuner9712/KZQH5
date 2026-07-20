import { describe, expect, it } from "vitest";
import {
  validateAssetUrl,
  sanitizeFilename,
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
  it("accepts http for local dev", () => {
    expect(validateAssetUrl("http://localhost:3000/test.pdf").ok).toBe(true);
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
  it("rejects empty URLs", () => {
    expect(validateAssetUrl("").ok).toBe(false);
    expect(validateAssetUrl("   ").ok).toBe(false);
  });
  it("rejects malformed URLs", () => {
    expect(validateAssetUrl("not a url at all").ok).toBe(false);
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
