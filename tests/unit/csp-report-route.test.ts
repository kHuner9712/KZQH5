import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ============================================================
// Work Package G: /api/csp-report route tests
//
// Verifies the CSP violation report endpoint:
//   1. Accepts well-formed reports with 204
//   2. Rejects wrong Content-Type with 415
//   3. Rejects oversized bodies with 413
//   4. Rejects malformed JSON with 400
//   5. Rate-limits after 60 requests / 60s
//   6. Sanitizes URLs (strips query strings / fragments)
//   7. Never logs the full report body
//   8. Returns 204 on GET (no information leak)
// ============================================================

function makePostRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("https://kzq.test/api/csp-report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(raw).byteLength),
      "x-real-ip": "203.0.113.42",
      ...headers,
    },
    body: raw,
  });
}

describe("/api/csp-report POST", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("accepts a well-formed legacy csp-report and returns 204", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    const response = await POST(
      makePostRequest({
        "csp-report": {
          "violated-directive": "img-src",
          "document-uri": "https://kzq.test/products",
          "blocked-uri": "https://evil.example.com/x.png",
          "line-number": 42,
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Should emit a fixed-code log entry.
    expect(logSpy).toHaveBeenCalled();
    const logLine = logSpy.mock.calls[0][0] as string;
    expect(logLine).toContain("CSP_VIOLATION_REPORT");
    expect(logLine).toContain("img-src");
  });

  it("accepts application/reports+json (Reporting API)", async () => {
    const raw = JSON.stringify([
      {
        type: "csp-violation",
        body: {
          violatedDirective: "script-src-elem",
          documentURL: "https://kzq.test/",
          blockedURL: "https://evil.example.com/x.js",
        },
      },
    ]);
    const { POST } = await import("@/app/api/csp-report/route");
    const request = new NextRequest("https://kzq.test/api/csp-report", {
      method: "POST",
      headers: {
        "content-type": "application/reports+json",
        "content-length": String(new TextEncoder().encode(raw).byteLength),
        "x-real-ip": "203.0.113.43",
      },
      body: raw,
    });
    const response = await POST(request);
    expect(response.status).toBe(204);
  });

  it("rejects wrong Content-Type with 415", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    const response = await POST(
      makePostRequest("hello", { "content-type": "text/plain" }),
    );
    expect(response.status).toBe(415);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects oversized Content-Length with 413", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    // Simulate a 10KB declared body.
    const response = await POST(
      makePostRequest("{}", { "content-length": "10240" }),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects oversized actual body with 413", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    // Build a body that is larger than 8KB but with a small Content-Length
    // header (the validator re-checks the actual byte count after reading).
    const huge = "x".repeat(10_000);
    const raw = JSON.stringify({
      "csp-report": { "violated-directive": "img-src", "document-uri": "https://kzq.test/", "extra": huge },
    });
    const request = new NextRequest("https://kzq.test/api/csp-report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.44",
      },
      body: raw,
    });
    const response = await POST(request);
    expect(response.status).toBe(413);
  });

  it("rejects malformed JSON with 400", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    const response = await POST(makePostRequest("{not json"));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("sanitizes query strings from document-uri", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    await POST(
      makePostRequest({
        "csp-report": {
          "violated-directive": "img-src",
          "document-uri": "https://kzq.test/products?token=secret&email=user@example.com",
        },
      }),
    );
    const logLine = logSpy.mock.calls[0][0] as string;
    // The query string MUST be stripped from the logged URL.
    expect(logLine).not.toContain("token=secret");
    expect(logLine).not.toContain("user@example.com");
    expect(logLine).toContain("/products");
  });

  it("sanitizes blocked-uri query strings", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    await POST(
      makePostRequest({
        "csp-report": {
          "violated-directive": "img-src",
          "document-uri": "https://kzq.test/",
          "blocked-uri": "https://evil.example.com/x.png?apikey=leaked",
        },
      }),
    );
    const logLine = logSpy.mock.calls[0][0] as string;
    expect(logLine).not.toContain("apikey=leaked");
  });

  it("does not log the full raw body", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    const secretValue = "SUPER_SECRET_VALUE_THAT_MUST_NOT_BE_LOGGED";
    await POST(
      makePostRequest({
        "csp-report": {
          "violated-directive": "img-src",
          "document-uri": "https://kzq.test/",
        },
        "extra-field": secretValue,
      }),
    );
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(allLogs).not.toContain(secretValue);
  });

  it("rate-limits after 60 requests / 60s from same IP", async () => {
    const { POST } = await import("@/app/api/csp-report/route");
    // Use a unique IP to avoid interference from other tests.
    const makeReqWithIp = (ip: string) => {
      const raw = JSON.stringify({
        "csp-report": { "violated-directive": "img-src", "document-uri": "https://kzq.test/" },
      });
      return new NextRequest("https://kzq.test/api/csp-report", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(raw).byteLength),
          "x-real-ip": ip,
        },
        body: raw,
      });
    };
    // Send 60 requests — all should be allowed.
    for (let i = 0; i < 60; i++) {
      const response = await POST(makeReqWithIp("198.51.100.1"));
      expect(response.status).toBe(204);
    }
    // 61st should be rate-limited.
    const response = await POST(makeReqWithIp("198.51.100.1"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("/api/csp-report GET", () => {
  it("returns 204 to avoid leaking endpoint existence", async () => {
    const { GET } = await import("@/app/api/csp-report/route");
    const response = await GET();
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
