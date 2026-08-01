import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// KZQ-P2-012-c: SBOM workflow governance contract
// ------------------------------------------------------------
// Verifies .github/workflows/sbom.yml:
//   - triggers on every main push (plus manual workflow_dispatch);
//   - generates both CycloneDX and SPDX bills of materials via the
//     built-in `npm sbom` command (no third-party tooling);
//   - uploads the documents as a workflow artifact named `sbom`;
//   - runs a rebuild-and-diff verification step proving the SBOM is
//     reproducible from the committed lockfile;
//   - uses least-privilege permissions (contents: read only) and does
//     NOT attach to releases (honest GITHUB_TOKEN-free boundary);
//   - pins every third-party action to a 40-char commit SHA
//     (no moving @vX tags) — consistent with ci.yml governance.
// ============================================================

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..");
const SBOM_YML = join(ROOT, ".github", "workflows", "sbom.yml");

const content = existsSync(SBOM_YML) ? readFileSync(SBOM_YML, "utf8") : "";

describe("KZQ-P2-012-c: SBOM workflow exists and generates a bill of materials", () => {
  it("sbom.yml exists", () => {
    expect(existsSync(SBOM_YML)).toBe(true);
  });

  it("triggers on main push and supports manual workflow_dispatch", () => {
    expect(content).toMatch(/on:\s*\n/);
    expect(content).toMatch(/push:\s*\n/);
    expect(content).toMatch(/branches:\s*\[main\]/);
    expect(content).toMatch(/workflow_dispatch:/);
  });

  it("generates both CycloneDX and SPDX formats via the built-in npm sbom command", () => {
    expect(content).toMatch(/npm sbom/);
    expect(content).toMatch(/--sbom-format=cyclonedx/);
    expect(content).toMatch(/--sbom-format=spdx/);
    // No third-party SBOM tooling dependency (no npx @cyclonedx installs).
    expect(content).not.toMatch(/npx\s+@cyclonedx/);
  });

  it("uploads a workflow artifact named sbom", () => {
    expect(content).toMatch(/actions\/upload-artifact/);
    expect(content).toMatch(/name:\s*sbom/);
    expect(content).toMatch(/sbom\.cdx\.json/);
    expect(content).toMatch(/sbom\.spdx\.json/);
  });

  it("pins the project Node version to 20 (matches CI)", () => {
    expect(content).toMatch(/node-version:\s*20/);
  });
});

describe("KZQ-P2-012-c: SBOM verification and reproducibility", () => {
  it("documents the generation command and artifact name in the header comment", () => {
    // The workflow header must record the exact commands a human
    // can run locally to reproduce the artifact (documentation contract).
    expect(content).toMatch(/npm sbom --sbom-format=cyclonedx --sbom-type=application/);
    expect(content).toMatch(/Artifact name:/);
    expect(content).toMatch(/name: `sbom`/);
  });

  it("runs a rebuild-and-diff verification step", () => {
    // The verification contract: regenerate the CycloneDX document and
    // JSON-diff it against the committed graph, normalizing the per-run
    // serialNumber UUID so only real content changes fail the check.
    expect(content).toMatch(/sbom\.cdx\.verify\.json/);
    expect(content).toMatch(/serialNumber/);
    expect(content).toMatch(/Verify SBOM is reproducible/);
  });
});

describe("KZQ-P2-012-c: SBOM least-privilege permissions", () => {
  it("grants contents: read only with no write scopes", () => {
    const permsMatch = content.match(/^permissions:\n((?:  [^\n]+\n)*)/m);
    const permsBlock = permsMatch?.[1] ?? "";
    expect(permsBlock).toMatch(/contents:\s*read/);
    expect(permsBlock).not.toMatch(/contents:\s*write/);
    expect(permsBlock).not.toMatch(/packages:\s*write/);
    expect(permsBlock).not.toMatch(/security-events:\s*write/);
    expect(permsBlock).not.toMatch(/actions:\s*write/);
  });

  it("does not attach the SBOM to releases (honest GITHUB_TOKEN-free boundary)", () => {
    // There is no GITHUB_TOKEN-free path for release uploads; wiring it
    // up would require `contents: write`. The workflow must NOT consume a
    // token nor claim a release attachment it cannot make. (Mentions in
    // the explanatory header comment are fine — the honesty check targets
    // actual token USE, not the word itself.)
    expect(content).not.toMatch(/\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
    expect(content).not.toMatch(/GITHUB_TOKEN:\s*\$\{\{/);
    expect(content).not.toMatch(/token:\s*\${{/);
    expect(content).not.toMatch(/uses:\s*softprops\/action-gh-release/);
    expect(content).not.toMatch(/gh release upload/);
  });
});

describe("KZQ-P2-012-c: every action use is SHA-pinned", () => {
  const shaPattern = (action: string) =>
    new RegExp(`uses:\\s+${action}@[0-9a-f]{40}\\b`);
  const movingTagPattern = (action: string) =>
    new RegExp(`uses:\\s+${action}@v\\d+\\b`);

  it("pins actions/checkout by SHA", () => {
    expect(shaPattern("actions/checkout").test(content)).toBe(true);
    expect(movingTagPattern("actions/checkout").test(content)).toBe(false);
  });

  it("pins actions/setup-node by SHA", () => {
    expect(shaPattern("actions/setup-node").test(content)).toBe(true);
    expect(movingTagPattern("actions/setup-node").test(content)).toBe(false);
  });

  it("pins actions/upload-artifact by SHA (no moving tags anywhere)", () => {
    expect(shaPattern("actions/upload-artifact").test(content)).toBe(true);
    expect(movingTagPattern("actions/upload-artifact").test(content)).toBe(false);
    // No `uses: ...@v<digit>` moving references at all.
    expect(content).not.toMatch(/uses:\s+[^\s]+@v\d+\b/);
  });
});
