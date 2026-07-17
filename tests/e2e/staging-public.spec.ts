import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { Database } from "@/types/database";
import { isHealthCacheControlSafe } from "@/lib/services/cache-policy";

const writeEnabled = process.env.STAGING_E2E_ALLOW_WRITES === "true";
const writeConfirmed =
  process.env.KZQ_STAGING_CONFIRMATION === "KZQ-STAGING-ONLY";

if (
  writeEnabled &&
  (!writeConfirmed ||
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY)
) {
  throw new Error(
    "Staging write E2E refused: Staging confirmation and server-only Supabase credentials are required",
  );
}

async function expectHtmlLanguage(
  page: Page,
  path: string,
  language: "zh-CN" | "en",
) {
  const expectedOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL!).origin;
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await expect(page.locator("main")).toBeVisible();
  const canonical = page.locator('link[rel="canonical"]');
  await expect(canonical).toHaveAttribute("href", /^https?:\/\//);
  const canonicalHref = await canonical.getAttribute("href");
  expect(canonicalHref).not.toMatch(/eo_(?:token|time)=/i);
  expect(new URL(canonicalHref!).origin).toBe(expectedOrigin);
  await expect(
    page.locator('link[rel="alternate"][hreflang="zh-CN"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('link[rel="alternate"][hreflang="en"]'),
  ).toHaveCount(1);
  const openGraphUrl = page.locator('meta[property="og:url"]');
  await expect(openGraphUrl).toHaveAttribute("content", /^https?:\/\//);
  const openGraphContent = await openGraphUrl.getAttribute("content");
  expect(openGraphContent).not.toMatch(/eo_(?:token|time)=/i);
  expect(new URL(openGraphContent!).origin).toBe(expectedOrigin);
}

test.describe("deployed Staging read-only acceptance", () => {
  test("Chinese and English public routes, metadata, and locale switching", async ({
    page,
  }) => {
    await expectHtmlLanguage(page, "/", "zh-CN");
    await expectHtmlLanguage(page, "/en", "en");
    await expect(page.locator('script[type="application/ld+json"]')).not.toHaveCount(0);

    // Use the semantic, visible language switcher control instead of a fragile
    // `a[href="/"].first()` selector that may match the logo or footer links.
    // On the English page the switcher is labeled "切换到中文" and points to "/".
    const toChineseSwitch = page.getByRole("link", { name: "切换到中文" });
    await expect(toChineseSwitch).toBeVisible();
    await expect(toChineseSwitch).toHaveAttribute("href", "/");

    for (const path of [
      "/products",
      "/certificates",
      "/projects",
      "/contact",
      "/more",
      "/privacy",
      "/en/products",
      "/en/certificates",
      "/en/projects",
      "/en/contact",
      "/en/more",
      "/en/privacy",
    ]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("main")).toBeVisible();
      await expect(page).toHaveTitle(/KZQ/i);
    }
  });

  test("product search, category, detail, and procurement resources render", async ({
    page,
  }) => {
    await page.goto("/products?q=a", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();
    await expect(page).toHaveURL(/\?q=a/);

    const categoryLink = page.locator('a[href*="category="]').first();
    await expect(categoryLink).toBeVisible();
    await categoryLink.click();
    await expect(page).toHaveURL(/category=/);

    const subcategoryLink = page.locator('a[href*="subcategory="]').first();
    await expect(subcategoryLink).toBeVisible();
    await subcategoryLink.click();
    await expect(page).toHaveURL(/subcategory=/);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    const productLink = page.locator('article a[href^="/products/"]').first();
    await expect(productLink).toBeVisible();
    const productHref = await productLink.getAttribute("href");
    expect(productHref).toMatch(/^\/products\/[^/?]+/);
    // Coordinate click with waitForURL to avoid the click→assert race that left
    // the URL at /products. No force click, no waitForTimeout, no goto fallback.
    await Promise.all([
      page.waitForURL((url) => url.pathname === productHref),
      productLink.click(),
    ]);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("main")).toBeVisible();

    await page.goto("/en/products", { waitUntil: "domcontentloaded" });
    const englishProductLink = page
      .locator('article a[href^="/en/products/"]')
      .first();
    await expect(englishProductLink).toBeVisible();
    const englishHref = await englishProductLink.getAttribute("href");
    expect(englishHref).toMatch(/^\/en\/products\/[^/?]+/);
    await Promise.all([
      page.waitForURL((url) => url.pathname === englishHref),
      englishProductLink.click(),
    ]);
    await expect(page).toHaveURL(/\/en\/products\/[^/?]+/);
  });

  test("sitemap, 404, and health endpoint are deployment-safe", async ({
    page,
    request,
  }) => {
    const expectedBaseUrl = new URL(process.env.PLAYWRIGHT_BASE_URL!);
    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.ok()).toBe(true);
    expect(sitemap.headers()["content-type"]).toContain("xml");
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain("<urlset");
    expect(sitemapBody).toContain(`${expectedBaseUrl.origin}/`);
    expect(sitemapBody).not.toMatch(/eo_(?:token|time)=/i);

    if (expectedBaseUrl.protocol === "https:") {
      const insecureUrl = new URL("/", expectedBaseUrl);
      insecureUrl.protocol = "http:";
      const insecure = await request.get(insecureUrl.href, { maxRedirects: 0 });
      expect([301, 302, 307, 308]).toContain(insecure.status());
      const redirectTarget = new URL(
        insecure.headers().location || "",
        insecureUrl,
      );
      expect(redirectTarget.protocol).toBe("https:");
      expect(redirectTarget.host).toBe(expectedBaseUrl.host);
    }

    const robots = await request.get("/robots.txt");
    expect(robots.ok()).toBe(true);
    expect(await robots.text()).toMatch(/User-agent:/i);

    const health = await request.get("/api/health");
    expect(health.ok()).toBe(true);
    // The app sets no-store, but EdgeOne may rewrite to
    // public,max-age=0,must-revalidate. Both are safe non-cacheable strategies.
    expect(
      isHealthCacheControlSafe(health.headers()["cache-control"]),
    ).toBe(true);
    expect(await health.json()).toMatchObject({
      success: true,
      app: "kzq-h5",
      demo: false,
      dataProvider: "supabase",
      runtime: "nodejs",
    });

    const missing = await page.goto(
      `/staging-regression-missing-${crypto.randomUUID()}`,
      { waitUntil: "domcontentloaded" },
    );
    expect(missing?.status()).toBe(404);
    await expect(page.locator("main")).toBeVisible();
  });
});

async function submitInquiry(
  page: Page,
  locale: "zh" | "en",
  marker: string,
  suffix: string,
) {
  const prefix = locale === "en" ? "/en" : "";
  await page.goto(
    `${prefix}/contact?source=staging-e2e&utm_source=regression&utm_medium=automated&utm_campaign=${encodeURIComponent(marker)}`,
  );
  await page.locator('[name="name"]').fill(`${marker} ${suffix}`);
  if (locale === "zh") {
    await page.locator('[name="phone"]').fill("13800000000");
  } else {
    await page.locator('[name="email"]').fill("regression@example.invalid");
  }
  const product = page.locator('[name="interested_product"]');
  if (await product.isEnabled()) await product.fill(marker);
  await page.locator('[name="message"]').fill(marker);
  await page.locator("#privacy-accepted").check();

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/inquiries") &&
      response.request().method() === "POST",
  );
  await page.locator('button[type="submit"]').click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    success?: boolean;
    id?: string;
    submittedProductCount?: number;
  };
  expect(body.success).toBe(true);
  expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.locator("main")).toContainText(/提交成功|submitted/i);
  return body;
}

test.describe("deployed Staging explicitly enabled write acceptance", () => {
  test.skip(!writeEnabled, "Remote writes require explicit opt-in");

  test("writes Chinese, English, and multi-product inquiries then cleans exact IDs", async ({
    page,
  }) => {
    const marker = `[REGRESSION TEST] ${crypto.randomUUID()}`;
    const created: Array<{ id: string; name: string }> = [];
    const service = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    try {
      const zh = await submitInquiry(page, "zh", marker, "zh");
      created.push({ id: zh.id!, name: `${marker} zh` });

      const en = await submitInquiry(page, "en", marker, "en");
      created.push({ id: en.id!, name: `${marker} en` });

      await page.goto("/products");
      const addButtons = page.getByRole("button", {
        name: /加入询盘|Add to inquiry/i,
      });
      expect(await addButtons.count()).toBeGreaterThanOrEqual(2);
      await addButtons.nth(0).click();
      await addButtons.nth(1).click();
      const multi = await submitInquiry(page, "zh", marker, "multi");
      created.push({ id: multi.id!, name: `${marker} multi` });
      expect(multi.submittedProductCount).toBeGreaterThanOrEqual(2);

      for (const row of created) {
        const stored = await service
          .from("inquiries")
          .select("id, name, source, utm_source, inquiry_items(id)")
          .eq("id", row.id)
          .eq("name", row.name)
          .single();
        expect(stored.error).toBeNull();
        expect(stored.data?.source).toBe("staging-e2e");
        expect(stored.data?.utm_source).toBe("regression");
      }
    } finally {
      for (const row of created) {
        await service.from("inquiry_items").delete().eq("inquiry_id", row.id);
        await service
          .from("inquiries")
          .delete()
          .eq("id", row.id)
          .eq("name", row.name)
          .like("message", `${marker}%`);
      }
    }
  });
});
