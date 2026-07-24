// Syncs the pdf.js worker from node_modules into /public so the browser
// can fetch it at runtime. pdf.js requires the worker version to EXACTLY
// match the main library version — a mismatch causes a silent load failure
// (the worker posts an error, getDocument() rejects, and the viewer shows
// "加载失败"). Running this on every `npm ci` / `npm install` guarantees
// the public copy tracks whatever version package-lock resolved.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const src = join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const dest = join(root, "public/lib/pdfjs/pdf.worker.min.mjs");

if (!existsSync(src)) {
  // During a fresh install before deps are ready, or if pdfjs-dist was
  // pruned. Don't fail the install — the build will catch the missing
  // worker when the PDF viewer tries to use it.
  console.warn("[sync-pdfjs-worker] source not found, skipping:", src);
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("[sync-pdfjs-worker] synced", src, "→", dest);
