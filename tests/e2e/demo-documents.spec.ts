import { expect, test } from "@playwright/test";

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("Demo catalog center", () => {
  test("Chinese catalog topics, preview and inquiry fallback", async ({ page, request }) => {
    await page.goto("/documents");
    await expect(page.getByRole("heading", { level: 1, name: "产品目录与色卡" })).toBeVisible();
    await expect(page.locator('[data-testid^="catalog-topic-"]')).toHaveCount(21);
    await expect(page.getByText("3 个已匹配文件")).toBeVisible();

    await page.getByTestId("catalog-topic-color-card").click();
    const dialog = page.getByRole("dialog", { name: "KZQ 综合色卡" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("iframe")).toHaveAttribute("src", "/demo/catalogs/kzq-color-card.svg");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.getByTestId("catalog-topic-gz-series").click();
    await expect(page).toHaveURL(/\/contact\?.*product=/);
    await expectNoHorizontalOverflow(page);

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
    await page.getByTestId("catalog-topic-wpc-wall-panel").click();
    await expect(page.getByRole("dialog", { name: "WPC Wall Panel Catalog" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});
