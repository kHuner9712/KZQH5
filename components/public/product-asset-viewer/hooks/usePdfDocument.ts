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

// Static import — Next.js's webpack cannot reliably resolve dynamic
// import() of `pdfjs-dist` in production builds (it stubs it out as a
// missing module). A static import bundles the library correctly. The
// surrounding `usePdfDocument` hook is only mounted when a user opens a
// PDF, so the cost is paid lazily via the component chunk.
//
// The `transpilePackages: ["pdfjs-dist"]` in next.config.mjs ensures
// webpack can transpile the ESM source. The webpack fallback config
// empties Node built-ins (fs, http, etc.) that pdfjs-dist references
// but are never used in the browser.
import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";

const pdfjs = pdfjsLib as unknown as PdfjsModule;
pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;

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
    // Invalidate previous load and clean up. Increment the token FIRST so any
    // in-flight promise from the previous load (including a still-pending
    // `pdfjs.getDocument()` whose timeout has not fired yet) cannot mutate
    // state once we move on.
    const token = ++loadToken.current;
    cleanupActive();
    const doc = activeDoc.current;
    activeDoc.current = null;
    if (doc) void doc.destroy().catch(() => {});

    setState({ status: "loading", errorKind: null, document: null, pageCount: 0 });

    // We track whether a timeout has already fired for THIS load token. When
    // it fires we also bump `loadToken.current` again so any subsequent
    // success/error from the in-flight loadingTask is ignored (prevents the
    // race where `await loadingTask.promise` resolves AFTER the timeout
    // already showed the user an error — the old code only guarded the
    // catch branch, not the success branch).
    let timedOut = false;

    activeTimer.current = window.setTimeout(() => {
      timedOut = true;
      // Invalidate this load token so any subsequent `setState` from the
      // in-flight try/catch (both success AND error paths) is dropped.
      // This is the fix for the timeout/success race: previously the success
      // branch only checked `token !== loadToken.current`, but the timeout
      // handler did NOT bump the token — so a late `loadingTask.promise`
      // resolution would overwrite the timeout error with "ready".
      if (token === loadToken.current) {
        loadToken.current += 1;
      }
      const task = activeLoadingTask.current;
      activeLoadingTask.current = null;
      if (task) void task.destroy().catch(() => {});
      setState({ status: "error", errorKind: "timeout", document: null, pageCount: 0 });
    }, LOAD_TIMEOUT_MS);

    try {
      // pdfjs is statically imported (module-level const), so there is no
      // async loading step. The token check is still needed in case the
      // timeout already fired while we were setting up.
      if (token !== loadToken.current) return; // superseded or timed out

      const loadingTask = pdfjs.getDocument({ url });
      activeLoadingTask.current = loadingTask;

      const result = await loadingTask.promise;

      // Clear timeout on success.
      if (activeTimer.current !== null) {
        window.clearTimeout(activeTimer.current);
        activeTimer.current = null;
      }

      // If the timeout already fired (or a new URL load replaced us), drop
      // the result and destroy it. The `timedOut` flag guards against the
      // race where the timeout bumped the token but we still got here via
      // the original `await` resuming.
      if (timedOut || token !== loadToken.current) {
        void result.destroy().catch(() => {});
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
      // If the timeout already fired, the destroy() rejection would land
      // here. Don't overwrite the "timeout" state. Also bail if a newer
      // load has superseded us.
      if (timedOut) return;
      if (token !== loadToken.current) return;
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
