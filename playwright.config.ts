import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT || 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // workers=1 keeps local runs consistent with CI (which defaults to 1
  // worker when CI=true). With multiple workers, concurrent RSC fetches
  // against the single `npm run start` server can exceed the 30s
  // waitForURL timeout, producing flaky failures that disappear when
  // the same test runs in isolation. Pinning workers=1 eliminates the
  // parallel-load flake without retrying, extending timeouts, or
  // loosening assertions.
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npm run start -- --port ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          ...process.env,
          NEXT_PUBLIC_DEMO_MODE: "true",
          // Trust the x-edgeone-client-ip header so E2E tests can
          // simulate distinct client IPs via setExtraHTTPHeaders.
          // Without this, getClientIp() returns null for every
          // request (TRUSTED_PROXY_HEADER unconfigured), and all
          // tests share the single `fallback:global` rate-limit
          // bucket — earlier tests exhaust it and later tests get
          // 429s on /api/analytics/events and /api/products/selection,
          // which breaks RSC navigation in the product-card click test.
          TRUSTED_PROXY_HEADER: "x-edgeone-client-ip",
        },
      },
  projects: [
    {
      name: "mobile-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
