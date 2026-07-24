import { expect, test } from "@playwright/test";

async function expectNoHorizontalOverflow(
  page: import("@playwright/test").Page,
) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectFixedNavigationDoesNotCoverContent(
  page: import("@playwright/test").Page,
) {
  const overlap = await page.evaluate(() => {
    const navigation = document.querySelector("nav.fixed");
    const main = document.querySelector("main");
    if (!navigation || !main) return 0;
    const navRect = navigation.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    if (navRect.height === 0) return 0;
    return Math.max(0, mainRect.bottom - navRect.top - main.scrollHeight);
  });
  expect(overlap).toBeLessThanOrEqual(1);
}

test.describe("Demo public acceptance", () => {
  test("Chinese product and inquiry flow", async ({
    page,
    request,
  }, testInfo) => {
    await page.context().setExtraHTTPHeaders({
      "x-edgeone-client-ip":
        testInfo.project.name === "mobile-chromium"
          ? "192.0.2.10"
          : "192.0.2.11",
    });
    const response = await request.get("/");
    expect(response.ok()).toBe(true);
    expect(await response.text()).toMatch(/<html[^>]+lang="zh-CN"/i);

    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.locator("main")).toBeVisible();
    await page.screenshot({
      path:
        testInfo.project.name === "mobile-chromium"
          ? "artifacts/demo-home-390x844.png"
          : "artifacts/demo-home-1440x1000.png",
      fullPage: true,
    });

    await page.goto("/products");
    const search = page.getByRole("searchbox", { name: /搜索名称/ });
    await search.fill("防火板");
    await search.press("Enter");
    await expect(page).toHaveURL(/q=/);
    await expect(page.locator("article").first()).toBeVisible();

    const category = page.locator('a[href*="category="]').first();
    await category.click();
    await expect(page).toHaveURL(/category=/);

    const productLink = page.locator('article a[href^="/products/"]').first();
    await expect(productLink).toBeAttached();
    await productLink.click();
    await expect(page).toHaveURL(/\/products\/[^/?]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page
      .getByRole("button", { name: /加入询盘/ })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: /已加入询盘/ }).first(),
    ).toBeVisible();

    await page.goto("/contact");
    await expect(page.locator("text=防火板").first()).toBeVisible();
    await page.getByLabel("姓名").fill("回归测试客户");
    await page.getByLabel("手机号").fill("13800000000");
    await expect(
      page.getByRole("main").getByRole("link", { name: "隐私政策" }),
    ).toHaveAttribute("href", "/privacy");
    await page.getByRole("button", { name: /提交询盘/ }).click();
    await expect(page.getByText("请先阅读并同意隐私政策")).toBeVisible();
    await page.getByLabel("我已阅读并同意").check();
    await page.getByRole("button", { name: /提交询盘/ }).click();
    await expect(
      page.getByRole("heading", { name: "询盘提交成功" }),
    ).toBeVisible();
    await expect(page.locator("text=已提交 1 个产品")).toBeVisible();

    await page.goto("/contact");
    await expect(page.locator("text=已选择 1")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectFixedNavigationDoesNotCoverContent(page);
  });

  test("English server language, locale switch and inquiry flow", async ({
    page,
    request,
  }, testInfo) => {
    await page.context().setExtraHTTPHeaders({
      "x-edgeone-client-ip":
        testInfo.project.name === "mobile-chromium"
          ? "192.0.2.20"
          : "192.0.2.21",
    });
    const response = await request.get("/en");
    expect(response.ok()).toBe(true);
    expect(await response.text()).toMatch(/<html[^>]+lang="en"/i);

    await page.goto("/en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const switcher = page.getByRole("link", { name: "切换到中文" }).first();
    await expect(switcher).toHaveAttribute("href", "/");

    await page.goto("/en/products?q=fire");
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
    const productLink = page
      .locator('article a[href^="/en/products/"]')
      .first();
    // Wait for at least one product card link to be attached before clicking.
    // On slow CI runners the server-rendered article can briefly be missing
    // right after navigation completes.
    await expect(productLink).toBeAttached();
    await productLink.click();
    await expect(page).toHaveURL(/\/en\/products\/[^/?]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page
      .getByRole("button", { name: /Add to inquiry/ })
      .first()
      .click();

    await page.goto("/en/contact");
    await page.getByLabel("Name").fill("Regression Buyer");
    await page.getByLabel("Email").fill("buyer@example.com");
    await page.getByLabel("Destination Port").fill("Rotterdam");
    await page.getByLabel("Trade Term").fill("CIF");
    await expect(
      page.getByRole("main").getByRole("link", { name: "Privacy Policy" }),
    ).toHaveAttribute("href", "/en/privacy");
    await page.getByLabel(/I have read and agree/).check();
    await page.getByRole("button", { name: "Submit Inquiry" }).click();
    await expect(
      page.getByRole("heading", { name: "Inquiry submitted" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectFixedNavigationDoesNotCoverContent(page);
  });

  test("dialogs close and product CTA does not overlap mobile navigation", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile-chromium",
      "Mobile layout assertion",
    );
    await page.goto("/products");
    await page.locator('article a[href^="/products/"]').first().click();
    await expect(page.locator('nav[aria-label="移动端导航"]')).toHaveCount(0);
    const fixedCta = page.locator("div.fixed.bottom-0").last();
    await expect(fixedCta).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto("/certificates");
    await page
      .getByRole("button", { name: /全屏查看/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("responsive acceptance widths have no overflow", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Run the viewport matrix once",
    );
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 430, height: 900 },
      { width: 768, height: 900 },
      { width: 1024, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/products");
      await expect(page.locator("main")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectFixedNavigationDoesNotCoverContent(page);
    }
  });
});
