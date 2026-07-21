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
 * Validates an asset file URL.
 *
 * Production policy:
 *   - Protocol-relative URLs (`//host/...`) are ALWAYS rejected — they resolve
 *     to https/http against the *attacker's* host and bypass protocol checks.
 *   - https: always allowed.
 *   - Same-origin relative paths (/, ./, ../) always allowed.
 *   - http: ONLY allowed for localhost, 127.0.0.1, and [::1] (dev servers).
 *     Any public HTTP URL is rejected.
 *   - javascript:, data:, file:, vbscript:, blob:, and any other protocol
 *     are always rejected.
 *
 * `baseOrigin` is only used to compare resolved origins for relative paths
 * (so `new URL("../x", base)` cannot escape to a different host). It defaults
 * to a placeholder and is only required when you want strict same-origin
 * enforcement on resolved URLs.
 */
export function validateAssetUrl(
  rawUrl: string,
  allowHttpForTesting: boolean = false,
  baseOrigin: string = "https://kzq.local",
): UrlValidation {
  const url = (rawUrl || "").trim();
  if (!url) return { ok: false, reason: "empty_url" };

  // Reject protocol-relative URLs explicitly — they start with "//" and the
  // browser would resolve them against the *current page's* protocol, allowing
  // a redirect to an attacker-controlled https/http origin.
  if (url.startsWith("//")) {
    return { ok: false, reason: "protocol_relative_url" };
  }

  // Same-origin relative paths (/, ./, ../). We still parse via URL to make
  // sure they don't escape the base origin (e.g. "/\\evil.com/x" tricks).
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    try {
      const resolved = new URL(url, baseOrigin);
      // If the relative path somehow resolves to a different origin, reject.
      if (resolved.origin !== new URL(baseOrigin).origin) {
        return { ok: false, reason: "origin_escape" };
      }
      // Return the original (still relative) form — callers expect to render
      // it as a same-origin path, not an absolute URL.
      return { ok: true, resolved: url };
    } catch {
      return { ok: false, reason: "invalid_url" };
    }
  }

  let parsed: URL;
  try {
    // Parse WITHOUT a base — bare strings like "not a url at all" must NOT be
    // silently turned into same-origin paths. The browser would do that, but
    // for an asset URL we require an explicit scheme or a `/`/`./`/`../`
    // prefix (handled above).
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  // Reject any backslash trickery that URL parses to a different protocol.
  if (parsed.protocol === "https:") {
    return { ok: true, resolved: parsed.href };
  }

  if (parsed.protocol === "http:") {
    // Allow http only for loopback / localhost dev servers.
    const host = parsed.hostname.toLowerCase();
    if (
      allowHttpForTesting ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1"
    ) {
      return { ok: true, resolved: parsed.href };
    }
    return { ok: false, reason: `insecure_http:${host}` };
  }

  // Everything else (javascript:, data:, file:, vbscript:, blob:, ws:, ftp:, …).
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

const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/gif": ".gif",
};

/** Derives a file extension (with leading dot) from MIME type or URL. */
export function deriveExtension(mime: string | null | undefined, url: string | null | undefined): string {
  if (mime) {
    const ext = MIME_TO_EXT[mime.toLowerCase()];
    if (ext) return ext;
  }
  if (url) {
    const match = url.match(/\.(pdf|jpe?g|png|webp|svg|gif)(?:[?#].*)?$/i);
    if (match) return match[1].toLowerCase() === "jpeg" ? ".jpg" : `.${match[1].toLowerCase()}`;
  }
  return "";
}

/**
 * Sanitizes a filename for download. Strips illegal characters, trims
 * whitespace/dots, ensures a sensible extension, and avoids Windows reserved
 * names. Falls back to `fallback` when the result is empty.
 *
 * When `preferredExt` is empty, no extension is appended.
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

  // Ensure extension — but only when preferredExt is non-empty.
  const ext = preferredExt && !preferredExt.startsWith(".") ? `.${preferredExt}` : preferredExt || "";
  if (!ext) return clean;

  const currentExtMatch = clean.match(/\.[a-z0-9]{2,5}$/i);
  const currentExt = currentExtMatch ? currentExtMatch[0].toLowerCase() : "";

  // If the target is a PDF, force .pdf (replace existing if any)
  if (ext.toLowerCase() === ".pdf") {
    return currentExt ? clean.slice(0, -currentExt.length) + ext : `${clean}${ext}`;
  }

  // Double extension prevention: if clean already ends with ext, don't append
  if (currentExt === ext.toLowerCase()) {
    return clean;
  }

  return currentExt ? clean : `${clean}${ext}`;
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
