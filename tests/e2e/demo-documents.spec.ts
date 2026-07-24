import { expect, test } from "@playwright/test";

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

// Next.js 15 / React 19 Suspense streaming can briefly duplicate catalog
// topic cards while the loading.tsx fallback is replaced by the resolved
// Server Component content. Wait for the element to be unique before
// clicking to avoid Playwright strict-mode violations.
async function clickCatalogTopic(page: import("@playwright/test").Page, topicId: string) {
  const locator = page.getByTestId(`catalog-topic-${topicId}`);
  await expect(locator).toHaveCount(1);
  await locator.click();
}

test.describe("Demo catalog center", () => {
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
    await page.goto("/documents");
    await clickCatalogTopic(page, "hd-spc-catalog");
    const pdfDialog = page.getByRole("dialog", { name: "HD / SPC 测试样本" });
    await expect(pdfDialog).toBeVisible();
    await expect(pdfDialog.locator("canvas")).toBeVisible({ timeout: 15_000 });
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
    await expect(dialog.locator("canvas")).toBeVisible({ timeout: 15_000 });
    
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
    await expect(dialog.locator("canvas")).toBeVisible({ timeout: 15_000 });

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
    await expect(dialog.locator("canvas")).toBeVisible({ timeout: 15_000 });
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
