import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("product grade defaults", () => {
  it("keeps fire and environmental grades empty until verified", () => {
    const form = source("components/admin/ProductForm.tsx");
    const page = source("app/admin/(protected)/products/new/page.tsx");

    expect(form).toContain('fire_rating: ""');
    expect(form).toContain('eco_grade: ""');
    expect(form).toContain('fire_rating: initial.fire_rating || ""');
    expect(form).toContain('eco_grade: initial.eco_grade || ""');
    expect(form).toContain("fire_rating: form.fire_rating.trim() || null");
    expect(form).toContain("eco_grade: form.eco_grade.trim() || null");
    expect(form).not.toContain('fire_rating: form.fire_rating || "B级"');
    expect(form).not.toContain('eco_grade: form.eco_grade || "E0级"');
    expect(form).not.toContain('hint="默认 B级"');
    expect(form).not.toContain('hint="默认 E0级"');
    expect(page).toContain("检测等级请根据真实报告填写");
    expect(page).not.toContain("默认防火 B级 / 环保 E0级");
  });
});

describe("storage cleanup scheduler", () => {
  it("runs the canonical cleanup dispatcher hourly with a constrained boundary", () => {
    const workflow = source(".github/workflows/storage-cleanup-dispatch.yml");

    expect(workflow).toContain('cron: "23 * * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("STORAGE_CLEANUP_DISPATCH_SECRET: ${{ secrets.STORAGE_CLEANUP_DISPATCH_SECRET }}");
    expect(workflow).toContain("BASE_URL: ${{ secrets.KZQ_PRODUCTION_BASE_URL }}");
    expect(workflow).toContain("node scripts/dispatch-storage-cleanup.mjs");
    expect(workflow).toContain("/api/internal/storage/cleanup-dispatch");
    expect(workflow).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(workflow).not.toContain("supabase db");
  });
});
