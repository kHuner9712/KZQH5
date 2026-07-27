import { expect, test } from "@playwright/test";

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

// Next.js 15 / React 19 Suspense streaming can briefly duplicate catalog
// topic cards while the loading.tsx fallback is replaced by the resolved
// Server Component content. Wait for the element to be unique AND stable
// across multiple samples before clicking, to avoid Playwright strict-mode
// violations from a transient 2→1 count race.
//
// The "stable unique" wait:
//   1. loading.tsx fallback must be gone (no [role="status"][aria-label*="加载"])
//   2. target count sampled 3 times with 50ms gap must be 1 every time
//   3. the single element must be visible with a non-empty bounding box
//
// If the count is persistently >1, the click is NOT forced — the helper
// throws with a diagnostic dump so the production duplicate-render can be
// fixed instead of masking it with locator.first() / force:true.
async function clickCatalogTopic(page: import("@playwright/test").Page, topicId: string) {
  const testId = `catalog-topic-${topicId}`;
  const locator = page.getByTestId(testId);

  // Step 1: ensure the loading fallback has been replaced by real content.
  // The PublicLoading component renders role="status" with an aria-label
  // containing "加载" / "Loading". If it is still in the DOM, the resolved
  // tree has not committed yet.
  const loadingFallback = page.locator(
    '[role="status"][aria-label*="加载"], [role="status"][aria-label*="Loading"]',
  );
  await expect(loadingFallback).toHaveCount(0, { timeout: 30_000 });

  // Step 2: sample the count 3 times with a 50ms gap. A single
  // `toHaveCount(1)` can pass during a 2→1→2 transient; requiring 3
  // consecutive stable-1 samples eliminates that race without adding a
  // blind timeout.
  for (let sample = 0; sample < 3; sample++) {
    await expect(locator).toHaveCount(1, { timeout: 30_000 });
    if (sample < 2) await page.waitForTimeout(50);
  }

  // Step 3: ensure the single element is visible and clickable before
  // issuing the real click. Playwright's auto-wait already does this, but
  // an explicit visibility check produces a clearer error message if the
  // element is present but hidden (e.g., display:none during transition).
  await expect(locator).toBeVisible();

  try {
    await locator.click();
  } catch (clickError) {
    // If the click still fails (DOM mutated between the stable-1 sample
    // and the click), capture a diagnostic snapshot BEFORE re-throwing so
    // the failure message contains actionable context instead of just
    // "strict mode violation: resolved to N elements".
    const diagnostics = await page.evaluate(
      (id) => {
        const els = document.querySelectorAll(`[data-testid="${id}"]`);
        const samples: string[] = [];
        els.forEach((el, index) => {
          const rect = el.getBoundingClientRect();
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            window.getComputedStyle(el).visibility !== "hidden" &&
            window.getComputedStyle(el).display !== "none";
          const tag = el.tagName.toLowerCase();
          const cls = el.className?.toString().slice(0, 80) || "";
          const ancestor = el.parentElement?.tagName.toLowerCase() || "";
          const grandAncestor =
            el.parentElement?.parentElement?.tagName.toLowerCase() || "";
          samples.push(
            `[${index}] <${tag} class="${cls}"> visible=${visible} box={x:${Math.round(rect.x)},y:${Math.round(rect.y)},w:${Math.round(rect.width)},h:${Math.round(rect.height)}} ancestors=${ancestor}>${grandAncestor}`,
          );
        });
        const fallback = document.querySelector(
          '[role="status"][aria-label*="加载"], [role="status"][aria-label*="Loading"]',
        );
        return {
          count: els.length,
          url: location.href,
          loadingFallbackPresent: !!fallback,
          samples,
        };
      },
      testId,
    );
    process.stderr.write(
      `[clickCatalogTopic:${testId}] click failed; diagnostics:\n` +
        `  count=${diagnostics.count} url=${diagnostics.url}\n` +
        `  loadingFallbackPresent=${diagnostics.loadingFallbackPresent}\n` +
        diagnostics.samples.map((s) => `  ${s}`).join("\n") +
        "\n",
    );
    throw clickError;
  }
}

test.describe("Demo catalog center", () => {
  test.beforeEach(async () => {
    // PDF.js worker init + PDF fetch + first page render can take 20-30s
    // on shared GitHub runners. The default 30s test timeout is too tight
    // for the PDF canvas visibility assertion (which itself allows 30s).
    // Bump to 90s so the assertion has room to complete.
    test.setTimeout(90_000);
  });

  test("Chinese catalog topics, image preview, PDF preview and inquiry fallback", async ({ page, request }) => {
    await page.goto("/documents");
    await expect(page.getByRole("heading", { level: 1, name: "产品目录与色卡" })).toBeVisible();
    await expect(page.locator('[data-testid^="catalog-topic-"]')).toHaveCount(21);
    await expect(page.getByText("4 个已匹配文件")).toBeVisible();

    // Image (SVG) preview via ImageViewer — should render an <img>, not an iframe.
    // The <img> is mounted immediately but is not "visible" (non-empty bounding
    // box) until the SVG actually loads — match the PDF canvas pattern with a
    // generous timeout.
    await clickCatalogTopic(page, "color-card");
    const imgDialog = page.getByRole("dialog", { name: "KZQ 综合色卡" });
    await expect(imgDialog).toBeVisible();
    await expect(imgDialog.locator("img")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(imgDialog).toHaveCount(0);

    // Inquiry fallback for a topic without a published asset.
    await clickCatalogTopic(page, "gz-series");
    await expect(page).toHaveURL(/\/contact\?.*product=/);
    await expectNoHorizontalOverflow(page);

    // PDF preview via PdfViewer — should render a <canvas>.
    // CI runners are slower than local dev; pdf.js worker init + PDF fetch
    // + first page render can exceed 15s on a shared runner. The hook's own
    // load timeout is 30s, so allow the canvas visibility assertion the
    // same window rather than failing before the load even completes.
    await page.goto("/documents");
    await clickCatalogTopic(page, "hd-spc-catalog");
    const pdfDialog = page.getByRole("dialog", { name: "HD / SPC 测试样本" });
    await expect(pdfDialog).toBeVisible();
    // The hook's LOAD_TIMEOUT_MS is 30s. On a slow CI runner, pdf.js worker
    // init + PDF fetch + first page render can approach that limit. Give the
    // canvas assertion 60s (2x the load timeout) so it doesn't fail just
    // because the load completed at 28s and the page render needed 2s more.
    await expect(pdfDialog.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press("Escape");
    await expect(pdfDialog).toHaveCount(0);

    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.ok()).toBe(true);
    const sitemapText = await sitemap.text();
    expect(sitemapText).toContain("/documents");
    expect(sitemapText).toContain("/en/documents");
  });

  test("English catalog route and preview", async ({ page }) => {
    await page.goto("/en/documents");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1, name: "Catalogs & Color Cards" })).toBeVisible();
    await expect(page.locator('[data-testid^="catalog-topic-"]')).toHaveCount(21);
    await clickCatalogTopic(page, "wpc-wall-panel");
    await expect(page.getByRole("dialog", { name: "WPC Wall Panel Catalog" })).toBeVisible();
    await page.getByTestId("viewer-close").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("PDF viewer page navigation and accessible names", async ({ page }) => {
    // 1. Check Chinese routing and translations
    await page.goto("/documents");
    await clickCatalogTopic(page, "hd-spc-catalog");
    let dialog = page.getByRole("dialog", { name: "HD / SPC 测试样本" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("canvas")).toBeVisible({ timeout: 60_000 });

    // Check accessible names in Chinese
    await expect(dialog.getByTestId("pdf-next-page")).toHaveAttribute("aria-label", "下一页");
    await expect(dialog.getByTestId("pdf-prev-page")).toHaveAttribute("aria-label", "上一页");
    await expect(dialog.getByTestId("pdf-page-input")).toHaveAttribute("aria-label", "跳转到页");

    await dialog.getByTestId("pdf-next-page").click();
    await expect(dialog.getByTestId("pdf-page-input")).toHaveValue("2");
    await dialog.getByTestId("pdf-prev-page").click();
    await expect(dialog.getByTestId("pdf-page-input")).toHaveValue("1");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // 2. Check English routing and translations
    await page.goto("/en/documents");
    await clickCatalogTopic(page, "hd-spc-catalog");
    dialog = page.getByRole("dialog", { name: "HD / SPC Test Sample" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("canvas")).toBeVisible({ timeout: 60_000 });

    // Check accessible names in English
    await expect(dialog.getByTestId("pdf-next-page")).toHaveAttribute("aria-label", "Next");
    await expect(dialog.getByTestId("pdf-prev-page")).toHaveAttribute("aria-label", "Previous");
    await expect(dialog.getByTestId("pdf-page-input")).toHaveAttribute("aria-label", "Jump to page");
    await expect(dialog.getByTestId("pdf-zoom-in")).toHaveAttribute("aria-label", "Zoom in");

    await dialog.getByTestId("pdf-zoom-in").click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("WeChat UA does not block PDF preview", async ({ browser }) => {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Linux; Android 12) MicroMessenger/8.0.40",
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto("/documents");
    await clickCatalogTopic(page, "hd-spc-catalog");
    const dialog = page.getByRole("dialog", { name: "HD / SPC 测试样本" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await context.close();
  });

  test("image asset preview is unaffected", async ({ page }) => {
    await page.goto("/en/documents");
    await clickCatalogTopic(page, "edge-finishing");
    const dialog = page.getByRole("dialog", { name: "Fluted Wall Panel Edge Finishing Solutions" });
    await expect(dialog).toBeVisible();
    // The <img> mounts immediately, but the SVG must load before it has a
    // non-empty bounding box. Match the PDF canvas pattern with a timeout.
    await expect(dialog.locator("img")).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator("canvas")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("image viewer shows error recovery UI when image fails to load", async ({ page }) => {
    // Intercept the SVG asset request and return 404 to trigger onError.
    await page.route("**/demo/catalogs/edge-finishing.svg", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" }),
    );

    await page.goto("/en/documents");
    await clickCatalogTopic(page, "edge-finishing");
    const dialog = page.getByRole("dialog", { name: "Fluted Wall Panel Edge Finishing Solutions" });
    await expect(dialog).toBeVisible();

    // The shared ViewerError UI should appear with an alert role.
    const alert = dialog.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 10_000 });

    // Recovery actions are present inside the alert (scoped to avoid the
    // toolbar's own "Open in browser" link, which also matches the role).
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(alert.getByRole("link", { name: "Open in browser" })).toBeVisible();
    await expect(alert.getByRole("button", { name: "Download" })).toBeVisible();

    // Escape closes the dialog.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});
