import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { NextRequest } from "next/server";

// ============================================================
// Phase 10: /api/readiness route tests
//
// Tests cover:
//   1. All checks pass → 200, ready=true
//   2. One check fails → 503, ready=false
//   3. Missing env vars → 503
//   4. Supabase unreachable → 503
//   5. Detail mode requires correct READINESS_TOKEN
//   6. No secrets leak in response body
//   7. Cache-Control is no-store
// ============================================================

async function startMockServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<Server> {
  const server = createServer((req, res) => {
    req.resume();
    handler(req, res);
  });
  server.keepAliveTimeout = 1000;
  server.headersTimeout = 2000;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

function stopServer(server: Server): Promise<void> {
  return new Promise<void>((r) => server.close(() => r()));
}

function getPort(server: Server): number {
  return (server.address() as { port: number }).port;
}

function makeRequest(url = "https://kzq.test/api/readiness"): NextRequest {
  return new NextRequest(url);
}

describe("/api/readiness route", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 when SUPABASE env vars are missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { GET } = await import("@/app/api/readiness/route");
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Must not leak env var names or values
    expect(JSON.stringify(body)).not.toContain("SUPABASE");
    expect(JSON.stringify(body)).not.toContain("SERVICE_ROLE");
  });

  it("returns 503 when Supabase is unreachable (network error)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
    const { GET } = await import("@/app/api/readiness/route");
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    // All three checks should be in error/timeout state
    const latencies = body.checks.map((c: { latency: string }) => c.latency);
    expect(latencies.every((l: string) => l === "error" || l === "timeout")).toBe(true);
    // Service role key must never appear in the output
    expect(JSON.stringify(body)).not.toContain("fake-service-role-key");
  });

  it("returns 200 when all checks pass via mock PostgREST", async () => {
    const server = await startMockServer((req, res) => {
      const headers = { "Content-Type": "application/json", Connection: "close" };
      if (req.url?.includes("/rest/v1/products")) {
        res.writeHead(200, headers);
        res.end(JSON.stringify([{ id: "test-id" }]));
        return;
      }
      if (req.url?.includes("/rest/v1/rpc/verify_schema_readiness")) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true, checks: [] }));
        return;
      }
      if (req.url?.includes("/storage/v1/bucket")) {
        // 403 is fine — storage is alive, just not listable with anon key
        res.writeHead(403, headers);
        res.end("");
        return;
      }
      res.writeHead(404, headers);
      res.end("{}");
    });
    const port = getPort(server);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
    try {
      const { GET } = await import("@/app/api/readiness/route");
      const response = await GET(makeRequest());
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.ready).toBe(true);
      expect(body.checks).toHaveLength(3);
      // All checks should be ready
      expect(body.checks.every((c: { ready: boolean }) => c.ready)).toBe(true);
      // Latency should be fast/slow (not error/timeout)
      const latencies = body.checks.map((c: { latency: string }) => c.latency);
      expect(latencies.every((l: string) => l === "fast" || l === "slow")).toBe(true);
      // Without detail token, no detail field should be present
      expect(body.checks.every((c: { detail?: string }) => !c.detail)).toBe(true);
      // No secrets in output
      expect(JSON.stringify(body)).not.toContain("fake-service-role-key");
      expect(JSON.stringify(body)).not.toContain("anon-key");
    } finally {
      await stopServer(server);
    }
  });

  it("returns 503 when RPC returns ok=false", async () => {
    const server = await startMockServer((req, res) => {
      const headers = { "Content-Type": "application/json", Connection: "close" };
      if (req.url?.includes("/rest/v1/products")) {
        res.writeHead(200, headers);
        res.end(JSON.stringify([{ id: "test-id" }]));
        return;
      }
      if (req.url?.includes("/rest/v1/rpc/verify_schema_readiness")) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: false, checks: [] }));
        return;
      }
      if (req.url?.includes("/storage/v1/bucket")) {
        res.writeHead(403, headers);
        res.end("");
        return;
      }
      res.writeHead(404, headers);
      res.end("{}");
    });
    const port = getPort(server);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
    try {
      const { GET } = await import("@/app/api/readiness/route");
      const response = await GET(makeRequest());
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body.ready).toBe(false);
      // The critical_rpc check should be the one that failed
      const rpcCheck = body.checks.find(
        (c: { name: string }) => c.name === "critical_rpc",
      );
      expect(rpcCheck.ready).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it("includes detail field when correct READINESS_TOKEN is provided", async () => {
    const server = await startMockServer((req, res) => {
      const headers = { "Content-Type": "application/json", Connection: "close" };
      if (req.url?.includes("/rest/v1/products")) {
        // Return 500 to trigger a detail field
        res.writeHead(500, headers);
        res.end("{}");
        return;
      }
      res.writeHead(200, headers);
      res.end("{}");
    });
    const port = getPort(server);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
    vi.stubEnv("READINESS_TOKEN", "secret-readiness-token");
    try {
      const { GET } = await import("@/app/api/readiness/route");
      const request = new NextRequest("https://kzq.test/api/readiness", {
        headers: { Authorization: "Bearer secret-readiness-token" },
      });
      const response = await GET(request);
      const body = await response.json();
      expect(response.status).toBe(503);
      // With the token, the products check should have a detail field
      const productsCheck = body.checks.find(
        (c: { name: string }) => c.name === "public_products",
      );
      expect(productsCheck.detail).toContain("HTTP 500");
      // Token must never appear in the output
      expect(JSON.stringify(body)).not.toContain("secret-readiness-token");
    } finally {
      await stopServer(server);
    }
  });

  it("does NOT include detail when token is wrong", async () => {
    const server = await startMockServer((req, res) => {
      const headers = { "Content-Type": "application/json", Connection: "close" };
      if (req.url?.includes("/rest/v1/products")) {
        res.writeHead(500, headers);
        res.end("{}");
        return;
      }
      res.writeHead(200, headers);
      res.end("{}");
    });
    const port = getPort(server);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
    vi.stubEnv("READINESS_TOKEN", "secret-readiness-token");
    try {
      const { GET } = await import("@/app/api/readiness/route");
      const request = new NextRequest("https://kzq.test/api/readiness", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      const response = await GET(request);
      const body = await response.json();
      // Detail should NOT be included with wrong token
      const productsCheck = body.checks.find(
        (c: { name: string }) => c.name === "public_products",
      );
      expect(productsCheck.detail).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  });

  it("treats storage 401/403 as ready (storage is alive)", async () => {
    const server = await startMockServer((req, res) => {
      const headers = { "Content-Type": "application/json", Connection: "close" };
      if (req.url?.includes("/rest/v1/products")) {
        res.writeHead(200, headers);
        res.end(JSON.stringify([{ id: "test-id" }]));
        return;
      }
      if (req.url?.includes("/rest/v1/rpc/verify_schema_readiness")) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true, checks: [] }));
        return;
      }
      if (req.url?.includes("/storage/v1/bucket")) {
        res.writeHead(401, headers);
        res.end("");
        return;
      }
      res.writeHead(404, headers);
      res.end("{}");
    });
    const port = getPort(server);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
    try {
      const { GET } = await import("@/app/api/readiness/route");
      const response = await GET(makeRequest());
      const body = await response.json();
      expect(response.status).toBe(200);
      const storageCheck = body.checks.find(
        (c: { name: string }) => c.name === "storage",
      );
      expect(storageCheck.ready).toBe(true);
    } finally {
      await stopServer(server);
    }
  });
});

// ============================================================
// Phase 10: Unified server logging tests
// ============================================================

describe("lib/logging/server-log", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("logServerError emits structured format with code, stage, and cause", async () => {
    const { logServerError } = await import("@/lib/logging/server-log");
    logServerError("INQUIRY_SUBMIT_FAILED", "inquiry.submit", "rpc-error");
    expect(errorSpy).toHaveBeenCalledOnce();
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).toContain("[inquiry.submit]");
    expect(output).toContain("INQUIRY_SUBMIT_FAILED");
    expect(output).toContain("cause=rpc-error");
  });

  it("logServerError sanitizes email addresses from detail", async () => {
    const { logServerError } = await import("@/lib/logging/server-log");
    logServerError(
      "ADMIN_GUARD_PROFILE",
      "admin.guard",
      "config",
      "user admin@example.com not found",
    );
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).not.toContain("admin@example.com");
    expect(output).toContain("[email]");
  });

  it("logServerError sanitizes phone numbers from detail", async () => {
    const { logServerError } = await import("@/lib/logging/server-log");
    logServerError(
      "INQUIRY_VALIDATION",
      "inquiry.validate",
      "validation",
      "phone +86 138 0013 8000 is invalid",
    );
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).not.toContain("138 0013 8000");
    expect(output).toContain("[phone]");
  });

  it("logServerError sanitizes Bearer tokens from detail", async () => {
    const { logServerError } = await import("@/lib/logging/server-log");
    logServerError(
      "AUTH_ERROR",
      "auth.verify",
      "auth",
      "Bearer eyJhbGciOiJIUzI1NiJ9.token.here",
    );
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(output).toContain("[token]");
  });

  it("logServerError sanitizes UUIDs from detail", async () => {
    const { logServerError } = await import("@/lib/logging/server-log");
    logServerError(
      "PRODUCT_NOT_FOUND",
      "product.fetch",
      "unknown",
      "id 11111111-1111-4111-8111-111111111111 not found",
    );
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(output).toContain("[uuid]");
  });

  it("logServerError sanitizes long hex strings (API keys)", async () => {
    const { logServerError } = await import("@/lib/logging/server-log");
    const fakeKey = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    logServerError("CONFIG_ERROR", "config.load", "config", fakeKey);
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).not.toContain(fakeKey);
    expect(output).toContain("[hash]");
  });

  it("logServerInfo uses console.log with code and stage", async () => {
    const { logServerInfo } = await import("@/lib/logging/server-log");
    logServerInfo("OUTBOX_PROCESSED", "outbox.processor", "3 events sent");
    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("[outbox.processor]");
    expect(output).toContain("OUTBOX_PROCESSED");
    expect(output).toContain("3 events sent");
  });
});
