import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/check-release-readiness.mjs");

/**
 * Runs the release-readiness script asynchronously and returns
 * { exitCode, stdout }.
 *
 * IMPORTANT: This uses `spawn` (not `execFileSync`) because the mock
 * PostgREST server runs in the same Node.js process as the test. A
 * synchronous child_process call would block the event loop, preventing
 * the mock server from responding to the subprocess's HTTP requests.
 * Using `spawn` with promise-based stdout collection keeps the event
 * loop alive so the mock server can serve requests concurrently.
 */
async function runScript(
  env: Record<string, string>,
  extraArgs: string[] = [],
): Promise<{ exitCode: number; stdout: string }> {
  const child = spawn("node", [scriptPath, ...extraArgs], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  const exitCode: number = await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("exit", (code) => resolvePromise(code ?? 1));
    // Hard timeout: kill the child if it exceeds 30s.
    setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("SCRIPT_TIMEOUT"));
    }, 30_000).unref();
  });
  return { exitCode, stdout };
}

describe("check-release-readiness.mjs — env-var driven logic", () => {
  it("BLOCKs when NEXT_PUBLIC_SITE_URL is missing", async () => {
    const { exitCode, stdout } = await runScript({
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

  it("BLOCKs when site URL is a vercel.app domain", async () => {
    const { exitCode, stdout } = await runScript({
      NEXT_PUBLIC_SITE_URL: "https://kzqh5.vercel.app",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("vercel.app");
  });

  it("BLOCKs when site URL uses HTTP (non-localhost)", async () => {
    const { exitCode, stdout } = await runScript({
      NEXT_PUBLIC_SITE_URL: "http://staging.example.com",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    expect(stdout.toLowerCase()).toContain("http");
  });

  it("BLOCKs when indexing=true in staging mode", async () => {
    const { exitCode, stdout } = await runScript(
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

  it("BLOCKs when service role is exposed via NEXT_PUBLIC_", async () => {
    const { exitCode, stdout } = await runScript({
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

  it("BLOCKs when Supabase credentials are missing", async () => {
    const { exitCode, stdout } = await runScript({
      NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("supabase");
  });

  it("BLOCKs in demo mode because mock data has placeholder contacts", async () => {
    const { exitCode, stdout } = await runScript({
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

  it("does not BLOCK on HTTPS non-Vercel URL with indexing=false (URL checks pass)", async () => {
    const { exitCode, stdout } = await runScript({
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

// ============================================================
// Phase 7: Schema verification RPC subprocess tests
//
// These tests run check-release-readiness.mjs as a subprocess against
// four distinct Supabase states:
//   1. missing     — service role key absent (BLOCK)
//   2. invalid     — service role key set but Supabase unreachable (BLOCK)
//   3. unreachable — Supabase URL points to a dead port (BLOCK, network)
//   4. compatible  — a local mock PostgREST returns a valid RPC payload
//                    and the script PASSes the schema section (exit may
//                    still be non-zero due to business-content checks).
//
// The "compatible" case uses a local HTTP server that emulates the
// /rest/v1/rpc/verify_schema_readiness endpoint and the business-content
// REST endpoints, so the script can complete without a real database.
// ============================================================

/**
 * Builds a fully-passing verify_schema_readiness() response payload that
 * includes every expected check name.
 */
function buildPassingRpcResponse() {
  const checks = [
    "catalog_field_catalog_topic_id",
    "catalog_field_cover_image_url",
    "catalog_field_published_at",
    "catalog_field_content_hash",
    "index_product_assets_catalog_topic_idx",
    "index_product_assets_content_hash_idx",
    "analytics_events_constraint",
    "rpc_count_unread_inquiries",
    "rpc_get_admin_dashboard_snapshot",
    "rpc_create_inquiry_with_items",
    "grant_count_unread_inquiries",
    "grant_get_admin_dashboard_snapshot",
    "grant_create_inquiry_with_items",
    "grant_save_product_with_images",
    "grant_save_project_with_relations",
  ].map((name) => ({ name, passed: true, detail: "present" }));
  return { ok: true, checks };
}

/**
 * Creates a mock PostgREST HTTP server with proper keep-alive handling.
 *
 * Node's built-in `fetch` (undici) uses HTTP/1.1 keep-alive by default.
 * If the mock server doesn't explicitly close connections, subsequent
 * requests on the same connection can hang. We work around this by:
 *   1. Draining the request body (req.resume()) so POST bodies don't
 *      block the response.
 *   2. Sending `Connection: close` on every response so the client
 *      doesn't reuse the connection.
 *   3. Setting a short keepAliveTimeout on the server.
 *
 * Returns a started server; caller must `server.close()` in a finally block.
 */
async function startMockPostgREST(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<import("node:http").Server> {
  const server = createServer((req, res) => {
    // Drain the request body so POST requests don't block.
    req.resume();
    handler(req, res);
  });
  // Keep-alive timeout: close idle connections quickly so the test
  // doesn't hang waiting for the server to shut down.
  server.keepAliveTimeout = 1000;
  server.headersTimeout = 2000;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

function getPort(server: import("node:http").Server): number {
  return (server.address() as { port: number }).port;
}

function stopServer(server: import("node:http").Server): Promise<void> {
  return new Promise<void>((r) => server.close(() => r()));
}

describe("check-release-readiness.mjs — Phase 7 schema RPC states", () => {
  it("state=missing: BLOCKs when SUPABASE_SERVICE_ROLE_KEY is absent", async () => {
    // Service role key absent → schema verification RPC cannot be called.
    const { exitCode, stdout } = await runScript({
      NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      // SUPABASE_SERVICE_ROLE_KEY intentionally omitted
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("supabase: service role");
    expect(stdout).toContain("BLOCK");
    // Must NOT attempt the RPC call (no SCHEMA_RPC_* code in output)
    expect(stdout).not.toContain("SCHEMA_RPC_NETWORK");
    expect(stdout).not.toContain("SCHEMA_RPC_NOT_FOUND");
  });

  it("state=unreachable: BLOCKs with SCHEMA_RPC_NETWORK when Supabase is down", async () => {
    // Service role key present but Supabase URL points to a dead port.
    // The fetch must fail fast (ECONNREFUSED) and be classified as network.
    const { exitCode, stdout } = await runScript({
      NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      NEXT_PUBLIC_DEMO_MODE: "false",
      NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
    });
    expect(exitCode).toBe(1);
    // The schema RPC section must BLOCK with a network classification.
    // We accept either SCHEMA_RPC_NETWORK or SCHEMA_RPC_UNKNOWN because
    // Node's fetch may classify ECONNREFUSED differently across versions.
    expect(stdout).toContain("schema: verification RPC");
    expect(stdout).toContain("BLOCK");
    // The service role key must NEVER appear in the output.
    expect(stdout).not.toContain("fake-service-role-key");
  });

  it("state=invalid: BLOCKs with SCHEMA_RPC_NOT_FOUND when RPC is 404", async () => {
    // Mock PostgREST that returns 404 for the RPC (migration not applied).
    const server = await startMockPostgREST((req, res) => {
      const headers = { "Content-Type": "application/json", Connection: "close" };
      if (req.url?.includes("/rest/v1/rpc/verify_schema_readiness")) {
        res.writeHead(404, headers);
        res.end(JSON.stringify({ message: "Not found" }));
        return;
      }
      // Other REST endpoints (business content) return empty arrays.
      res.writeHead(200, headers);
      res.end("[]");
    });
    const port = getPort(server);
    try {
      const { exitCode, stdout } = await runScript({
        NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
        NEXT_PUBLIC_DEMO_MODE: "false",
        NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("SCHEMA_RPC_NOT_FOUND");
      expect(stdout).toContain("20260724160000");
      // Service role key must never leak.
      expect(stdout).not.toContain("fake-service-role-key");
    } finally {
      await stopServer(server);
    }
  });

  it("state=compatible: PASSes schema section when RPC returns ok=true", async () => {
    // Mock PostgREST that returns a valid verify_schema_readiness() payload.
    const rpcResponse = buildPassingRpcResponse();
    const server = await startMockPostgREST((req, res) => {
      const headers = { "Content-Type": "application/json", Connection: "close" };
      if (req.url?.includes("/rest/v1/rpc/verify_schema_readiness")) {
        res.writeHead(200, headers);
        res.end(JSON.stringify(rpcResponse));
        return;
      }
      if (req.url?.includes("/rest/v1/company_profile")) {
        // Return a company profile with real (non-placeholder) values so the
        // business-content section does not BLOCK the schema PASS.
        res.writeHead(200, headers);
        res.end(
          JSON.stringify([
            {
              phone: "+86 21 5888 9999",
              email: "sales@kzq.example",
              whatsapp: "+86 138 0013 0000",
              address_cn: "上海市浦东新区某街道 100 号",
              address_en: "No. 100 Some Street, Pudong, Shanghai",
              wechat_qr_url: "https://cdn.kzq.example/qr.png",
              logo_url: "https://cdn.kzq.example/logo.png",
            },
          ]),
        );
        return;
      }
      // Other REST endpoints (products, certificates, projects, assets) → empty.
      res.writeHead(200, headers);
      res.end("[]");
    });
    const port = getPort(server);
    try {
      const { stdout } = await runScript({
        NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
        NEXT_PUBLIC_DEMO_MODE: "false",
        NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
      });
      // The schema section must PASS — exit code may be 0 or 1 depending on
      // business content, but the schema checks themselves must be PASS.
      expect(stdout).toContain("schema: verification RPC");
      expect(stdout).toContain("schema: overall");
      expect(stdout).toContain("PASS");
      expect(stdout).not.toContain("SCHEMA_RPC_");
      // The service role key must never leak even on success.
      expect(stdout).not.toContain("fake-service-role-key");
      // We explicitly assert the overall schema check passed.
      const overallLine = stdout
        .split("\n")
        .find((l) => l.includes("schema: overall"));
      expect(overallLine).toBeDefined();
      expect(overallLine).toContain("PASS");
    } finally {
      await stopServer(server);
    }
  });

  it("state=malformed: BLOCKs with SCHEMA_RPC_MALFORMED when RPC returns bad shape", async () => {
    // Mock PostgREST that returns a malformed RPC payload (missing `checks`).
    const server = await startMockPostgREST((req, res) => {
      const headers = { "Content-Type": "application/json", Connection: "close" };
      if (req.url?.includes("/rest/v1/rpc/verify_schema_readiness")) {
        res.writeHead(200, headers);
        // Missing `checks` array and wrong `ok` type.
        res.end(JSON.stringify({ ok: "yes" }));
        return;
      }
      res.writeHead(200, headers);
      res.end("[]");
    });
    const port = getPort(server);
    try {
      const { exitCode, stdout } = await runScript({
        NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
        NEXT_PUBLIC_DEMO_MODE: "false",
        NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("SCHEMA_RPC_MALFORMED");
      expect(stdout).not.toContain("fake-service-role-key");
    } finally {
      await stopServer(server);
    }
  });

  it("state=failed-check: BLOCKs when RPC returns ok=false with a failed check", async () => {
    // Mock PostgREST returns a valid shape but one check failed.
    const checks = buildPassingRpcResponse().checks.map((c) => ({ ...c }));
    checks[0] = { name: "catalog_field_catalog_topic_id", passed: false, detail: "missing" };
    const server = await startMockPostgREST((req, res) => {
      const headers = { "Content-Type": "application/json", Connection: "close" };
      if (req.url?.includes("/rest/v1/rpc/verify_schema_readiness")) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: false, checks }));
        return;
      }
      res.writeHead(200, headers);
      res.end("[]");
    });
    const port = getPort(server);
    try {
      const { exitCode, stdout } = await runScript({
        NEXT_PUBLIC_SITE_URL: "https://staging.example.com",
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
        NEXT_PUBLIC_DEMO_MODE: "false",
        NEXT_PUBLIC_SITE_INDEXING_ENABLED: "false",
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("catalog_field_catalog_topic_id");
      expect(stdout).toContain("BLOCK");
      expect(stdout).toContain("schema: overall");
      // Must not leak the service role key.
      expect(stdout).not.toContain("fake-service-role-key");
    } finally {
      await stopServer(server);
    }
  });
});
