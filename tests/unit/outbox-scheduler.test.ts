import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const VALID_SECRET = "test-dispatch-secret-1234567890";
const MOCK_PORT = 5435;
const DISPATCH_URL = `http://127.0.0.1:${MOCK_PORT}/api/internal/outbox/dispatch`;
const STATUS_URL = `http://127.0.0.1:${MOCK_PORT}/api/internal/outbox/status`;

let mockServer: ChildProcess | null = null;

function startMockServer(mode: string): Promise<ChildProcess> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "node",
      [
        "scripts/mock-outbox-endpoint.mjs",
        `--port=${MOCK_PORT}`,
        `--mode=${mode}`,
      ],
      {
        env: {
          ...process.env,
          OUTBOX_DISPATCH_SECRET: VALID_SECRET,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let started = false;
    child.stdout.on("data", (chunk) => {
      const msg = chunk.toString();
      if (!started && msg.includes("listening")) {
        started = true;
        resolvePromise(child);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!started) {
        rejectPromise(new Error(`Mock server failed to start: ${chunk.toString()}`));
      }
    });
    child.on("error", rejectPromise);
    setTimeout(() => {
      if (!started) rejectPromise(new Error("Mock server start timeout"));
    }, 5000).unref();
  });
}

function stopMockServer(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    child.on("exit", () => resolvePromise());
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      resolvePromise();
    }, 3000).unref();
  });
}

/**
 * Run the dispatch script with given env and return exit code + output.
 */
async function runDispatchScript(
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const scriptPath = resolve(process.cwd(), "scripts/dispatch-inquiry-outbox.mjs");
  const child = spawn("node", [scriptPath, "--batch-size", "10"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode: number = await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("exit", (code) => resolvePromise(code ?? 1));
    setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("SCRIPT_TIMEOUT"));
    }, 15_000).unref();
  });
  return { exitCode, stdout, stderr };
}

/**
 * Run the status monitor script with given env and return exit code + output.
 */
async function runStatusScript(
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const scriptPath = resolve(process.cwd(), "scripts/check-outbox-status.mjs");
  const child = spawn("node", [scriptPath], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode: number = await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("exit", (code) => resolvePromise(code ?? 1));
    setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("SCRIPT_TIMEOUT"));
    }, 15_000).unref();
  });
  return { exitCode, stdout, stderr };
}

// ============================================================
// Phase 2 Task 1: Outbox dispatch scheduler tests
//
// Verifies the dispatch script behavior against mock responses
// for: success, 403, 500, 504, malformed JSON, and aborted-200
// (contract violation). Also verifies the secret is never printed.
// ============================================================

describe("Phase 2 Task 1: Outbox dispatch scheduler", () => {
  afterAll(async () => {
    if (mockServer) {
      await stopMockServer(mockServer);
      mockServer = null;
    }
  });

  it("exit 0 on 200 success response", async () => {
    mockServer = await startMockServer("success");
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Outbox dispatch completed");
    expect(result.stdout).toContain("sent:         1");
    // Secret must never appear in output
    expect(result.stdout).not.toContain(VALID_SECRET);
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 3 on 403 forbidden", async () => {
    mockServer = await startMockServer("forbidden");
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("403");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 3 on 500 server error", async () => {
    mockServer = await startMockServer("server-error");
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("500");
    expect(result.stderr).toContain("dispatch_failed");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 3 on 504 timeout", async () => {
    mockServer = await startMockServer("timeout");
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("504");
    expect(result.stderr).toContain("dispatch_timeout");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 3 on malformed JSON response", async () => {
    mockServer = await startMockServer("malformed");
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("non-JSON");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 3 on 200 with aborted=true (contract violation)", async () => {
    mockServer = await startMockServer("aborted-200");
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("aborted");
    expect(result.stderr).toContain("contract violation");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 3 on 503 dispatcher disabled", async () => {
    mockServer = await startMockServer("disabled");
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("503");
    expect(result.stderr).toContain("dispatcher_disabled");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 1 when OUTBOX_DISPATCH_URL is missing", async () => {
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      // OUTBOX_DISPATCH_URL intentionally missing
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OUTBOX_DISPATCH_URL");
    expect(result.stderr).not.toContain(VALID_SECRET);
  });

  it("exit 1 when OUTBOX_DISPATCH_SECRET is missing", async () => {
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
      // OUTBOX_DISPATCH_SECRET intentionally missing
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OUTBOX_DISPATCH_SECRET");
  });

  it("exit 1 when secret is too short", async () => {
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_SECRET: "short",
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("16 characters");
  });

  it("never prints the secret in any output", async () => {
    mockServer = await startMockServer("success");
    const result = await runDispatchScript({
      OUTBOX_DISPATCH_URL: DISPATCH_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    const allOutput = result.stdout + result.stderr;
    expect(allOutput).not.toContain(VALID_SECRET);
    // Also check that "Bearer" is not printed
    expect(allOutput).not.toMatch(/Bearer\s+/i);
    await stopMockServer(mockServer);
    mockServer = null;
  });
});

// ============================================================
// Phase 2 Task 2: Outbox status monitor tests
//
// Verifies the status monitor script correctly detects threshold
// violations and fails on malformed/error responses.
// ============================================================

describe("Phase 2 Task 2: Outbox status monitor", () => {
  afterAll(async () => {
    if (mockServer) {
      await stopMockServer(mockServer);
      mockServer = null;
    }
  });

  it("exit 0 when all thresholds pass", async () => {
    mockServer = await startMockServer("status-ok");
    const result = await runStatusScript({
      OUTBOX_DISPATCH_URL: STATUS_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All thresholds passed");
    expect(result.stdout).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 4 when oldest_pending_age exceeds threshold", async () => {
    mockServer = await startMockServer("status-pending-old");
    const result = await runStatusScript({
      OUTBOX_DISPATCH_URL: STATUS_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
      OUTBOX_PENDING_AGE_THRESHOLD_SECONDS: "300",
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("oldest_pending_age_seconds=400");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 4 when oldest_claimed_age exceeds threshold", async () => {
    mockServer = await startMockServer("status-claimed-old");
    const result = await runStatusScript({
      OUTBOX_DISPATCH_URL: STATUS_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
      OUTBOX_CLAIMED_AGE_THRESHOLD_SECONDS: "600",
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("oldest_claimed_age_seconds=700");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 4 when dead_letter_count > 0", async () => {
    mockServer = await startMockServer("status-dead-letter");
    const result = await runStatusScript({
      OUTBOX_DISPATCH_URL: STATUS_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
      OUTBOX_DEAD_LETTER_THRESHOLD: "0",
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("dead_letter_count=1");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 3 on malformed JSON status response", async () => {
    mockServer = await startMockServer("status-malformed");
    const result = await runStatusScript({
      OUTBOX_DISPATCH_URL: STATUS_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("non-JSON");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("exit 3 on 500 status error response", async () => {
    mockServer = await startMockServer("status-error");
    const result = await runStatusScript({
      OUTBOX_DISPATCH_URL: STATUS_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("500");
    expect(result.stderr).toContain("snapshot_failed");
    expect(result.stderr).not.toContain(VALID_SECRET);
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("thresholds are overridable via env", async () => {
    // status-pending-old has oldest_pending_age_seconds=400
    // With threshold 500, it should pass
    mockServer = await startMockServer("status-pending-old");
    const result = await runStatusScript({
      OUTBOX_DISPATCH_URL: STATUS_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
      OUTBOX_PENDING_AGE_THRESHOLD_SECONDS: "500",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All thresholds passed");
    await stopMockServer(mockServer);
    mockServer = null;
  });

  it("never prints the secret in any output", async () => {
    mockServer = await startMockServer("status-ok");
    const result = await runStatusScript({
      OUTBOX_DISPATCH_URL: STATUS_URL,
      OUTBOX_DISPATCH_SECRET: VALID_SECRET,
      OUTBOX_DISPATCH_ALLOWED_HOSTS: "127.0.0.1",
    });
    const allOutput = result.stdout + result.stderr;
    expect(allOutput).not.toContain(VALID_SECRET);
    expect(allOutput).not.toMatch(/Bearer\s+/i);
    await stopMockServer(mockServer);
    mockServer = null;
  });
});
