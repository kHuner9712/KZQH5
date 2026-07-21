"use client";

import { useCallback } from "react";
import { sanitizeFilename, validateAssetUrl } from "@/lib/client/viewer-utils";

export type DownloadResult =
  | { status: "downloaded"; method: "blob" | "anchor" }
  | { status: "opened"; method: "window" }
  | { status: "blocked"; reason: string }
  | { status: "invalid"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Robust download with fallback chain:
 *   1. Fetch the file as a blob and trigger a download via an object URL
 *      (works for same-origin and CORS-enabled cross-origin).
 *   2. If fetch fails (CORS/no-cors), fall back to an <a download> click
 *      (same-origin only forces download; cross-origin opens in same tab).
 *   3. Last resort: open in a new window/tab with noopener,noreferrer.
 *
 * Never fabricates a "success" — if nothing worked, returns failed.
 */
export function useViewerDownload() {
  return useCallback(
    async (url: string, filename: string, preferredExt: string): Promise<DownloadResult> => {
      const validation = validateAssetUrl(url);
      if (!validation.ok) {
        return { status: "invalid", reason: validation.reason || "invalid_url" };
      }
      const resolved = validation.resolved || url;
      const safeName = sanitizeFilename(filename, "document", preferredExt);

      // Attempt 1: fetch → blob → object URL download.
      try {
        const response = await fetch(resolved, { mode: "cors", credentials: "same-origin" });
        if (response.ok) {
          const blob = await response.blob();
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = objectUrl;
          link.download = safeName;
          link.rel = "noopener";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          // Revoke after a delay so the browser has time to start the download.
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
          return { status: "downloaded", method: "blob" };
        }
      } catch {
        // Fall through to anchor / window fallback.
      }

      // Attempt 2: <a download> click — only meaningful for same-origin.
      // For cross-origin URLs, the `download` attribute is ignored and a click
      // would navigate the current tab. Skip the click entirely and fall
      // through to window.open.
      const isSameOrigin = !resolved.startsWith("http") ||
        new URL(resolved, window.location.href).origin === window.location.origin;
      if (isSameOrigin) {
        try {
          const link = document.createElement("a");
          link.href = resolved;
          link.download = safeName;
          link.rel = "noopener noreferrer";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          return { status: "downloaded", method: "anchor" };
        } catch {
          // Fall through.
        }
      }

      // Attempt 3: open in a new window as a last resort.
      try {
        const win = window.open(resolved, "_blank", "noopener,noreferrer");
        if (!win) {
          return { status: "blocked", reason: "popup_blocked" };
        }
        return { status: "opened", method: "window" };
      } catch (err) {
        return { status: "failed", reason: err instanceof Error ? err.message : "unknown_error" };
      }
    },
    [],
  );
}
