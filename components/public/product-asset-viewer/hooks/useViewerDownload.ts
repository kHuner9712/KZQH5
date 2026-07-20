"use client";

import { useCallback } from "react";
import { sanitizeFilename, validateAssetUrl } from "@/lib/client/viewer-utils";

export interface DownloadResult {
  ok: boolean;
  method: "blob" | "anchor" | "window";
  reason?: string;
}

/**
 * Robust download with fallback chain:
 *   1. Fetch the file as a blob and trigger a download via an object URL
 *      (works for same-origin and CORS-enabled cross-origin).
 *   2. If fetch fails (CORS/no-cors), fall back to an <a download> click
 *      (same-origin only forces download; cross-origin opens in same tab).
 *   3. Last resort: open in a new window/tab with noopener,noreferrer.
 *
 * Never fabricates a "success" — if nothing worked, returns ok:false.
 */
export function useViewerDownload() {
  return useCallback(
    async (url: string, filename: string, preferredExt: string): Promise<DownloadResult> => {
      const validation = validateAssetUrl(url);
      if (!validation.ok) {
        return { ok: false, method: "window", reason: validation.reason };
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
          return { ok: true, method: "blob" };
        }
      } catch {
        // Fall through to anchor / window fallback.
      }

      // Attempt 2: <a download> click (forces download on same-origin).
      try {
        const link = document.createElement("a");
        link.href = resolved;
        link.download = safeName;
        link.rel = "noopener noreferrer";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        // We can't confirm the download actually started for cross-origin,
        // but the click was dispatched. Return ok for same-origin.
        const isSameOrigin = !resolved.startsWith("http") ||
          new URL(resolved, window.location.href).origin === window.location.origin;
        if (isSameOrigin) return { ok: true, method: "anchor" };
      } catch {
        // Fall through.
      }

      // Attempt 3: open in a new window as a last resort.
      window.open(resolved, "_blank", "noopener,noreferrer");
      return { ok: false, method: "window", reason: "cross_origin_fallback" };
    },
    [],
  );
}
