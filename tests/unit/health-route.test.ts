import { afterEach, describe, expect, it, vi } from "vitest";

describe("deployment health route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns only safe runtime metadata and disables caching", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    vi.stubEnv("GIT_COMMIT_SHA", "51a3073");
    const { GET } = await import("@/app/api/health/route");

    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      success: true,
      app: "kzq-h5",
      version: "1.0.0",
      commit: "51a3073",
      demo: false,
      indexingEnabled: false,
      dataProvider: "supabase",
      runtime: "nodejs",
    });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(JSON.stringify(body)).not.toContain("SUPABASE");
    expect(JSON.stringify(body)).not.toContain("service-role");
    // The raw env value must never be exposed — only the boolean.
    expect(JSON.stringify(body)).not.toContain("NEXT_PUBLIC_SITE_INDEXING_ENABLED");
  });

  it("reports indexingEnabled=false by default", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    const { GET } = await import("@/app/api/health/route");
    const response = GET();
    const body = await response.json();
    expect(body.indexingEnabled).toBe(false);
  });

  it("reports indexingEnabled=true only when strictly 'true'", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "true");
    const { GET } = await import("@/app/api/health/route");
    const response = GET();
    const body = await response.json();
    expect(body.indexingEnabled).toBe(true);
  });

  it("does not fuzzy-match 'TRUE' as true", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "TRUE");
    const { GET } = await import("@/app/api/health/route");
    const response = GET();
    const body = await response.json();
    expect(body.indexingEnabled).toBe(false);
  });
});
