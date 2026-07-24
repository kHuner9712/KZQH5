import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// Phase 11: CI/CD governance static tests
// ------------------------------------------------------------
// Verifies the GitHub Actions configuration meets commercial
// delivery requirements:
//
//   1. Node version is pinned to 20 in all workflows
//   2. Public E2E (demo) does NOT receive service role / admin creds
//   3. Staging secrets are scoped to the staging environment
//   4. Third-party Actions are documented (SHA-pinning is a manual todo
//      because modifying remote repo settings is out of scope)
//
// NOTE on CODEOWNERS / Branch Protection:
//   CODEOWNERS file alone does NOT enforce review. Only GitHub
//   Ruleset / Branch Protection with "Require code owner review"
//   enforces it. Configuring that requires remote repo settings
//   which this task is forbidden from modifying. It is recorded
//   as a manual todo in the delivery report.
// ============================================================

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..");
const CI_YML = join(ROOT, ".github", "workflows", "ci.yml");
const STAGING_YML = join(ROOT, ".github", "workflows", "staging-validation.yml");

function readWorkflow(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Phase 11: CI governance — Node version", () => {
  it("ci.yml pins Node to version 20", () => {
    const content = readWorkflow(CI_YML);
    expect(content).toMatch(/node-version:\s*20/);
    // Must NOT use Node 22 or higher
    expect(content).not.toMatch(/node-version:\s*22/);
    expect(content).not.toMatch(/node-version:\s*23/);
  });

  it("staging-validation.yml pins Node to version 20", () => {
    const content = readWorkflow(STAGING_YML);
    expect(content).toMatch(/node-version:\s*20/);
  });

  it("package.json engines requires node 20.x", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.engines?.node).toBe("20.x");
  });
});

describe("Phase 11: CI governance — public E2E has no secrets", () => {
  it("ci.yml demo-e2e job does NOT receive service role key", () => {
    const content = readWorkflow(CI_YML);
    // The demo-e2e job runs in demo mode and must NOT have access to
    // SUPABASE_SERVICE_ROLE_KEY or admin credentials.
    // We check that the env block only sets NEXT_PUBLIC_DEMO_MODE.
    const demoE2eSection = content.split("demo-e2e:")[1] || "";
    expect(demoE2eSection).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(demoE2eSection).not.toMatch(/STAGING_ADMIN_EMAIL/);
    expect(demoE2eSection).not.toMatch(/STAGING_ADMIN_PASSWORD/);
    // It MUST set demo mode
    expect(demoE2eSection).toMatch(/NEXT_PUBLIC_DEMO_MODE/);
  });

  it("ci.yml check job does NOT receive service role key", () => {
    const content = readWorkflow(CI_YML);
    const checkSection = content.split("check:")[1]?.split("demo-e2e:")[0] || "";
    expect(checkSection).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(checkSection).not.toMatch(/STAGING_ADMIN_EMAIL/);
  });
});

describe("Phase 11: CI governance — staging secrets are environment-scoped", () => {
  it("staging-validation.yml uses environment: staging", () => {
    const content = readWorkflow(STAGING_YML);
    // Secrets must be scoped to the staging GitHub environment, so they
    // are unavailable unless the environment is configured. If the
    // environment is missing, the workflow fails explicitly.
    expect(content).toMatch(/environment:\s*staging/);
  });

  it("staging-validation.yml is manually dispatched (not automatic)", () => {
    const content = readWorkflow(STAGING_YML);
    // Must NOT trigger on push or pull_request (staging tests are
    // destructive-capable and require explicit human initiation).
    expect(content).toMatch(/workflow_dispatch/);
    expect(content).not.toMatch(/on:\s*\n\s*push:/);
    expect(content).not.toMatch(/on:\s*\n\s*pull_request:/);
  });

  it("staging write tests require explicit allow_writes input", () => {
    const content = readWorkflow(STAGING_YML);
    // The write-capable job must be gated behind inputs.allow_writes
    expect(content).toMatch(/if:\s*\$\{\{.*inputs\.allow_writes/);
    // Default must be false
    expect(content).toMatch(/default:\s*false/);
  });
});

describe("Phase 13: CI governance — first-party Actions are SHA-pinned", () => {
  // Phase 13 hardening: third-party / first-party GitHub Actions must be
  // pinned to a 40-char commit SHA (with a version comment beside each use).
  // This prevents a compromised tag from silently rerouting CI to a
  // malicious action version.
  //
  // We verify the SHA pattern against `uses:` lines specifically so that
  // inline version comments (e.g. `# actions/checkout@v4.2.2`) do not
  // produce false positives. The test fails if a `uses:` line still
  // references the moving tag form (actions/checkout@v4).
  const shaPattern = (action: string) =>
    new RegExp(`uses:\\s+${action}@[0-9a-f]{40}\\b`);

  const movingTagPattern = (action: string) =>
    new RegExp(`uses:\\s+${action}@v\\d+\\b`);

  it("ci.yml pins actions/checkout by SHA", () => {
    const content = readWorkflow(CI_YML);
    expect(shaPattern("actions/checkout").test(content)).toBe(true);
    expect(movingTagPattern("actions/checkout").test(content)).toBe(false);
  });

  it("ci.yml pins actions/setup-node by SHA", () => {
    const content = readWorkflow(CI_YML);
    expect(shaPattern("actions/setup-node").test(content)).toBe(true);
    expect(movingTagPattern("actions/setup-node").test(content)).toBe(false);
  });

  it("ci.yml pins actions/upload-artifact by SHA (when used)", () => {
    const content = readWorkflow(CI_YML);
    if (/uses:\s+actions\/upload-artifact/.test(content)) {
      expect(shaPattern("actions/upload-artifact").test(content)).toBe(true);
      expect(movingTagPattern("actions/upload-artifact").test(content)).toBe(false);
    }
  });

  it("staging-validation.yml pins actions/checkout and actions/setup-node by SHA", () => {
    const content = readWorkflow(STAGING_YML);
    expect(shaPattern("actions/checkout").test(content)).toBe(true);
    expect(movingTagPattern("actions/checkout").test(content)).toBe(false);
    expect(shaPattern("actions/setup-node").test(content)).toBe(true);
    expect(movingTagPattern("actions/setup-node").test(content)).toBe(false);
  });
});

describe("Phase 11: CI governance — CODEOWNERS exists but is not enforced by file alone", () => {
  it("CODEOWNERS file exists", () => {
    expect(existsSync(join(ROOT, ".github", "CODEOWNERS"))).toBe(true);
  });

  it("CODEOWNERS accurately documents that enforcement requires Branch Protection", () => {
    // The CODEOWNERS file alone does NOT enforce review.
    // Only GitHub Ruleset / Branch Protection with
    // "Require code owner review" enforces it.
    // The file comment must accurately state this so readers don't
    // mistakenly believe the file alone is sufficient.
    const content = readFileSync(join(ROOT, ".github", "CODEOWNERS"), "utf8");
    expect(content.length).toBeGreaterThan(0);
    // Must mention that Branch Protection / Ruleset is required
    expect(content).toMatch(/Branch Protection|Ruleset/i);
    // Must state that the file alone does NOT enforce
    expect(content).toMatch(/does NOT enforce|not.*enforc/i);
  });
});
