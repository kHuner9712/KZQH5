// Type shim for the pdfjs-dist ESM entry. The package ships its own types
// under types/src/pdf.d.ts but TypeScript cannot resolve them when importing
// the deep `build/pdf.mjs` path. We only use a tiny surface of the API, so
// declare just what we need.
declare module "pdfjs-dist/build/pdf.mjs" {
  export interface PdfPageViewport {
    width: number;
    height: number;
  }
  export interface PdfRenderParameters {
    canvasContext: CanvasRenderingContext2D;
    transform?: number[];
    viewport: PdfPageViewport;
  }
  export interface PdfRenderTask {
    promise: Promise<void>;
    cancel: () => void;
  }
  export interface PdfPageProxy {
    getViewport(params: { scale: number; rotation?: number }): PdfPageViewport;
    render(params: PdfRenderParameters): PdfRenderTask;
  }
  export interface PdfDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPageProxy>;
    destroy(): Promise<void>;
  }
  export interface PdfLoadingTask {
    promise: Promise<PdfDocumentProxy>;
    destroy(): Promise<void>;
  }
  export const GlobalWorkerOptions: { workerSrc: string; workerPort: unknown };
  export function getDocument(params: { url: string }): PdfLoadingTask;
}

declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist/build/pdf.mjs";
}
