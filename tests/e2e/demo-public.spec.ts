import { expect, test, type Page, type Locator, type TestInfo } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectFixedNavigationDoesNotCoverContent(page: Page) {
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
 * Click a product card link and verify the client-side navigation
 * actually commits the target URL.
 *
 * Why this exists (round-5): the previous helper used
 *   Promise.all([page.waitForURL(...), productLink.click()])
 * and relied on the Next.js App Router to commit the URL after the
 * RSC payload resolved. On the product list page many cards were
 * simultaneously prefetching their detail routes. When Playwright
 * clicked one card, the Router cancelled the in-flight prefetches
 * (net::ERR_ABORTED). In rare cases the click-triggered RSC request
 * itself was also cancelled, so the URL never committed and
 * waitForURL timed out at 30s (CI run 30200357750).
 *
 * The new helper uses web-first polling on `page.url()` pathname
 * instead of `waitForURL`, and additionally asserts the detail
 * page's unique H1 (`data-testid="product-detail-title"`) is
 * rendered. This avoids false positives from the product list
 * page's own H1 ("Products") and proves the detail route actually
 * mounted, not just that the URL changed.
 *
 * The click is a real user click — no `force: true`, no
 * `dispatchEvent`, no `page.goto(href)`. The product card Link has
 * `prefetch={false}` in production, so there is no prefetch storm
 * to race against.
 */
async function openProductDetailFromCard(
  page: Page,
  link: Locator,
  expectedPathPattern: RegExp,
) {
  await expect(link).toBeVisible();

  const href = await link.getAttribute("href");
  expect(href, "product card link must have an href").toBeTruthy();
  expect(
    href!,
    `product card href "${href}" must match ${expectedPathPattern}`,
  ).toMatch(expectedPathPattern);

  const target = new URL(href!, page.url());
  const targetPath = target.pathname;

  await link.click();

  // Poll the URL pathname. `expect.poll` retries the assertion on a
  // short interval until it passes or the timeout expires. This is
  // the recommended Playwright pattern for state (rather than event)
  // assertions and does not depend on the navigation lifecycle
  // event that waitForURL subscribes to.
  await expect
    .poll(
      () => new URL(page.url()).pathname,
      {
        timeout: 30_000,
        message: `Expected product navigation to commit ${targetPath}, but URL stayed at ${page.url()}`,
      },
    )
    .toBe(targetPath);

  // Detail-route-only assertion: the product list page also has an
  // H1 ("Products" / "产品中心"), so checking only `heading level=1`
  // could pass on the list page. The detail page renders a unique
  // `data-testid="product-detail-title"` H1 with the product name,
  // which cannot exist on the list page.
  await expect(
    page.locator('[data-testid="product-detail-title"]'),
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * Collect browser-side diagnostics so test failure messages include
 * actionable context instead of just "locator not found" or a 30s
 * timeout. Captures:
 *   - console.error messages
 *   - pageerror (uncaught exceptions)
 *   - requestfailed (net::ERR_ABORTED, ECONNRESET, etc.)
 *
 * Only safe metadata is recorded (method, pathname, resourceType,
 * status, failure.errorText). Cookies, Authorization headers,
 * Supabase keys, inquiry PII (name/phone/email), and full query
 * tokens are NEVER recorded.
 *
 * Round-5 change: callers MUST wrap the test body in try/finally
 * and call `dumpDiagnostics()` in the finally block. The previous
 * implementation only called dumpDiagnostics at the end of the
 * test, so if a waitForURL/poll assertion threw mid-test, the
 * diagnostics listeners never flushed and the failure had zero
 * browser-side context.
 */
function attachDiagnostics(page: Page, testInfo: TestInfo) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(`[pageerror] ${err.message}`);
  });
  page.on("requestfailed", (req) => {
    // Record only safe metadata. The URL is included because it is
    // the same localhost Demo URL the test already logs via
    // page.url(); no cookies, no Authorization header, no PII.
    const url = req.url();
    const failure = req.failure()?.errorText ?? "unknown";
    // Redact any query string to avoid leaking tokens that might
    // appear in a URL (e.g. Supabase access tokens in edge cases).
    const safeUrl = url.replace(/\?[^#]*/, "?<redacted>");
    requestFailures.push(
      `[requestfailed] ${req.method()} ${safeUrl} (${failure})`,
    );
  });

  return async function dumpDiagnostics() {
    if (
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      requestFailures.length === 0
    ) {
      return;
    }
    const lines: string[] = [];
    if (consoleErrors.length > 0) {
      lines.push(`--- ${consoleErrors.length} console error(s) ---`);
      lines.push(...consoleErrors);
    }
    if (pageErrors.length > 0) {
      lines.push(`--- ${pageErrors.length} page error(s) ---`);
      lines.push(...pageErrors);
    }
    if (requestFailures.length > 0) {
      lines.push(`--- ${requestFailures.length} request failure(s) ---`);
      lines.push(...requestFailures);
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
    try {
      // Use a unique IP per repeat iteration so the inquiry rate
      // limiter does not block the repeat-each stability sweep.
      const ipSuffix = testInfo.repeatEachIndex ?? 0;
      await page.context().setExtraHTTPHeaders({
        "x-edgeone-client-ip":
          testInfo.project.name === "mobile-chromium"
            ? `192.0.2.${10 + ipSuffix}`
            : `192.0.2.${11 + ipSuffix}`,
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

      // Round-5: open the product detail via the unified helper.
      // The helper uses web-first URL polling + a detail-page-only
      // H1 assertion, replacing the previous Promise.all([
      // waitForURL, click]) pattern that depended on the navigation
      // lifecycle event and could miss the commit when the
      // click-triggered RSC request was cancelled by the Router.
      const productLink = page.locator('article a[href^="/products/"]').first();
      await expect(productLink).toBeVisible({ timeout: 30_000 });
      await openProductDetailFromCard(page, productLink, /^\/products\/[^/?]+$/);
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
    } finally {
      await dumpDiagnostics();
    }
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
    try {
      // Use a unique IP per repeat iteration so the inquiry rate
      // limiter (5 submissions / 10 minutes per IP) does not block
      // the repeat-each stability sweep. The IP only needs to be
      // stable within a single test run; across repeats it must
      // differ so the limiter sees a fresh bucket.
      const ipSuffix = testInfo.repeatEachIndex ?? 0;
      await page.context().setExtraHTTPHeaders({
        "x-edgeone-client-ip":
          testInfo.project.name === "mobile-chromium"
            ? `192.0.2.${20 + ipSuffix}`
            : `192.0.2.${21 + ipSuffix}`,
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
      // Round-5: open the product detail via the unified helper.
      // Replaces the previous Promise.all([waitForURL, click])
      // pattern that timed out at 30s on CI run 30200357750 because
      // the click-triggered RSC request was cancelled by the Router
      // after a parallel prefetch storm.
      const productLink = page
        .locator('article a[href^="/en/products/"]')
        .first();
      await expect(productLink).toBeVisible({ timeout: 30_000 });
      await openProductDetailFromCard(
        page,
        productLink,
        /^\/en\/products\/[^/?]+$/,
      );
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
    } finally {
      await dumpDiagnostics();
    }
  });

  test("dialogs close and product CTA does not overlap mobile navigation", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile-chromium",
      "Mobile layout assertion",
    );
    const dumpDiagnostics = attachDiagnostics(page, testInfo);
    try {
      await page.goto("/products");
      // Round-5: open the product detail via the unified helper.
      const mobileProductLink = page.locator('article a[href^="/products/"]').first();
      await expect(mobileProductLink).toBeVisible({ timeout: 30_000 });
      await openProductDetailFromCard(page, mobileProductLink, /^\/products\/[^/?]+$/);
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
    } finally {
      await dumpDiagnostics();
    }
  });

  test("responsive acceptance widths have no overflow", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Run the viewport matrix once",
    );
    const dumpDiagnostics = attachDiagnostics(page, testInfo);
    try {
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
    } finally {
      await dumpDiagnostics();
    }
  });
});
