import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Regression guard: /documents SSR must not import pdfjs-dist
//
// EdgeOne's server runtime fails the entire /documents route when
// pdfjs-dist is evaluated at module load time. The fix breaks the
// static import chain at the client-component boundary:
//
//   DocumentsPageContent (server)
//     → CatalogTopicGrid (client) — dynamic(ssr:false) ProductAssetViewer
//     → ProductAssetList  (client) — dynamic(ssr:false) ProductAssetViewer
//
// These tests verify the boundary stays in place. If someone adds a
// static `import { ProductAssetViewer }` back to either component, or
// moves productAssetTypeLabels back into the viewer module graph, these
// tests fail before the regression reaches production.
// ============================================================

const ROOT = join(import.meta.dirname, "..", "..");

function readFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("/documents SSR import boundary", () => {
  it("CatalogTopicGrid uses next/dynamic with ssr:false for ProductAssetViewer", () => {
    const source = readFile("components/public/CatalogTopicGrid.tsx");

    // Must import next/dynamic
    expect(source).toMatch(/import\s+dynamic\s+from\s+["']next\/dynamic["']/);

    // Must use dynamic(..., { ssr: false })
    expect(source).toMatch(/dynamic\s*[<{]/);
    expect(source).toMatch(/ssr:\s*false/);

    // Must access the named export via .then((mod) => mod.ProductAssetViewer)
    expect(source).toMatch(
      /import\(["']\.\/ProductAssetViewer["']\)\.then\(\s*\(mod\)\s*=>\s*mod\.ProductAssetViewer\s*\)/,
    );

    // Must NOT have a static import of the ProductAssetViewer component
    expect(source).not.toMatch(
      /import\s+\{[^}]*ProductAssetViewer[^}]*\}\s+from\s+["']\.\/ProductAssetViewer["']/,
    );
  });

  it("ProductAssetList uses next/dynamic with ssr:false for ProductAssetViewer", () => {
    const source = readFile("components/public/ProductAssetList.tsx");

    expect(source).toMatch(/import\s+dynamic\s+from\s+["']next\/dynamic["']/);
    expect(source).toMatch(/ssr:\s*false/);
    expect(source).toMatch(
      /import\(["']\.\/ProductAssetViewer["']\)\.then\(\s*\(mod\)\s*=>\s*mod\.ProductAssetViewer\s*\)/,
    );

    // Must NOT statically import ProductAssetViewer component
    expect(source).not.toMatch(
      /import\s+\{[^}]*ProductAssetViewer[^}]*\}\s+from\s+["']\.\/ProductAssetViewer["']/,
    );
  });

  it("ProductAssetList imports helpers from viewer-utils, not from the viewer wrapper", () => {
    const source = readFile("components/public/ProductAssetList.tsx");

    // formatProductAssetSize and productAssetTypeLabels must come from
    // the pdfjs-dist-free viewer-utils module, not from ./ProductAssetViewer
    // (which transitively imports PdfViewer → usePdfDocument → pdfjs-dist).
    expect(source).toMatch(
      /import\s+\{[^}]*formatProductAssetSize[^}]*productAssetTypeLabels[^}]*\}\s+from\s+["']@\/lib\/client\/viewer-utils["']/,
    );
  });

  it("viewer-utils does not import or reference pdfjs-dist", () => {
    const source = readFile("lib/client/viewer-utils.ts");

    // viewer-utils is the helper module that SSR components can safely
    // import. It must never import or require pdfjs-dist, and must never
    // touch GlobalWorkerOptions (the pdfjs side-effect that crashes SSR).
    // We check import/require statements, not comments, so documentation
    // explaining WHY the module is pdfjs-free is still allowed.
    expect(source).not.toMatch(/from\s+["']pdfjs-dist/);
    expect(source).not.toMatch(/require\(\s*["']pdfjs-dist/);
    expect(source).not.toMatch(/GlobalWorkerOptions/);
    expect(source).not.toMatch(/pdf\.worker/);
  });

  it("viewer-utils exports productAssetTypeLabels (the pdfjs-free label source)", () => {
    const source = readFile("lib/client/viewer-utils.ts");
    expect(source).toMatch(/export\s+const\s+productAssetTypeLabels/);
  });

  it("pdfjs-dist is only reachable through usePdfDocument (inside the viewer chunk)", () => {
    // Confirm the pdfjs-dist import lives in usePdfDocument.ts — this file
    // is only loaded when the dynamic ProductAssetViewer chunk is fetched
    // on the client. It must NOT be imported by any SSR-reachable module
    // outside the product-asset-viewer directory.
    const usePdfSource = readFile(
      "components/public/product-asset-viewer/hooks/usePdfDocument.ts",
    );
    expect(usePdfSource).toMatch(/from\s+["']pdfjs-dist/);

    // The wrapper re-export file must only re-export from the viewer
    // subdirectory — it should not be imported statically by SSR components.
    const wrapperSource = readFile("components/public/ProductAssetViewer.tsx");
    expect(wrapperSource).toMatch(
      /from\s+["']\.\/product-asset-viewer\/ProductAssetViewer["']/,
    );
  });
});
