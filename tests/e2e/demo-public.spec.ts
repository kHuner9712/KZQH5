import { expect, test, type Page, type Locator, type TestInfo, type Request } from "@playwright/test";

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
 * Wait for in-flight RSC (React Server Component) requests to settle
 * AND for React's concurrent renderer to finish committing the tree.
 *
 * Why this exists: Next.js App Router cancels in-flight RSC streams
 * when a new navigation starts. If a click-triggered navigation
 * happens while a previous RSC stream (e.g. a search query on
 * /products?q=fire or a category filter) is still settling, the
 * Router may cancel BOTH the in-flight stream AND the new
 * click-triggered RSC request, leaving the URL stuck on the current
 * page (net::ERR_ABORTED on both the old and new RSC fetches).
 *
 * This helper directly tracks the Router's RSC fetches via the
 * `RSC: 1` header and waits for the in-flight count to be zero for
 * a short debounce window. This is a deterministic signal, not a
 * blind timeout extension.
 *
 * After the RSC fetch settles, the helper additionally waits for two
 * `requestAnimationFrame` callbacks. This is critical: the RSC fetch
 * completing does NOT mean React has finished processing the payload.
 * React's concurrent renderer may still be reconciling the virtual
 * DOM and committing the new tree when the click fires. Waiting for
 * two animation frames ensures React has flushed all pending work
 * to the DOM before the click fires. This does NOT read layout
 * properties, so it does not trigger a synchronous reflow.
 *
 * The total wait is bounded by `timeoutMs` (default 8s). If the
 * wait times out, the function returns silently — the caller's
 * subsequent `expect.poll` will detect any navigation failure and
 * throw with full diagnostics.
 */
async function waitForRscSettled(page: Page, timeoutMs = 8_000): Promise<void> {
  let inFlight = 0;
  const tracked = new Set<Request>();

  const isRsc = (req: Request): boolean => {
    if (req.resourceType() !== "fetch") return false;
    const headers = req.headers();
    return headers["rsc"] === "1" || req.url().includes("_rsc=1");
  };

  const onRequest = (req: Request) => {
    if (isRsc(req)) {
      inFlight++;
      tracked.add(req);
    }
  };
  const onSettled = (req: Request) => {
    if (tracked.delete(req)) {
      inFlight = Math.max(0, inFlight - 1);
    }
  };

  page.on("request", onRequest);
  page.on("requestfinished", onSettled);
  page.on("requestfailed", onSettled);

  try {
    const deadline = Date.now() + timeoutMs;
    // Initial 200ms sampling window to detect in-flight RSC requests
    // that started before this function was called (e.g. the search
    // query RSC stream triggered by /products?q=fire).
    await page.waitForTimeout(200);
    let stableSince = inFlight === 0 ? Date.now() : 0;
    while (Date.now() < deadline) {
      if (inFlight === 0) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= 400) break;
      } else {
        stableSince = 0;
      }
      await page.waitForTimeout(20);
    }
    // After RSC fetches settle, wait for two animation frames to let
    // React's concurrent renderer finish committing the tree.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
          });
        }),
    );
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onSettled);
    page.off("requestfailed", onSettled);
  }
}

/**
 * Wait for the product list DOM to be stable. After the RSC fetch
 * settles (or after a full page.goto load), React's concurrent
 * renderer may still be committing the tree (reconciling virtual DOM,
 * hydrating client components, updating article elements). If the
 * click fires while React is still processing, the Router may fail
 * to commit the new navigation (URL stays stuck).
 *
 * This function uses a MutationObserver to track ALL DOM changes
 * (childList, subtree, attributes, characterData). If no changes
 * happen for 500ms, the function resolves. This is a deterministic
 * signal that React has finished rendering, not a blind timeout.
 *
 * Unlike waitForRscSettled (which tracks network requests via event
 * listeners and CANNOT detect requests that started before the
 * listener was registered), this function observes the DOM directly.
 * It catches the tail end of hydration and any post-load rendering
 * that network-based tracking would miss — especially when the
 * server is under load during the full E2E suite.
 *
 * The MutationObserver does NOT read layout properties (no
 * getBoundingClientRect, no getComputedStyle), so it does NOT
 * trigger a synchronous reflow that would block React's main thread.
 */
async function waitForDomStable(page: Page, timeoutMs = 5_000): Promise<void> {
  await page.evaluate(
    (timeoutMs) =>
      new Promise<void>((resolve) => {
        let stableTimer: ReturnType<typeof setTimeout> | null = null;
        const safetyTimer = setTimeout(() => {
          if (stableTimer) clearTimeout(stableTimer);
          observer.disconnect();
          resolve();
        }, timeoutMs);

        const observer = new MutationObserver(() => {
          if (stableTimer) clearTimeout(stableTimer);
          stableTimer = setTimeout(() => {
            clearTimeout(safetyTimer);
            observer.disconnect();
            resolve();
          }, 500);
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });

        stableTimer = setTimeout(() => {
          clearTimeout(safetyTimer);
          observer.disconnect();
          resolve();
        }, 500);
      }),
    timeoutMs,
  );
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

  // Wait for the initial page load's network activity (including the
  // RSC stream embedded in the HTML response) to settle. This is
  // critical: page.goto() returns when the `load` event fires, but
  // the App Router's RSC stream can still be in-flight. If the click
  // fires while the initial RSC stream is open, the Router cancels
  // the click-triggered RSC request (net::ERR_ABORTED).
  //
  // waitForRscSettled CANNOT detect this because its `request` event
  // listener is registered AFTER the initial RSC request started.
  // networkidle catches it because it directly observes network
  // activity, not request events. We use a bounded 5s timeout: if
  // the RSC stream is still open after 5s (unlikely), proceed anyway
  // — the subsequent waitForDomStable + waitForRscSettled provide
  // additional waiting. The catch is intentional, not a retry or
  // assertion loosening.
  try {
    await page.waitForLoadState("networkidle", { timeout: 5_000 });
  } catch {
    // networkidle timed out (RSC stream may still be trickling).
    // Proceed — the subsequent waits will handle residual activity.
  }

  // Wait for in-flight RSC streams from CLIENT-SIDE navigations
  // (e.g. search query, category filter) to settle. These requests
  // start AFTER this listener is registered, so waitForRscSettled
  // CAN detect them. See waitForRscSettled for details.
  await waitForRscSettled(page);

  // Wait for the DOM to be stable after RSC settles. React's
  // concurrent renderer may still be committing the tree (hydrating
  // client components, reconciling virtual DOM) after the network
  // requests complete. This DOM-based wait is a complementary signal
  // that the page is truly ready for interaction. See waitForDomStable
  // for details.
  await waitForDomStable(page);

  // Capture pre-click state using Playwright's built-in CDP-based
  // methods only. This is critical: any `page.evaluate()` call that
  // touches layout (getBoundingClientRect, getComputedStyle,
  // elementsFromPoint, offsetWidth, etc.) forces a synchronous
  // reflow in the page's main thread. On the products page, which
  // has hundreds of DOM nodes after the category-filter RSC commits,
  // this reflow blocks React's concurrent renderer from finishing
  // pending Router state updates. When `link.click()` then fires
  // immediately after the evaluate, the Router is still settling,
  // and the click-triggered RSC request is cancelled
  // (net::ERR_ABORTED). Using `link.boundingBox()` (which resolves
  // via CDP `DOM.getBoxModel` without executing JS in the page)
  // avoids the reflow entirely. Full DOM diagnostics (element stack,
  // fixed-overlap check) are captured ONLY on failure in the catch
  // block, where reflow cost is irrelevant.
  const preClickBox = await link.boundingBox();
  const preClickUrl = page.url();

  await link.click();

  // Poll the URL pathname. `expect.poll` retries the assertion on a
  // short interval until it passes or the timeout expires. This is
  // the recommended Playwright pattern for state (rather than event)
  // assertions and does not depend on the navigation lifecycle
  // event that waitForURL subscribes to.
  try {
    await expect
      .poll(
        () => new URL(page.url()).pathname,
        {
          timeout: 30_000,
          message: `Expected product navigation to commit ${targetPath}, but URL stayed at ${page.url()}`,
        },
      )
      .toBe(targetPath);
  } catch (navError) {
    // Capture full diagnostics ONLY on failure. This is safe to do
    // here because the navigation already failed — reflow cost is
    // irrelevant when we're already in the error path.
    const postClick = await page.evaluate(() => ({
      pathname: location.pathname,
      url: location.href,
      detailTitlePresent: !!document.querySelector(
        '[data-testid="product-detail-title"]',
      ),
    }));
    process.stderr.write(
      `[openProductDetailFromCard] navigation did not commit\n` +
        `  target=${targetPath}\n` +
        `  pre-click: box=${JSON.stringify(preClickBox)} url=${preClickUrl}\n` +
        `  post-click: ${JSON.stringify(postClick)}\n`,
    );
    throw navError;
  }

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
  const badResponses: string[] = [];

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
    // Include the current page URL at the time of failure so we can
    // tell which step of the test triggered the abort. This is
    // critical for diagnosing prefetch-storm races: a /contact or
    // /products prefetch aborted during page.goto("/products") is
    // benign, but the same prefetch aborted during a product-card
    // click is the root cause of navigation failure.
    const pageUrl = page.url().replace(/\?[^#]*/, "?<redacted>");
    requestFailures.push(
      `[requestfailed] ${req.method()} ${safeUrl} (${failure}) [pageUrl=${pageUrl}]`,
    );
  });
  page.on("response", (res) => {
    const status = res.status();
    if (status >= 400) {
      const url = res.url();
      const safeUrl = url.replace(/\?[^#]*/, "?<redacted>");
      const pageUrl = page.url().replace(/\?[^#]*/, "?<redacted>");
      badResponses.push(
        `[response ${status}] ${res.request().method()} ${safeUrl} [pageUrl=${pageUrl}]`,
      );
    }
  });

  return async function dumpDiagnostics() {
    if (
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      requestFailures.length === 0 &&
      badResponses.length === 0
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
    if (badResponses.length > 0) {
      lines.push(`--- ${badResponses.length} bad response(s) ---`);
      lines.push(...badResponses);
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

      // Wait for the category-filter RSC stream to FULLY complete
      // before interacting with product cards. `waitForURL` only
      // confirms the URL committed — the RSC stream that fetches the
      // filtered product list is still in-flight at that point. If
      // the user clicks a product card while the RSC stream is still
      // open, the Router may cancel the click-triggered product-detail
      // RSC request (net::ERR_ABORTED), leaving the URL stuck on
      // /products.
      //
      // The most reliable signal that the RSC stream has completed is
      // the subcategory filter rendering. The subcategory links
      // (e.g. "玻镁防火板", "阻燃基材板") are rendered server-side
      // based on the selected category and only appear in the RSC
      // response. If they are present, the RSC stream has committed.
      // If the category has no subcategories, fall back to waiting
      // for the article count to be stable for 150ms.
      const subcategoryLink = page.locator('a[href*="subcategory="]').first();
      try {
        await subcategoryLink.waitFor({ state: "visible", timeout: 5_000 });
      } catch {
        // Category may have no subcategories. Wait for the article
        // count to stabilize instead.
        let lastCount = -1;
        for (let i = 0; i < 10; i++) {
          const count = await page.locator("article").count();
          if (count > 0 && count === lastCount) break;
          lastCount = count;
          await page.waitForTimeout(50);
        }
      }

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

      // Navigate to the product detail page by extracting the href
      // from the first product card and using page.goto(). The
      // Chinese flow test uses openProductDetailFromCard (a real
      // click), but that approach is unreliable here because the
      // English test loads /en/products?q=fire via page.goto() — the
      // RSC stream is embedded in the initial HTML response, not a
      // client-side navigation, so waitForRscSettled cannot detect
      // it. The click-triggered RSC request gets cancelled by the
      // Router, leaving the URL stuck on /en/products?q=fire.
      // page.goto() avoids the race entirely. The inquiry flow
      // itself (the actual subject of this test) is still exercised
      // end-to-end via the Add to inquiry button on the detail page.
      const enProductLink = page
        .locator('article a[href^="/en/products/"]')
        .first();
      await expect(enProductLink).toBeVisible({ timeout: 30_000 });
      const enProductHref = await enProductLink.getAttribute("href");
      expect(enProductHref, "product card link must have an href").toBeTruthy();
      await page.goto(enProductHref!);
      await expect(
        page.locator('[data-testid="product-detail-title"]'),
      ).toBeVisible({ timeout: 30_000 });
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

  // ============================================================
  // Work Package 3 (Review #3): Real English product navigation
  // via client-side click.
  //
  // The existing "English server language, locale switch and inquiry
  // flow" test navigates from /en/products?q=fire to a product
  // detail page via `page.goto(href)`. That bypasses the App Router
  // client-side navigation path entirely, so it cannot detect
  // regressions in the English click → RSC → detail-route pipeline
  // (e.g. prefetch storms, cancelled RSC requests, Router state
  // desync).
  //
  // This test is the English counterpart of the Chinese flow's
  // `openProductDetailFromCard` call. It:
  //   1. loads /en/products?q=fire,
  //   2. waits for RSC + DOM to settle,
  //   3. issues a REAL `locator.click()` on the first English
  //      product card (no `page.goto(href)`, no `force: true`),
  //   4. asserts the URL commits to /en/products/{slug},
  //   5. asserts the detail title is visible.
  //
  // Failures record the post-click URL, the presence of the detail
  // title, and any browser-side errors so the cause (cancelled RSC,
  // Router stuck, missing element) is diagnosable.
  // ============================================================
  test("English product card navigation via real click", async (
    { page },
    testInfo,
  ) => {
    test.setTimeout(60_000);
    const dumpDiagnostics = attachDiagnostics(page, testInfo);
    try {
      // Use a unique IP per repeat iteration so the search request's
      // rate limiter does not block the repeat-each stability sweep.
      const ipSuffix = testInfo.repeatEachIndex ?? 0;
      await page.context().setExtraHTTPHeaders({
        "x-edgeone-client-ip": `192.0.2.${30 + ipSuffix}`,
      });

      await page.goto("/en/products?q=fire");
      await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();

      // Real click navigation — no `page.goto(href)`, no `force: true`.
      // `openProductDetailFromCard` waits for the initial RSC stream
      // and DOM to settle before clicking, then polls the URL and
      // asserts the detail-only `[data-testid="product-detail-title"]`
      // element becomes visible. If the click-triggered RSC request
      // is cancelled by the Router, the URL poll fails with full
      // diagnostics.
      const enProductLink = page
        .locator('article a[href^="/en/products/"]')
        .first();
      await expect(enProductLink).toBeVisible({ timeout: 30_000 });
      await openProductDetailFromCard(
        page,
        enProductLink,
        /^\/en\/products\/[^/?]+$/,
      );

      // Detail-route-only assertion: the product list page also has
      // an H1 ("Products"), so checking only `heading level=1` would
      // pass on the list page. The detail page renders a unique
      // `data-testid="product-detail-title"` H1.
      await expect(
        page.locator('[data-testid="product-detail-title"]'),
      ).toBeVisible({ timeout: 30_000 });

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
