import { describe, expect, it, vi } from "vitest";

describe("deployment health route", () => {
  it("returns only safe runtime metadata and disables caching", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
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
      dataProvider: "supabase",
      runtime: "nodejs",
    });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(JSON.stringify(body)).not.toContain("SUPABASE");
    expect(JSON.stringify(body)).not.toContain("service-role");
  });
});
