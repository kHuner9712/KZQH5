"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/i18n/config";
import { mapPdfError, type ViewerErrorKind } from "@/lib/client/viewer-utils";

// We import the legacy build for broad compatibility (WeChat, older Android
// Chromium). The worker file is copied to public/lib/pdfjs/ at build time.
const PDFJS_IMPORT = "pdfjs-dist/legacy/build/pdf.mjs" as const;
const WORKER_SRC = "/lib/pdfjs/pdf.worker.min.mjs" as const;
const LOAD_TIMEOUT_MS = 30_000;

// Minimal type surface we use from pdf.js. We keep it loose to avoid coupling
// to the full pdfjs-dist type package (which would bloat the editor types).
interface PdfPageProxy {
  render(params: { canvasContext: CanvasRenderingContext2D; transform?: number[]; viewport: unknown }): { promise: Promise<void>; cancel: () => void };
  getViewport(params: { scale: number; rotation?: number }): { width: number; height: number };
}
interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  destroy: () => Promise<void>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  destroy: () => Promise<void>;
}
interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string; workerPort: unknown };
  getDocument(params: { url: string }): PdfLoadingTask;
}

// Cache the dynamic import so the module is only loaded once per session.
let pdfjsPromise: Promise<PdfjsModule> | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = (await import(/* webpackChunkName: "pdfjs" */ PDFJS_IMPORT)) as PdfjsModule;
      mod.GlobalWorkerOptions.workerSrc = WORKER_SRC;
      return mod;
    })();
  }
  return pdfjsPromise;
}

export interface PdfDocumentState {
  status: "idle" | "loading" | "ready" | "error";
  errorKind: ViewerErrorKind | null;
  document: PdfDocumentProxy | null;
  pageCount: number;
}

export function usePdfDocument(url: string | null, locale: Locale) {
  const [state, setState] = useState<PdfDocumentState>({
    status: "idle",
    errorKind: null,
    document: null,
    pageCount: 0,
  });
  // Token to ignore stale loads when the URL changes quickly.
  const loadToken = useRef(0);
  const activeDoc = useRef<PdfDocumentProxy | null>(null);

  const load = useCallback(async () => {
    if (!url) return;
    const token = ++loadToken.current;
    setState({ status: "loading", errorKind: null, document: null, pageCount: 0 });

    const timeoutController = new AbortController();
    const timer = window.setTimeout(() => timeoutController.abort(), LOAD_TIMEOUT_MS);

    try {
      const pdfjs = await loadPdfjs();
      if (token !== loadToken.current) return; // superseded

      const loadingTask = pdfjs.getDocument({ url });
      // Attach abort: pdf.js doesn't natively honour AbortSignal, but we can
      // destroy the document after the fact if the timeout fires.
      const onTimeout = () => {
        loadingTask.destroy();
        if (token === loadToken.current) {
          setState({ status: "error", errorKind: "timeout", document: null, pageCount: 0 });
        }
      };
      timeoutController.signal.addEventListener("abort", onTimeout, { once: true });

      const doc = await loadingTask.promise;
      window.clearTimeout(timer);

      if (token !== loadToken.current) {
        doc.destroy();
        return;
      }
      activeDoc.current = doc;
      setState({ status: "ready", errorKind: null, document: doc, pageCount: doc.numPages });
    } catch (error) {
      window.clearTimeout(timer);
      if (token !== loadToken.current) return;
      const kind = mapPdfError(error);
      setState({ status: "error", errorKind: kind, document: null, pageCount: 0 });
    }
  }, [url]);

  useEffect(() => {
    if (url) void load();
    return () => {
      // Incrementing the token invalidates any in-flight load (the loader
      // checks token === loadToken.current before applying state).
      // Refs are stable; this is the standard cancellation pattern.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadToken.current += 1;
      const doc = activeDoc.current;
      activeDoc.current = null;
      if (doc) void doc.destroy();
    };
  }, [url, load]);

  return { state, retry: load };
}

export type { PdfDocumentProxy, PdfPageProxy };
