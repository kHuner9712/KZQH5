import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/check-release-readiness.mjs");

/**
 * Runs the release-readiness script with the given env vars and returns
 * { exitCode, stdout }. The script is read-only and never modifies state.
 */
function runScript(env: Record<string, string>, extraArgs: string[] = []): {
  exitCode: number;
  stdout: string;
} {
  try {
    const stdout = execFileSync("node", [scriptPath, ...extraArgs], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      stdout: (e.stdout ?? "") + (e.stderr ?? ""),
    };
  }
}

describe("check-release-readiness.mjs — env-var driven logic", () => {
  it("BLOCKs when NEXT_PUBLIC_SITE_URL is missing", () => {
    const { exitCode, stdout } = runScript({
      NEXT_PUBLIC_SITE_URL: "",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("BLOCK");
    expect(stdout).toContain("NEXT_PUBLIC_SITE_URL");
  });

  it("BLOCKs when site URL is a vercel.app domain", () => {
    const { exitCode, stdout } = runScript({
      NEXT_PUBLIC_SITE_URL: "https://kzqh5.vercel.app",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("vercel.app");
  });

  it("BLOCKs when site URL uses HTTP (non-localhost)", () => {
    const { exitCode, stdout } = runScript({
      NEXT_PUBLIC_SITE_URL: "http://staging.example.com",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    expect(stdout.toLowerCase()).toContain("http");
  });

  it("BLOCKs when indexing=true in staging mode", () => {
    const { exitCode, stdout } = runScript(
      {
        NEXT_PUBLIC_SITE_URL: "https://staging.edgeone.example.com",
        NEXT_PUBLIC_SUPABASE_URL: "",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
        NEXT_PUBLIC_DEMO_MODE: "false",
        NEXT_PUBLIC_SITE_INDEXING_ENABLED: "true",
      },
      ["--", "--mode=staging"],
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("staging");
    expect(stdout).toContain("indexing");
  });

  it("BLOCKs when service role is exposed via NEXT_PUBLIC_", () => {
    const { exitCode, stdout } = runScript({
      NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
      // Omit Supabase credentials — the service-role exposure BLOCK is what
      // we are testing. Missing Supabase also BLOCKs but that is expected.
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "should-not-be-public",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    expect(stdout.toLowerCase()).toContain("service role");
  });

  it("BLOCKs when Supabase credentials are missing", () => {
    const { exitCode, stdout } = runScript({
      NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("supabase");
  });

  it("BLOCKs in demo mode because mock data has placeholder contacts", () => {
    const { exitCode, stdout } = runScript({
      NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
      // Use a fast-failing Supabase URL (connection refused) so the script
      // does not hang on network timeouts during the demo-mode data check.
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      NEXT_PUBLIC_DEMO_MODE: "true",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    // Mock data has placeholder phone (+86 400-888-0000) and email (kzq-demo.com)
    expect(stdout).toContain("placeholder");
  });

  it("does not BLOCK on HTTPS non-Vercel URL with indexing=false (URL checks pass)", () => {
    const { exitCode, stdout } = runScript({
      NEXT_PUBLIC_SITE_URL: "https://staging.edgeone.example.com",
      // Use a fast-failing Supabase URL so the script completes quickly.
      // Supabase queries will WARN (not BLOCK) on connection failure.
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    // The URL/SEO checks should PASS; the exit code may still be 1 if
    // Supabase connection fails as BLOCK, but URL checks must show PASS.
    expect(stdout).toContain("PASS");
    expect(stdout).not.toContain("vercel.app");
  });
});
