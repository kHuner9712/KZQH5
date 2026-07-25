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

/**
 * Collect browser-side diagnostics (console errors + page errors) so
 * test failure messages include actionable context instead of just
 * "locator not found". The diagnostics are attached to the test via
 * testInfo.attach on failure, and also logged to stderr.
 *
 * Why: CI failures of demo-public.spec.ts historically timed out at
 * `waitForURL(/\/products\/[^/?]+$/)` with no clue whether the click
 * landed, whether the RSC payload errored, or whether the URL changed
 * to something unexpected. Capturing console + pageerror lets the
 * next failure self-diagnose.
 */
function attachDiagnostics(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(`[pageerror] ${err.message}`);
  });
  return async function dumpDiagnostics() {
    if (consoleErrors.length === 0 && pageErrors.length === 0) return;
    const lines: string[] = [];
    if (consoleErrors.length > 0) {
      lines.push(`--- ${consoleErrors.length} console error(s) ---`);
      lines.push(...consoleErrors);
    }
    if (pageErrors.length > 0) {
      lines.push(`--- ${pageErrors.length} page error(s) ---`);
      lines.push(...pageErrors);
    }
    const body = lines.join("\n");
    // Always log to stderr so it shows up in the CI log next to the
    // failure, even if testInfo.attach is unavailable.
    process.stderr.write(`[diagnostics:${testInfo.title}]\n${body}\n`);
    if (typeof testInfo.attach === "function") {
      await testInfo.attach("diagnostics.txt", {
        body,
        contentType: "text/plain",
      });
    }
  };
}

test.describe("Demo public acceptance", () => {
  test("Chinese product and inquiry flow", async ({
    page,
    request,
  }, testInfo) => {
    // This test exercises a long end-to-end flow: home screenshot, product
    // search, category filter, RSC navigation to a product detail page,
    // add-to-inquiry, inquiry form submission with validation, and a
    // second visit to verify list clearing. Under the full suite the
    // shared `npm run start` server is warmer and RSC fetches compete
    // with other requests, so the default 30s test timeout is too tight.
    // 60s keeps the test deterministic without retrying or loosening
    // assertions.
    test.setTimeout(60_000);
    const dumpDiagnostics = attachDiagnostics(page, testInfo);
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

    // Click the category filter and wait for the URL to update. Using
    // Promise.all([waitForURL, click]) avoids the race where the
    // navigation commits before a sequential waitForURL is set up,
    // which on fast runners causes waitForURL to hang until timeout.
    // We previously used `await page.waitForLoadState("networkidle")`
    // here, but networkidle is flaky on RSC streaming pages (the
    // stream stays open just under the 500ms idle threshold, then
    // re-opens) and adds 5-15s of wall time per call.
    const category = page.locator('a[href*="category="]').first();
    await expect(category).toBeVisible();
    await Promise.all([
      page.waitForURL(/category=/, { timeout: 30_000 }),
      category.click(),
    ]);

    // Wait for at least one product card article link to be visible
    // before clicking. This is a content-based wait that is both
    // faster and more reliable than networkidle.
    const productLink = page.locator('article a[href^="/products/"]').first();
    await expect(productLink).toBeVisible({ timeout: 30_000 });
    // Next.js 15 App Router client-side navigation fetches the RSC payload
    // before committing the URL change. Use Promise.all so the wait is
    // armed BEFORE the click fires — otherwise on a fast localhost render
    // the URL can change before waitForURL is registered, causing a
    // 30s timeout.
    await Promise.all([
      page.waitForURL(/\/products\/[^/?]+$/, { timeout: 30_000 }),
      productLink.click(),
    ]);
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
    await dumpDiagnostics();
  });

  test("English server language, locale switch and inquiry flow", async ({
    page,
    request,
  }, testInfo) => {
    // Same rationale as the Chinese flow: the full suite shares one
    // `npm run start` server, and RSC navigation + inquiry submission
    // need headroom beyond the default 30s test timeout.
    test.setTimeout(60_000);
    const dumpDiagnostics = attachDiagnostics(page, testInfo);
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
    // Content-based wait for the first product card link. Replaces the
    // previous `await page.waitForLoadState("networkidle")` which was
    // both slow and flaky under RSC streaming (see Chinese flow comment).
    const productLink = page
      .locator('article a[href^="/en/products/"]')
      .first();
    await expect(productLink).toBeVisible({ timeout: 30_000 });
    // Promise.all to arm the URL wait before the click fires.
    await Promise.all([
      page.waitForURL(/\/en\/products\/[^/?]+$/, { timeout: 30_000 }),
      productLink.click(),
    ]);
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
    await dumpDiagnostics();
  });

  test("dialogs close and product CTA does not overlap mobile navigation", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile-chromium",
      "Mobile layout assertion",
    );
    const dumpDiagnostics = attachDiagnostics(page, testInfo);
    await page.goto("/products");
    // Content-based wait instead of networkidle.
    const mobileProductLink = page.locator('article a[href^="/products/"]').first();
    await expect(mobileProductLink).toBeVisible({ timeout: 30_000 });
    await Promise.all([
      page.waitForURL(/\/products\/[^/?]+$/, { timeout: 30_000 }),
      mobileProductLink.click(),
    ]);
    // MobileNavController hides BottomNav on /products/[slug] via
    // usePathname(). The client-side effect runs after hydration/streaming
    // settles — wait for it rather than asserting immediately.
    await expect(page.locator('nav[aria-label="移动端导航"]')).toHaveCount(0);
    const fixedCta = page.locator("div.fixed.bottom-0").last();
    await expect(fixedCta).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto("/certificates");
    await expect(
      page.getByRole("button", { name: /全屏查看/ }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole("button", { name: /全屏查看/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await dumpDiagnostics();
  });

  test("responsive acceptance widths have no overflow", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Run the viewport matrix once",
    );
    const dumpDiagnostics = attachDiagnostics(page, testInfo);
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
    await dumpDiagnostics();
  });
});
