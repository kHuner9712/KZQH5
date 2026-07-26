import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  existsSync,
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

interface RunResult { status: number; stdout: string; stderr: string; }

function runScript(scriptPath: string, args: string[] = []): RunResult {
  // Build a clean env: start from process.env (for PATH etc.) but
  // explicitly unset CI-specific vars so they don't leak from the
  // shell. These self-consistency tests exercise the default mode,
  // not the CI trust-anchor mode (covered by
  // migration-immutability-trust-anchor.test.ts).
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cleanEnv.CI;
  delete cleanEnv.MIGRATION_FREEZE_REF;
  delete cleanEnv.CI_DISALLOW_INITIALIZE;
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: cleanEnv,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

interface Fixture { root: string; migrationsDir: string; manifestPath: string; scriptPath: string; }

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "kzq-immut-"));
  const migrationsDir = join(root, "supabase", "migrations");
  const docsDir = join(root, "docs");
  const scriptsDir = join(root, "scripts");
  mkdirSync(migrationsDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = join(scriptsDir, "check-migration-immutability.mjs");
  copyFileSync(SCRIPT, scriptPath);
  return { root, migrationsDir, manifestPath: join(docsDir, "MIGRATION_SHA256_MANIFEST.txt"), scriptPath };
}

function sha256OfString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function writeMigration(dir: string, filename: string, content: string): string {
  const path = join(dir, filename);
  writeFileSync(path, content, "utf8");
  return path;
}

function writeManifest(fixture: Fixture, lines: string[]): void {
  writeFileSync(fixture.manifestPath, lines.join("\n") + "\n", "utf8");
}

const MIGRATION_A_NAME = "20260101000000_init.sql";
const MIGRATION_A_CONTENT = "-- init migration\ncreate table if not exists test_a();\n";
const MIGRATION_A_HASH = sha256OfString(MIGRATION_A_CONTENT);

describe("Migration immutability script", () => {
  let fixture: Fixture;
  beforeAll(() => { fixture = makeFixture(); });
  afterAll(() => { rmSync(fixture.root, { recursive: true, force: true }); });

  it("S1: frozen file unchanged -> pass", () => {
    writeMigration(fixture.migrationsDir, MIGRATION_A_NAME, MIGRATION_A_CONTENT);
    writeManifest(fixture, ["# test", MIGRATION_A_HASH + "  " + MIGRATION_A_NAME]);
    const r = runScript(fixture.scriptPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PASS/);
  });

  it("S2: frozen file modified -> fail", () => {
    writeMigration(fixture.migrationsDir, MIGRATION_A_NAME, MIGRATION_A_CONTENT + "\n-- tampered\n");
    const r = runScript(fixture.scriptPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/has been modified/);
    writeMigration(fixture.migrationsDir, MIGRATION_A_NAME, MIGRATION_A_CONTENT);
  });

  it("S3: frozen file deleted -> fail", () => {
    rmSync(join(fixture.migrationsDir, MIGRATION_A_NAME), { force: true });
    const r = runScript(fixture.scriptPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no longer exists/);
    writeMigration(fixture.migrationsDir, MIGRATION_A_NAME, MIGRATION_A_CONTENT);
  });

  it("S4: new migration not registered -> fail", () => {
    writeMigration(fixture.migrationsDir, "20260201000000_new.sql", "-- new\n");
    const r = runScript(fixture.scriptPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not in the manifest/);
    rmSync(join(fixture.migrationsDir, "20260201000000_new.sql"), { force: true });
  });

  it("S5: --append-new adds new file", () => {
    const newName = "20260201000000_new.sql";
    const newContent = "-- new migration\n";
    writeMigration(fixture.migrationsDir, newName, newContent);
    const r = runScript(fixture.scriptPath, ["--append-new"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/appended 1 new migration/);
    const manifest = readFileSync(fixture.manifestPath, "utf8");
    expect(manifest).toContain(newName);
    expect(manifest).toContain(sha256OfString(newContent));
    const v = runScript(fixture.scriptPath);
    expect(v.status).toBe(0);
  });

  it("S6: --append-new refuses on history tampering", () => {
    writeMigration(fixture.migrationsDir, MIGRATION_A_NAME, MIGRATION_A_CONTENT + "\n-- tampered\n");
    const r = runScript(fixture.scriptPath, ["--append-new"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/has been modified/);
    expect(r.stderr).toMatch(/--append-new refused/);
    writeMigration(fixture.migrationsDir, MIGRATION_A_NAME, MIGRATION_A_CONTENT);
  });

  it("S7: --initialize refuses if manifest exists", () => {
    const r = runScript(fixture.scriptPath, ["--initialize"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/manifest already exists/);
  });

  it("S8: non-monotonic timestamp -> fail", () => {
    writeMigration(fixture.migrationsDir, "20260301000000_c.sql", "-- c\n");
    writeManifest(fixture, ["# bad", sha256OfString("-- c\n") + "  20260301000000_c.sql", MIGRATION_A_HASH + "  " + MIGRATION_A_NAME]);
    const r = runScript(fixture.scriptPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not strictly later/);
    rmSync(join(fixture.migrationsDir, "20260301000000_c.sql"), { force: true });
  });

  it("S9: non-.sql files are ignored", () => {
    rmSync(join(fixture.migrationsDir, "20260201000000_new.sql"), { force: true });
    writeMigration(fixture.migrationsDir, MIGRATION_A_NAME, MIGRATION_A_CONTENT);
    writeManifest(fixture, ["# clean", MIGRATION_A_HASH + "  " + MIGRATION_A_NAME]);
    writeFileSync(join(fixture.migrationsDir, "20260401000000_not.pdf"), "%PDF fake");
    const r = runScript(fixture.scriptPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PASS/);
    expect(r.stdout + r.stderr).not.toMatch(/not\.pdf/);
  });

  it("S10: --initialize bootstraps a fresh manifest", () => {
    const fresh = makeFixture();
    try {
      writeMigration(fresh.migrationsDir, "20260101000000_init.sql", "-- init\n");
      writeMigration(fresh.migrationsDir, "20260102000000_second.sql", "-- second\n");
      const r = runScript(fresh.scriptPath, ["--initialize"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/manifest initialized/);
      expect(existsSync(fresh.manifestPath)).toBe(true);
      const manifest = readFileSync(fresh.manifestPath, "utf8");
      expect(manifest).toContain("20260101000000_init.sql");
      expect(manifest).toContain("20260102000000_second.sql");
      const v = runScript(fresh.scriptPath);
      expect(v.status).toBe(0);
    } finally {
      rmSync(fresh.root, { recursive: true, force: true });
    }
  });

  it("S11: legacy --update mode is removed", () => {
    const r = runScript(fixture.scriptPath, ["--update"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--update mode has been removed/);
  });

  it("S12: duplicate filename in manifest -> fail", () => {
    writeManifest(fixture, ["# dup", MIGRATION_A_HASH + "  " + MIGRATION_A_NAME, MIGRATION_A_HASH + "  " + MIGRATION_A_NAME]);
    const r = runScript(fixture.scriptPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/duplicate filename/);
  });
});
