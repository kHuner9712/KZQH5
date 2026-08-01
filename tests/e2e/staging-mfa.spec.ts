import { expect, test, type Page } from "@playwright/test";
import { generateTotp } from "./helpers/totp";

// ============================================================
// KZQ-P1-022-f: Admin MFA / AAL2 end-to-end flow (staging)
// ------------------------------------------------------------
// Validates against a REAL Supabase project, so it lives in the
// staging suite (demo mock backend cannot emulate Supabase Auth MFA).
// Platform prerequisite (manual): Supabase Auth Dashboard must have
// TOTP MFA enabled — see docs/SECURITY_AUDIT_MFA_AAL2.md §7.
//
// Coverage:
//   1. Enrollment — a password-only (aal1) admin binds a TOTP factor
//      on /admin/security (auth.mfa.enroll + challenge + verify).
//   2. Challenge + step-up — password login of an MFA-enabled account
//      routes to /admin/mfa/challenge; while the session is still aal1
//      a sensitive read (inquiry export) is rejected with the fixed
//      401 code ADMIN_WRITE_MFA_REQUIRED; after the TOTP verify the
//      aal2 session is allowed through the same endpoint.
//
// Credentials:
//   - STAGING_ADMIN_EMAIL / STAGING_ADMIN_PASSWORD: the staging admin.
//   - STAGING_MFA_SECRET (optional): base32 TOTP secret when the account
//     ALREADY has a verified factor (a secret is shown exactly once, at
//     enrollment). When unset and the account already has a factor, the
//     challenge test skips with a clear message instead of guessing.
//
// The whole group is SERIAL and credential-gated: without the staging
// variables every test skips (same pattern as staging-admin.spec.ts).
// ============================================================

test.use({ trace: "off", screenshot: "off", video: "off" });

const mfaConfigured = Boolean(
  process.env.STAGING_ADMIN_EMAIL &&
    process.env.STAGING_ADMIN_PASSWORD &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const ADMIN_EMAIL = process.env.STAGING_ADMIN_EMAIL!;
const ADMIN_PASSWORD = process.env.STAGING_ADMIN_PASSWORD!;
const PRESET_MFA_SECRET = process.env.STAGING_MFA_SECRET || null;

/** Fixed markers for post-login state detection. */
const DASHBOARD_MARKER = "KZQ 管理后台";

/**
 * Sign in with the password and wait for the post-login destination.
 * Returns "challenge" when the MFA challenge page appeared, "dashboard"
 * when the admin shell appeared (no factor / already aal2).
 *
 * Handles the known Supabase Auth + Next.js SSR cookie race: if neither
 * marker shows in time, retry a direct navigation to /admin once.
 */
async function loginWaitDestination(page: Page): Promise<"challenge" | "dashboard"> {
  await page.goto("/admin/login");
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();

  const dashboard = page.getByText(DASHBOARD_MARKER);
  const challengeInput = page.getByTestId("mfa-challenge-code-input");

  const outcome = await Promise.race([
    dashboard
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => "dashboard" as const),
    challengeInput
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => "challenge" as const),
  ]).catch(() => null);

  if (outcome) return outcome;

  // Cookie race recovery (see staging-admin.spec.ts): retry /admin once.
  await page.goto("/admin", { waitUntil: "domcontentloaded" });
  const pathname = new URL(page.url()).pathname;
  if (pathname.startsWith("/admin/mfa/challenge")) return "challenge";
  if (pathname.startsWith("/admin") && !pathname.startsWith("/admin/login")) {
    return "dashboard";
  }
  // Still on the login page — surface the failure with the marker assertion.
  await expect(page.getByText(DASHBOARD_MARKER)).toBeVisible({ timeout: 20000 });
  return "dashboard";
}

/** Complete the MFA challenge on the current page and expect the dashboard. */
async function completeChallenge(page: Page, secret: string) {
  const code = generateTotp(secret);
  await page.getByTestId("mfa-challenge-code-input").fill(code);
  await page.getByTestId("mfa-challenge-verify-button").click();
  await expect(page.getByText(DASHBOARD_MARKER)).toBeVisible({ timeout: 20000 });
  await expect(page).toHaveURL(/\/admin(?:\?.*)?$/);
}

/**
 * Sensitive read probe used for the step-up assertion. Returns the HTTP
 * status and the parsed JSON body (null when the body is not JSON, e.g.
 * a successful CSV download).
 */
async function probeSensitiveRead(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/admin/inquiries/export", {
      headers: {
        Origin: window.location.origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.json().catch(() => null),
    };
  });
}

test.describe.serial("KZQ-P1-022-f: admin MFA / AAL2 flow (staging)", () => {
  test.skip(!mfaConfigured, "MFA staging credentials are required");

  /** TOTP secret captured during enrollment (or provided via env). */
  let capturedSecret: string | null = null;

  test("binds a TOTP factor on /admin/security (enrollment)", async ({ page }) => {
    const destination = await loginWaitDestination(page);

    if (destination === "challenge") {
      // The account already has a verified factor — a secret was shown
      // exactly once at enrollment, so it can only come from the env.
      test.skip(
        !PRESET_MFA_SECRET,
        "Account already has MFA; set STAGING_MFA_SECRET to run the challenge flow",
      );
      capturedSecret = PRESET_MFA_SECRET!;
      await completeChallenge(page, PRESET_MFA_SECRET!);
      return;
    }

    await expect(page).toHaveURL(/\/admin(?:\?.*)?$/);
    await page.goto("/admin/security");

    const enrolled = await page
      .getByTestId("mfa-status")
      .filter({ hasText: "已启用" })
      .isVisible()
      .catch(() => false);

    if (enrolled) {
      // Pre-bound factor (e.g. a previous run) — need the env secret.
      test.skip(
        !PRESET_MFA_SECRET,
        "Account already has MFA; set STAGING_MFA_SECRET to run the challenge flow",
      );
      capturedSecret = PRESET_MFA_SECRET!;
      return;
    }

    // Bind a fresh TOTP factor and keep its secret for the next test.
    await page.getByTestId("mfa-enroll-button").click();
    await page.getByTestId("mfa-secret").waitFor({ state: "visible" });
    const secret = (await page.getByTestId("mfa-secret").textContent())?.trim();
    expect(secret).toBeTruthy();
    capturedSecret = secret!;

    await page.getByTestId("mfa-code-input").fill(generateTotp(secret!));
    await page.getByTestId("mfa-confirm-button").click();
    await expect(page.getByTestId("mfa-status")).toContainText("已启用", {
      timeout: 15000,
    });
  });

  test("challenge gates aal1 and step-up rejects the sensitive read until aal2", async ({
    page,
  }) => {
    const secret = capturedSecret ?? PRESET_MFA_SECRET;
    test.skip(
      !secret,
      "No TOTP secret available — run the enrollment test first or set STAGING_MFA_SECRET",
    );
    // test.skip() already aborts this test when secret is null; the guard
    // below only narrows the type for TypeScript.
    if (!secret) return;

    // Password login of an MFA-enabled account must land on the challenge.
    const destination = await loginWaitDestination(page);
    expect(destination).toBe("challenge");
    await expect(page).toHaveURL(/\/admin\/mfa\/challenge/);

    // Still aal1 → sensitive read must be rejected with the fixed code.
    const rejected = await probeSensitiveRead(page);
    expect(rejected.status).toBe(401);
    expect(rejected.body?.error).toBe("ADMIN_WRITE_MFA_REQUIRED");

    // Complete the challenge → aal2 session → same read is allowed.
    await completeChallenge(page, secret);
    const allowed = await probeSensitiveRead(page);
    expect(allowed.status).toBe(200);
    expect(allowed.contentType).toContain("text/csv");

    // Log out and confirm the protected area closes again.
    await page.getByRole("button", { name: /退出/ }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});
