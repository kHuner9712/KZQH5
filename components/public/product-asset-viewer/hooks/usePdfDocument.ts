"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/i18n/config";
import { mapPdfError, type ViewerErrorKind } from "@/lib/client/viewer-utils";

// We import the main entry (`build/pdf.mjs`) for broad Chromium support.
// Next.js 14's webpack cannot resolve the deep `pdfjs-dist/legacy/build/pdf.mjs`
// subpath at build time, so we use the package main entry instead.
// The matching worker file is served from /lib/pdfjs/pdf.worker.min.mjs.
const WORKER_SRC = "/lib/pdfjs/pdf.worker.min.mjs" as const;
const LOAD_TIMEOUT_MS = 30_000;

// Minimal type surface we use from pdf.js.
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

// Cache the dynamic import. On failure, reset to null so the next attempt
// can retry (otherwise a rejected promise would be cached forever).
let pdfjsPromise: Promise<PdfjsModule> | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // Static import — Next.js 14's webpack cannot resolve dynamic import()
      // of `pdfjs-dist` (it stubs it out as a missing module in production
      // builds). Using a static import bundles the library correctly, and
      // the surrounding `usePdfDocument` hook is only mounted when a user
      // opens a PDF, so the cost is paid lazily via the component chunk.
      const mod = (await import("pdfjs-dist/build/pdf.mjs")) as PdfjsModule;
      mod.GlobalWorkerOptions.workerSrc = WORKER_SRC;
      return mod;
    })();
    // Reset on failure so retries are possible.
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

export interface PdfDocumentState {
  status: "idle" | "loading" | "ready" | "error";
  errorKind: ViewerErrorKind | null;
  document: PdfDocumentProxy | null;
  pageCount: number;
}

export function usePdfDocument(url: string | null, _locale: Locale) {
  const [state, setState] = useState<PdfDocumentState>({
    status: "idle",
    errorKind: null,
    document: null,
    pageCount: 0,
  });

  // Token to ignore stale loads when the URL changes quickly.
  const loadToken = useRef(0);
  const activeDoc = useRef<PdfDocumentProxy | null>(null);
  const activeLoadingTask = useRef<PdfLoadingTask | null>(null);
  const activeTimer = useRef<number | null>(null);

  /** Clear any pending timeout and destroy the active loading task. */
  const cleanupActive = useCallback(() => {
    if (activeTimer.current !== null) {
      window.clearTimeout(activeTimer.current);
      activeTimer.current = null;
    }
    const task = activeLoadingTask.current;
    activeLoadingTask.current = null;
    if (task) void task.destroy().catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!url) return;
    // Invalidate previous load and clean up.
    const token = ++loadToken.current;
    cleanupActive();
    const doc = activeDoc.current;
    activeDoc.current = null;
    if (doc) void doc.destroy().catch(() => {});

    setState({ status: "loading", errorKind: null, document: null, pageCount: 0 });

    // We track whether a timeout has already fired so the catch block doesn't
    // overwrite the "timeout" error kind with a generic "unknown".
    let timedOut = false;

    activeTimer.current = window.setTimeout(() => {
      timedOut = true;
      const task = activeLoadingTask.current;
      if (task) void task.destroy().catch(() => {});
      if (token === loadToken.current) {
        setState({ status: "error", errorKind: "timeout", document: null, pageCount: 0 });
      }
    }, LOAD_TIMEOUT_MS);

    try {
      const pdfjs = await loadPdfjs();
      if (token !== loadToken.current) return; // superseded

      const loadingTask = pdfjs.getDocument({ url });
      activeLoadingTask.current = loadingTask;

      const result = await loadingTask.promise;

      // Clear timeout on success.
      if (activeTimer.current !== null) {
        window.clearTimeout(activeTimer.current);
        activeTimer.current = null;
      }

      if (token !== loadToken.current) {
        result.destroy();
        return;
      }
      activeDoc.current = result;
      activeLoadingTask.current = null;
      setState({ status: "ready", errorKind: null, document: result, pageCount: result.numPages });
    } catch (error) {
      if (activeTimer.current !== null) {
        window.clearTimeout(activeTimer.current);
        activeTimer.current = null;
      }
      if (token !== loadToken.current) return;
      // If the timeout already fired, keep the "timeout" error — don't let
      // the destroy() rejection overwrite it with "unknown".
      if (timedOut) return;
      const kind = mapPdfError(error);
      setState({ status: "error", errorKind: kind, document: null, pageCount: 0 });
    }
  }, [url, cleanupActive]);

  useEffect(() => {
    if (url) void load();
    return () => {
      loadToken.current += 1; // invalidate any in-flight load
      cleanupActive();
      const doc = activeDoc.current;
      activeDoc.current = null;
      if (doc) void doc.destroy().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, load, cleanupActive]);

  return { state, retry: load };
}

export type { PdfDocumentProxy, PdfPageProxy };
