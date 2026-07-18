import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { Database } from "@/types/database";

test.use({ trace: "off", screenshot: "off", video: "off" });

const adminConfigured = Boolean(
  process.env.STAGING_ADMIN_EMAIL &&
    process.env.STAGING_ADMIN_PASSWORD &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const writeEnabled =
  process.env.STAGING_E2E_ALLOW_WRITES === "true" &&
  process.env.KZQ_STAGING_CONFIRMATION === "KZQ-STAGING-ONLY";

const service = adminConfigured
  ? createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
  : null;

async function login(page: Page) {
  // The Supabase Auth cookie race recovery below can take up to ~45s
  // (20s first wait + page.goto + 20s retry wait). The default per-test
  // timeout of 30s is too short, so extend this test only (not global).
  test.setTimeout(60000);
  await page.goto("/admin/login");
  await page.locator('input[type="email"]').fill(process.env.STAGING_ADMIN_EMAIL!);
  await page
    .locator('input[type="password"]')
    .fill(process.env.STAGING_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "登录" }).click();
  // Supabase Auth + Next.js SSR race: signInWithPassword sets the session
  // cookie asynchronously, and the LoginForm's router.push("/admin") may
  // reach the server before the cookie is available. ProtectedLayout then
  // redirects back to /admin/login?error=admin_guard&stage=session even
  // though the sign-in itself succeeded. We wait for the AdminShell header;
  // if it does not appear, we capture structured diagnostics to distinguish
  // failure modes. Each prompt is identified by a stable data-testid so we
  // never rely on a generic `.text-red-700` selector:
  //   - login-no-permission  → ?error=no_permission (legacy guard)
  //   - login-admin-guard    → ?error=admin_guard&stage=session|profile|data
  //   - login-auth-error     → client-side signIn failure (LoginForm state)
  // We also classify the `error` and `stage` query params directly, and
  // record whether the auth cookie is set (boolean only, never the value).
  // signInError.message is never logged.
  const adminShell = page.getByText("KZQ 管理后台");
  const sawAdminShell = await adminShell
    .waitFor({ state: "visible", timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (!sawAdminShell) {
    // Diagnostics: capture structured fields only. Never output
    // signInError.message, Cookies, UUIDs, or any PII. Each login-state
    // prompt is identified by a stable data-testid so we can distinguish:
    //   - login-no-permission  → server redirect with ?error=no_permission
    //   - login-admin-guard    → server redirect with ?error=admin_guard
    //   - login-auth-error     → client-side signIn failure (local state)
    const urlAfterWait = new URL(page.url());
    const errorParam = urlAfterWait.searchParams.get("error");
    const stageParam = urlAfterWait.searchParams.get("stage");

    function classifyError(value: string | null):
      | "none"
      | "no_permission"
      | "admin_guard"
      | "other" {
      if (value === null) return "none";
      if (value === "no_permission") return "no_permission";
      if (value === "admin_guard") return "admin_guard";
      return "other";
    }
    function classifyStage(value: string | null):
      | "none"
      | "session"
      | "profile"
      | "data"
      | "other" {
      if (value === null) return "none";
      if (value === "session" || value === "profile" || value === "data")
        return value;
      return "other";
    }
    function classifyCause(value: string | null):
      | "none"
      | "schema"
      | "permission"
      | "authentication"
      | "connection"
      | "timeout"
      | "count-unavailable"
      | "unknown"
      | "other" {
      if (value === null) return "none";
      const allowed = [
        "schema",
        "permission",
        "authentication",
        "connection",
        "timeout",
        "count-unavailable",
        "unknown",
      ] as const;
      if (allowed.includes(value as (typeof allowed)[number]))
        return value as (typeof allowed)[number];
      return "other";
    }

    const errorClass = classifyError(errorParam);
    const stageClass = classifyStage(stageParam);
    const causeClass = classifyCause(urlAfterWait.searchParams.get("cause"));
    const leftLogin = !urlAfterWait.pathname.startsWith("/admin/login");

    const [
      noPermissionVisible,
      adminGuardVisible,
      authErrorVisible,
      hasAuthCookie,
    ] = await Promise.all([
      page
        .locator('[data-testid="login-no-permission"]')
        .isVisible()
        .catch(() => false),
      page
        .locator('[data-testid="login-admin-guard"]')
        .isVisible()
        .catch(() => false),
      page
        .locator('[data-testid="login-auth-error"]')
        .isVisible()
        .catch(() => false),
      page
        .context()
        .cookies()
        .then((cookies) =>
          cookies.some((c) => c.name.includes("auth-token")),
        ),
    ]);

    console.log(
      `[login] first wait failed: pathname=${urlAfterWait.pathname} leftLogin=${leftLogin} error=${errorClass} stage=${stageClass} cause=${causeClass} noPermission=${noPermissionVisible} adminGuard=${adminGuardVisible} authError=${authErrorVisible} authCookie=${hasAuthCookie}`,
    );

    if (urlAfterWait.pathname.startsWith("/admin/login")) {
      // We're still on the login page. Retry direct navigation to /admin.
      // If the auth cookie is set, this should succeed. If not, we'll be
      // redirected back to /admin/login?error=admin_guard&stage=...
      await page.goto("/admin", { waitUntil: "domcontentloaded" });
      const urlAfterRetry = new URL(page.url());
      const retryErrorClass = classifyError(
        urlAfterRetry.searchParams.get("error"),
      );
      const retryStageClass = classifyStage(
        urlAfterRetry.searchParams.get("stage"),
      );
      const retryCauseClass = classifyCause(
        urlAfterRetry.searchParams.get("cause"),
      );
      const retryLeftLogin =
        !urlAfterRetry.pathname.startsWith("/admin/login");
      const [
        retryNoPermission,
        retryAdminGuard,
        retryAuthError,
        retryAuthCookie,
      ] = await Promise.all([
        page
          .locator('[data-testid="login-no-permission"]')
          .isVisible()
          .catch(() => false),
        page
          .locator('[data-testid="login-admin-guard"]')
          .isVisible()
          .catch(() => false),
        page
          .locator('[data-testid="login-auth-error"]')
          .isVisible()
          .catch(() => false),
        page
          .context()
          .cookies()
          .then((cookies) =>
            cookies.some((c) => c.name.includes("auth-token")),
          ),
      ]);
      console.log(
        `[login] after retry goto /admin: pathname=${urlAfterRetry.pathname} leftLogin=${retryLeftLogin} error=${retryErrorClass} stage=${retryStageClass} cause=${retryCauseClass} noPermission=${retryNoPermission} adminGuard=${retryAdminGuard} authError=${retryAuthError} authCookie=${retryAuthCookie}`,
      );
      await expect(adminShell).toBeVisible({ timeout: 20000 });
    } else {
      // Not on /admin/login and AdminShell not visible: unexpected state.
      // Re-run the assertion to surface a clear error.
      await expect(adminShell).toBeVisible();
    }
  }
  await expect(page).toHaveURL(/\/admin(?:\?.*)?$/);
  await expect(page.locator("main")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Dashboard" }),
  ).toBeVisible();
}

async function exactCount(
  table: "products" | "certificates" | "inquiries",
  filter?: ["is_published" | "is_read", boolean],
) {
  let query = service!.from(table).select("id", { count: "exact" }).limit(1);
  if (filter) query = query.eq(filter[0], filter[1]);
  const { count, error } = await query;
  expect(error).toBeNull();
  expect(count).not.toBeNull();
  return count!;
}

test.describe("deployed Staging protected admin acceptance", () => {
  test.skip(!adminConfigured, "Admin credentials and service role are required");

  test("redirects anonymous access and rejects an invalid password", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);

    await page.locator('input[type="email"]').fill(process.env.STAGING_ADMIN_EMAIL!);
    await page
      .locator('input[type="password"]')
      .fill(`invalid-${crypto.randomUUID()}`);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator("form")).toContainText(/登录|password|credentials/i);
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("logs in, verifies dashboard counts and lists, exports CSV, and logs out", async ({
    page,
  }) => {
    const [products, published, certificates, inquiries, unread] =
      await Promise.all([
        exactCount("products"),
        exactCount("products", ["is_published", true]),
        exactCount("certificates"),
        exactCount("inquiries"),
        exactCount("inquiries", ["is_read", false]),
      ]);

    await login(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    for (const [label, value] of [
      ["产品总数", products],
      ["已发布产品", published],
      ["证书数量", certificates],
      [`询盘数量 · 未读 ${unread}`, inquiries],
    ] as const) {
      await expect(page.getByText(label).locator("..")).toContainText(
        String(value),
      );
    }

    for (const path of [
      "/admin/products",
      "/admin/categories",
      "/admin/certificates",
      "/admin/projects",
      "/admin/product-assets",
      "/admin/inquiries",
    ]) {
      const response = await page.goto(path);
      expect(response?.ok()).toBe(true);
      await expect(page.locator("main")).toBeVisible();
    }

    const csv = await page.evaluate(async () => {
      const response = await fetch("/api/admin/inquiries/export");
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
      };
    });
    expect(csv.status).toBe(200);
    expect(csv.contentType).toContain("text/csv");

    await page.getByRole("button", { name: /退出/ }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("updates only a marked inquiry and cleans its exact UUID", async ({
    page,
  }) => {
    test.skip(!writeEnabled, "Admin mutations require explicit Staging write opt-in");
    const marker = `[REGRESSION TEST] ${crypto.randomUUID()}`;
    let inquiryId: string | null = null;

    try {
      const created = await service!
        .from("inquiries")
        .insert({
          name: marker,
          message: marker,
          language: "zh",
          source: "staging-admin-e2e",
          status: "new",
          is_read: false,
        })
        .select("id")
        .single();
      expect(created.error).toBeNull();
      inquiryId = created.data!.id;

      await login(page);
      await page.goto("/admin/inquiries");
      await page.locator("button").filter({ hasText: marker }).first().click();
      const dialog = page.getByRole("dialog", { name: "询盘详情" });
      await dialog.getByRole("button", { name: "标记已读" }).click();
      await dialog.getByRole("button", { name: "已联系" }).click();
      await dialog.locator("textarea").fill(marker);
      await dialog
        .getByRole("button", { name: "保存负责人和备注" })
        .click();

      await expect
        .poll(async () => {
          const stored = await service!
            .from("inquiries")
            .select("is_read, status, notes")
            .eq("id", inquiryId!)
            .eq("name", marker)
            .single();
          return stored.data;
        })
        .toMatchObject({ is_read: true, status: "contacted", notes: marker });
    } finally {
      if (inquiryId) {
        await service!
          .from("inquiry_items")
          .delete()
          .eq("inquiry_id", inquiryId);
        await service!
          .from("inquiries")
          .delete()
          .eq("id", inquiryId)
          .eq("name", marker);
      }
    }
  });
});
