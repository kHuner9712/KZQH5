import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ============================================================
// KZQ-P2-011: deprecated Vercel integration & docs cleanup
// ------------------------------------------------------------
// EdgeOne is the official platform; Vercel is deprecated. This spec locks
// the governance contract:
//   - NO CI workflow references Vercel (no vercel-action, no Vercel env);
//   - the vercel.app domain BLOCK in release-readiness is a SECURITY guard
//     and must be KEPT (preventing deployment to a deprecated domain);
//   - the manual GitHub-integration cleanup checklist is KEPT (the GitHub
//     Vercel App cannot be removed from code);
//   - audit-valuable history (ADR-001) is KEPT;
//   - remaining prose only mentions Vercel as deprecated/history, never as
//     an active platform.
// ============================================================

const root = process.cwd();

describe("KZQ-P2-011: no Vercel in CI workflows", () => {
  it("every .github/workflows file is free of Vercel references", () => {
    const files = readdirSync(`${root}/.github/workflows`).filter((f) =>
      f.endsWith(".yml"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(
        `${root}/.github/workflows/${file}`,
        "utf-8",
      );
      expect(content.toLowerCase()).not.toContain("vercel");
    }
  });
});

describe("KZQ-P2-011: security guards and manual guidance are KEPT", () => {
  it("release-readiness still BLOCKs the deprecated vercel.app domain", () => {
    const readiness = readFileSync(
      `${root}/scripts/check-release-readiness.mjs`,
      "utf-8",
    );
    expect(readiness).toContain('hostname.endsWith("vercel.app")');
    expect(readiness).toMatch(/vercel\.app domain — .*must use EdgeOne domain/);
  });

  it("the manual Vercel GitHub-integration cleanup checklist is kept", () => {
    const checklist = readFileSync(
      `${root}/docs/LAUNCH_CHECKLIST.md`,
      "utf-8",
    );
    expect(checklist).toContain("## 9. Vercel 遗留清理（人工操作）");
    expect(checklist).toContain("github.com/settings/installations");
    expect(checklist).toContain("VERCEL_TOKEN");
  });

  it("the historical China-deployment ADR is kept for audit value", () => {
    const adr = readFileSync(
      `${root}/docs/ADR-001-CHINA-DEPLOYMENT.md`,
      "utf-8",
    );
    expect(adr.length).toBeGreaterThan(0);
  });
});

describe("KZQ-P2-011: prose only mentions Vercel as deprecated/history", () => {
  it("README, DEPLOYMENT and .env.example never present Vercel as an active platform", () => {
    const readme = readFileSync(`${root}/README.md`, "utf-8");
    const deployment = readFileSync(`${root}/DEPLOYMENT.md`, "utf-8");
    const envExample = readFileSync(`${root}/.env.example`, "utf-8");

    // Deprecation statements are fine; active-platform phrasing is not.
    for (const [label, content] of [
      ["README.md", readme],
      ["DEPLOYMENT.md", deployment],
      [".env.example", envExample],
    ] as const) {
      const lower = content.toLowerCase();
      // No "deploy to Vercel", "Vercel production", "vercel preview" phrasing.
      expect(
        lower,
        `${label} must not describe deploying to Vercel`,
      ).not.toMatch(/deploy(?:ed|ing)? to vercel|vercel production|vercel preview/i);
    }
    // And the deprecation statement itself is present.
    expect(readme).toMatch(/Vercel.*已废弃|deprecated/i);
  });

  it("middleware-session.ts no longer pairs Vercel with EdgeOne", () => {
    const middleware = readFileSync(
      `${root}/lib/supabase/middleware-session.ts`,
      "utf-8",
    );
    expect(middleware).not.toMatch(/Vercel\/EdgeOne|Vercel.*EdgeOne/i);
  });
});
