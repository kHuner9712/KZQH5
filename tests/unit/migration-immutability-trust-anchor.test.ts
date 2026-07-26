import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-migration-immutability.mjs");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface GitFixture {
  root: string;
  migrationsDir: string;
  manifestPath: string;
  scriptPath: string;
}

function sha256OfString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function git(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runScript(root: string, env: Partial<NodeJS.ProcessEnv>, args: string[] = []): RunResult {
  const scriptPath = join(root, "scripts", "check-migration-immutability.mjs");
  // Build a clean env: start from process.env (for PATH etc.) but
  // explicitly unset CI-specific vars so they don't leak from the test
  // runner. Tests that need CI mode pass CI/MIGRATION_FREEZE_REF in `env`.
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cleanEnv.CI;
  delete cleanEnv.MIGRATION_FREEZE_REF;
  delete cleanEnv.CI_DISALLOW_INITIALIZE;
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...cleanEnv, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeMigration(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, "utf8");
}

function writeManifest(fixture: GitFixture, lines: string[]): void {
  writeFileSync(fixture.manifestPath, lines.join("\n") + "\n", "utf8");
}

/**
 * Create a real git repo with one baseline commit containing the manifest
 * and one migration. Returns the fixture plus the baseline commit SHA.
 */
function makeGitFixture(): GitFixture & { baselineSha: string } {
  const root = mkdtempSync(join(tmpdir(), "kzq-immut-git-"));
  const migrationsDir = join(root, "supabase", "migrations");
  const docsDir = join(root, "docs");
  const scriptsDir = join(root, "scripts");
  mkdirSync(migrationsDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(SCRIPT, join(scriptsDir, "check-migration-immutability.mjs"));
  const fixture: GitFixture = {
    root,
    migrationsDir,
    manifestPath: join(docsDir, "MIGRATION_SHA256_MANIFEST.txt"),
    scriptPath: join(scriptsDir, "check-migration-immutability.mjs"),
  };

  // Init git repo with a deterministic identity.
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);

  // Baseline migration + manifest.
  const name = "20260101000000_init.sql";
  const content = "-- init migration\ncreate table if not exists test_a();\n";
  writeMigration(migrationsDir, name, content);
  const hash = sha256OfString(content);
  writeManifest(fixture, ["# test", `${hash}  ${name}`]);

  // First commit = the freeze baseline.
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "baseline"]);
  const baselineSha = git(root, ["rev-parse", "HEAD"]).stdout.trim();

  return { ...fixture, baselineSha };
}

function commitAll(root: string, msg: string): string {
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", msg]);
  return git(root, ["rev-parse", "HEAD"]).stdout.trim();
}

const MIGRATION_A_NAME = "20260101000000_init.sql";
const MIGRATION_A_CONTENT = "-- init migration\ncreate table if not exists test_a();\n";
const MIGRATION_A_HASH = sha256OfString(MIGRATION_A_CONTENT);

/**
 * Real-git integration tests for the --verify-against-ref trust anchor.
 *
 * Each test creates a throwaway git repo with a baseline commit, then
 * performs a tampering scenario and asserts the script exits 1 (or 0
 * for the PASS cases). These tests do NOT mock git — they use real
 * `git init`, `git commit`, and `git show` so that genuine shallow-
 * clone, missing-object, and history-rewrite scenarios are exercised.
 */
describe("Migration immutability — trust-anchor (real git)", () => {
  let fixture: ReturnType<typeof makeGitFixture>;

  beforeAll(() => {
    fixture = makeGitFixture();
  });

  afterAll(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("T1: frozen migration unchanged -> PASS", () => {
    const r = runScript(fixture.root, {}, [`--verify-against-ref=${fixture.baselineSha}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PASS/);
  });

  it("T2: only migration modified -> FAIL", () => {
    writeMigration(fixture.migrationsDir, MIGRATION_A_NAME, MIGRATION_A_CONTENT + "\n-- tampered\n");
    commitAll(fixture.root, "tamper migration only");
    const r = runScript(fixture.root, {}, [`--verify-against-ref=${fixture.baselineSha}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/on disk has been modified/);
  });

  it("T3: migration AND manifest hash both changed -> FAIL (paired tampering)", () => {
    // Reset to baseline first.
    git(fixture.root, ["reset", "--hard", "-q", fixture.baselineSha]);
    const tamperedContent = MIGRATION_A_CONTENT + "\n-- paired tamper\n";
    writeMigration(fixture.migrationsDir, MIGRATION_A_NAME, tamperedContent);
    const newHash = sha256OfString(tamperedContent);
    writeManifest(fixture, ["# paired", `${newHash}  ${MIGRATION_A_NAME}`]);
    commitAll(fixture.root, "paired tamper migration+manifest");
    const r = runScript(fixture.root, {}, [`--verify-against-ref=${fixture.baselineSha}`]);
    expect(r.status).toBe(1);
    // The on-disk hash check fires before the manifest hash check, but
    // both would fail. We only assert that the script rejected it.
    expect(r.stderr).toMatch(/modified|changed/);
  });

  it("T4: frozen migration deleted -> FAIL", () => {
    git(fixture.root, ["reset", "--hard", "-q", fixture.baselineSha]);
    rmSync(join(fixture.migrationsDir, MIGRATION_A_NAME), { force: true });
    commitAll(fixture.root, "delete frozen migration");
    const r = runScript(fixture.root, {}, [`--verify-against-ref=${fixture.baselineSha}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MISSING from disk/);
  });

  it("T5: manifest deleted and --initialize attempted -> FAIL in CI", () => {
    git(fixture.root, ["reset", "--hard", "-q", fixture.baselineSha]);
    rmSync(fixture.manifestPath, { force: true });
    commitAll(fixture.root, "delete manifest");
    // --initialize should be blocked by CI_DISALLOW_INITIALIZE.
    const r = runScript(fixture.root, { CI_DISALLOW_INITIALIZE: "true" }, ["--initialize"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--initialize is not allowed in CI/);
  });

  it("T6: manifest entry order swapped -> FAIL", () => {
    git(fixture.root, ["reset", "--hard", "-q", fixture.baselineSha]);
    // Add a second migration so we have two entries to swap.
    const nameB = "20260201000000_second.sql";
    const contentB = "-- second\n";
    writeMigration(fixture.migrationsDir, nameB, contentB);
    const hashB = sha256OfString(contentB);
    writeManifest(fixture, ["# swap", `${hashB}  ${nameB}`, `${MIGRATION_A_HASH}  ${MIGRATION_A_NAME}`]);
    // This manifest has non-monotonic timestamps (B before A), so
    // parseManifest will reject it. Use a different swap: two entries
    // with the SAME timestamp prefix is impossible. Instead, test a
    // reorder where A and B are swapped but timestamps are still
    // monotonic — that requires B to have an earlier timestamp than A,
    // which can't happen with the naming convention.
    //
    // The order check in modeVerifyAgainstRef catches the case where
    // frozen entries appear in a different position in the HEAD
    // manifest. We simulate that by putting B first (earlier timestamp
    // is impossible), so this test instead verifies that a non-
    // monotonic manifest is rejected by the parser.
    const r = runScript(fixture.root, {}, [`--verify-against-ref=${fixture.baselineSha}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not strictly later|order changed/);
  });

  it("T7: new migration with later timestamp + --append-new -> PASS", () => {
    git(fixture.root, ["reset", "--hard", "-q", fixture.baselineSha]);
    const nameB = "20260201000000_second.sql";
    const contentB = "-- second\n";
    writeMigration(fixture.migrationsDir, nameB, contentB);
    // Append new entry.
    const r1 = runScript(fixture.root, {}, ["--append-new"]);
    expect(r1.status).toBe(0);
    commitAll(fixture.root, "add second migration");
    // Verify against baseline: should still PASS because A is unchanged.
    const r2 = runScript(fixture.root, {}, [`--verify-against-ref=${fixture.baselineSha}`]);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/1 new migration/);
  });

  it("T8: new migration with earlier timestamp than baseline -> FAIL", () => {
    git(fixture.root, ["reset", "--hard", "-q", fixture.baselineSha]);
    // Add a migration with a timestamp EARLIER than the baseline.
    const nameEarly = "20251231000000_backdated.sql";
    const contentEarly = "-- backdated\n";
    writeMigration(fixture.migrationsDir, nameEarly, contentEarly);
    const hashEarly = sha256OfString(contentEarly);
    writeManifest(fixture, ["# backdated", `${MIGRATION_A_HASH}  ${MIGRATION_A_NAME}`, `${hashEarly}  ${nameEarly}`]);
    commitAll(fixture.root, "backdated migration");
    // The parser itself enforces monotonic timestamps, so this fails
    // regardless of --verify-against-ref.
    const r = runScript(fixture.root, {}, [`--verify-against-ref=${fixture.baselineSha}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not strictly later|order/);
  });

  it("T9: CI without MIGRATION_FREEZE_REF -> FAIL (fail-closed)", () => {
    git(fixture.root, ["reset", "--hard", "-q", fixture.baselineSha]);
    const r = runScript(fixture.root, { CI: "true" }, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MIGRATION_FREEZE_REF/);
  });

  it("T10: bad ref (non-existent commit) -> FAIL", () => {
    git(fixture.root, ["reset", "--hard", "-q", fixture.baselineSha]);
    const r = runScript(fixture.root, {}, ["--verify-against-ref=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not exist at ref|could not read manifest|bad object|GIT_MISSING_OBJECT/);
  });

  it("T11: MIGRATION_FREEZE_REF env var works (no CLI flag needed)", () => {
    git(fixture.root, ["reset", "--hard", "-q", fixture.baselineSha]);
    const r = runScript(fixture.root, { MIGRATION_FREEZE_REF: fixture.baselineSha }, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PASS/);
  });
});
