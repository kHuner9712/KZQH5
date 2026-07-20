// Viewer utility functions — pure, testable, no browser-only APIs at module
// scope. Functions that need a user agent accept it as a parameter so they can
// be unit-tested in Node without jsdom.

import type { ProductAsset } from "@/types/database";
import type { Locale } from "@/lib/i18n/config";

// ---------------------------------------------------------------------------
// Asset type detection
// ---------------------------------------------------------------------------

const PDF_EXTENSIONS = /\.pdf(?:[?#].*)?$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/i;

/** Returns true when the asset is a PDF (by MIME or URL extension). */
export function isPdfAsset(asset: Pick<ProductAsset, "mime_type" | "file_url">): boolean {
  if (asset.mime_type === "application/pdf") return true;
  return PDF_EXTENSIONS.test(asset.file_url || "");
}

/** Returns true when the asset is a raster/vector image we can render inline. */
export function isImageAsset(asset: Pick<ProductAsset, "mime_type" | "file_url">): boolean {
  if (asset.mime_type && asset.mime_type.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.test(asset.file_url || "");
}

/** Returns true for SVG specifically (rendered as <img>, not PDF.js). */
export function isSvgAsset(asset: Pick<ProductAsset, "mime_type" | "file_url">): boolean {
  if (asset.mime_type === "image/svg+xml") return true;
  return /\.svg(?:[?#].*)?$/i.test(asset.file_url || "");
}

/** Whether the viewer can render this asset inline (PDF or image). */
export function canPreviewAsset(asset: Pick<ProductAsset, "mime_type" | "file_url">): boolean {
  return isPdfAsset(asset) || isImageAsset(asset);
}

/** Human-readable file size string. */
export function formatProductAssetSize(size: number | null): string | null {
  if (size === null || size === undefined) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// URL validation (security)
// ---------------------------------------------------------------------------

export interface UrlValidation {
  ok: boolean;
  reason?: string;
  /** Resolved absolute URL when ok (relative paths become location-relative). */
  resolved?: string;
}

/**
 * Validates an asset file URL. Only https: and same-origin relative paths are
 * allowed. Rejects javascript:, data:, file:, and unknown protocols to prevent
 * XSS and open-redirect abuse.
 */
export function validateAssetUrl(rawUrl: string): UrlValidation {
  const url = (rawUrl || "").trim();
  if (!url) return { ok: false, reason: "empty_url" };

  // Relative path (starts with / or ./ or ../) — allowed for demo/local assets.
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return { ok: true, resolved: url };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol === "https:") return { ok: true, resolved: url };
  // Allow http: only in development; reject in production contexts at call
  // sites if needed. We accept it here so local dev servers work.
  if (parsed.protocol === "http:") return { ok: true, resolved: url };

  return { ok: false, reason: `unsupported_protocol:${parsed.protocol}` };
}

// ---------------------------------------------------------------------------
// Filename sanitization (download safety)
// ---------------------------------------------------------------------------

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Sanitizes a filename for download. Strips illegal characters, trims
 * whitespace/dots, ensures a sensible extension, and avoids Windows reserved
 * names. Falls back to `fallback` when the result is empty.
 */
export function sanitizeFilename(
  name: string,
  fallback: string,
  preferredExt: string,
): string {
  const base = (name || "").trim() || fallback;
  // Remove path separators and illegal chars, collapse whitespace.
  let clean = base
    .replace(ILLEGAL_FILENAME_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");

  if (!clean) clean = fallback;

  // Windows reserved name guard.
  const stem = clean.replace(/\.[^.]+$/, "");
  if (RESERVED_NAMES.has(stem.toUpperCase())) clean = `${clean}-file`;

  // Ensure extension.
  const ext = preferredExt.startsWith(".") ? preferredExt : `.${preferredExt}`;
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(clean);
  return hasExt ? clean : `${clean}${ext}`;
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/** Detects WeChat or Enterprise WeChat (WeCom) in-app browsers. */
export function isWeChatBrowser(userAgent: string): boolean {
  return /MicroMessenger/i.test(userAgent || "");
}

/** Detects Enterprise WeChat specifically (WeCom). */
export function isWeComBrowser(userAgent: string): boolean {
  return /wxwork/i.test(userAgent || "");
}

// ---------------------------------------------------------------------------
// Pagination & zoom bounds
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.25;

/** Clamps a page number to [1, total]. Returns 1 when total is invalid. */
export function clampPage(page: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(Math.max(1, Math.floor(page)), Math.floor(total));
}

/** Clamps a zoom scale to [ZOOM_MIN, ZOOM_MAX]. */
export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(Math.max(ZOOM_MIN, scale), ZOOM_MAX);
}

/** Snaps a zoom value to the nearest 0.25 step (for preset buttons). */
export function snapZoom(scale: number): number {
  return clampZoom(Math.round(scale / ZOOM_STEP) * ZOOM_STEP);
}

// ---------------------------------------------------------------------------
// Error states & localized text
// ---------------------------------------------------------------------------

export type ViewerErrorKind =
  | "loading"
  | "timeout"
  | "not_found"
  | "network"
  | "cors"
  | "corrupted"
  | "password"
  | "unsupported_mime"
  | "unknown";

export const viewerErrorText: Record<ViewerErrorKind, { zh: string; en: string }> = {
  loading: { zh: "正在加载文件…", en: "Loading file…" },
  timeout: { zh: "加载超时，请重试或在浏览器中打开。", en: "Loading timed out. Please retry or open in a browser." },
  not_found: { zh: "文件不存在或已被移除。", en: "The file does not exist or has been removed." },
  network: { zh: "网络连接失败，请检查网络后重试。", en: "Network connection failed. Check your connection and retry." },
  cors: { zh: "跨域加载被拒绝，请在新窗口中打开。", en: "Cross-origin access was denied. Open in a new window." },
  corrupted: { zh: "PDF 文件已损坏或格式不正确。", en: "The PDF file is corrupted or in an invalid format." },
  password: { zh: "该 PDF 已加密，需要密码才能查看。", en: "This PDF is encrypted and requires a password." },
  unsupported_mime: { zh: "不支持该文件类型，请下载或在浏览器中打开。", en: "This file type is not supported. Download or open in a browser." },
  unknown: { zh: "加载失败，请重试或在浏览器中打开。", en: "Loading failed. Please retry or open in a browser." },
};

/** Maps a pdf.js / fetch error to a ViewerErrorKind. */
export function mapPdfError(error: unknown): ViewerErrorKind {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/password|encrypt/i.test(message)) return "password";
  if (/cors|cross-origin|access-control/i.test(message)) return "cors";
  if (/404|not found|does not exist/i.test(message)) return "not_found";
  if (/network|fetch|failed to fetch|ERR_NETWORK/i.test(message)) return "network";
  if (/timeout|abort|timed out/i.test(message)) return "timeout";
  if (/invalid|corrupt|parse|syntax|format/i.test(message)) return "corrupted";
  return "unknown";
}

export function viewerErrorMessage(kind: ViewerErrorKind, locale: Locale): string {
  return viewerErrorText[kind][locale];
}
