import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ============================================================
// KZQ-P1-013 — HSTS & CSP Reporting Endpoint external protocol
// ------------------------------------------------------------
// EdgeOne terminates TLS and forwards HTTP internally. The middleware
// must:
//   1. Set HSTS based on x-forwarded-proto (user-facing protocol),
//      NOT request.nextUrl.protocol (internal origin protocol).
//   2. Build the Reporting-Endpoints URL from the canonical origin
//      when configured (always https://), falling back to the
//      user-facing protocol + forwarded host in dev.
//
// These tests use the middleware function directly (via dynamic
// import, same pattern as middleware-session.test.ts). We use PUBLIC
// paths (/products) so shouldRefreshSession returns false and no
// fetch() call is triggered.
// ============================================================

const ENV_KEYS = [
  "CANONICAL_APP_ORIGIN",
  "CANONICAL_APP_ORIGIN_ALTERNATES",
] as const;

function clearCanonicalEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(() => {
  vi.unstubAllEnvs();
  clearCanonicalEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearCanonicalEnv();
});

/**
 * Extract the reporting endpoint URL from the Reporting-Endpoints
 * header value. The header format is: csp-endpoint="<url>"
 */
function extractReportEndpoint(headerValue: string | null): string {
  if (!headerValue) return "";
  const match = headerValue.match(/csp-endpoint="([^"]+)"/);
  return match ? match[1] : "";
}

// ============================================================
// HSTS — user-facing protocol detection (KZQ-P1-013)
// ============================================================
describe("HSTS — KZQ-P1-013 user-facing protocol", () => {
  describe("TLS termination (EdgeOne forwards HTTP internally)", () => {
    it("sets HSTS when x-forwarded-proto is https even though internal protocol is http", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: { "x-forwarded-proto": "https" },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "max-age=31536000",
      );
    });

    it("sets HSTS when x-forwarded-proto is https with forwarded host", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://kzq.example.com/products", {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "kzq.example.com",
        },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "max-age=31536000",
      );
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "includeSubDomains",
      );
    });

    it("sets HSTS with canonical origin configured (production path)", async () => {
      vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com");
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: { "x-forwarded-proto": "https" },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "max-age=31536000",
      );
    });
  });

  describe("direct HTTPS (no proxy)", () => {
    it("sets HSTS on direct HTTPS request without x-forwarded-proto", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("https://kzq.example.com/products");
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "max-age=31536000",
      );
    });
  });

  describe("direct HTTP (dev, no proxy)", () => {
    it("does NOT set HSTS on direct HTTP request without x-forwarded-proto", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://localhost:3000/products");
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toBeNull();
    });

    it("does NOT set HSTS when x-forwarded-proto is http", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://kzq.example.com/products", {
        headers: { "x-forwarded-proto": "http" },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toBeNull();
    });
  });

  describe("x-forwarded-proto comma-separated list (proxy chain)", () => {
    it("uses the FIRST value (original client proto)", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: { "x-forwarded-proto": "https, http" },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "max-age=31536000",
      );
    });

    it("does NOT set HSTS when first value is http", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: { "x-forwarded-proto": "http, https" },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toBeNull();
    });
  });

  describe("x-forwarded-proto case-insensitive", () => {
    it("accepts uppercase HTTPS", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: { "x-forwarded-proto": "HTTPS" },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "max-age=31536000",
      );
    });
  });

  describe("invalid x-forwarded-proto", () => {
    it("falls back to request.nextUrl.protocol for unknown value", async () => {
      const { middleware } = await import("@/middleware");
      // Internal https, garbage forwarded proto → fall back to https
      const request = new NextRequest("https://kzq.example.com/products", {
        headers: { "x-forwarded-proto": "ftp" },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "max-age=31536000",
      );
    });
  });

  describe("HSTS applies to both admin and public routes", () => {
    it("sets HSTS on admin route with TLS termination", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/admin", {
        headers: { "x-forwarded-proto": "https" },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "max-age=31536000",
      );
    });

    it("sets HSTS on public route with TLS termination", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: { "x-forwarded-proto": "https" },
      });
      const response = await middleware(request);
      expect(response.headers.get("Strict-Transport-Security")).toContain(
        "max-age=31536000",
      );
    });
  });
});

// ============================================================
// Reporting-Endpoints — canonical origin path (KZQ-P1-013)
// ============================================================
describe("Reporting-Endpoints — KZQ-P1-013 canonical origin", () => {
  describe("canonical origin configured (production)", () => {
    it("uses canonical origin for the reporting endpoint URL", async () => {
      vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com");
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "10.0.0.5",
        },
      });
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toBe("https://kzq.example.com/api/csp-report");
    });

    it("always produces https:// URL even when internal request is http", async () => {
      vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com");
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products");
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toMatch(/^https:\/\//);
    });

    it("uses canonical origin with explicit non-default port", async () => {
      vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com:8443");
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products");
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toBe("https://kzq.example.com:8443/api/csp-report");
    });

    it("uses canonical origin with default port 443 (omitted from display)", async () => {
      vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com:443");
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products");
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toBe("https://kzq.example.com/api/csp-report");
    });

    it("ignores x-forwarded-host when canonical origin is configured", async () => {
      vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com");
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: {
          "x-forwarded-host": "evil.attacker.com",
          "x-forwarded-proto": "https",
        },
      });
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toBe("https://kzq.example.com/api/csp-report");
      expect(endpoint).not.toContain("evil.attacker.com");
    });

    it("uses the first (primary) canonical origin, not alternates", async () => {
      vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com");
      vi.stubEnv(
        "CANONICAL_APP_ORIGIN_ALTERNATES",
        "https://staging.kzq.example.com",
      );
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products");
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toBe("https://kzq.example.com/api/csp-report");
    });
  });

  describe("no canonical origin configured (dev fallback)", () => {
    it("uses forwarded proto + host for the reporting endpoint", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "kzq.example.com",
        },
      });
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toBe("https://kzq.example.com/api/csp-report");
    });

    it("uses request.url when no forwarded headers present", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("https://kzq.example.com/products");
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toBe("https://kzq.example.com/api/csp-report");
    });

    it("uses localhost with dev port for local development", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://localhost:3000/products");
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toBe("http://localhost:3000/api/csp-report");
    });
  });

  describe("mixed-content prevention (never http:// on https pages)", () => {
    it("never produces http:// URL when x-forwarded-proto is https (dev fallback)", async () => {
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("http://10.0.0.5/products", {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "kzq.example.com",
        },
      });
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toMatch(/^https:\/\//);
    });

    it("never produces http:// URL when canonical origin is configured", async () => {
      vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com");
      const { middleware } = await import("@/middleware");
      // Even with http internal proto and no forwarded headers
      const request = new NextRequest("http://10.0.0.5/products");
      const response = await middleware(request);
      const endpoint = extractReportEndpoint(
        response.headers.get("Reporting-Endpoints"),
      );
      expect(endpoint).toMatch(/^https:\/\//);
    });
  });

  describe("header format", () => {
    it("sets the Reporting-Endpoints header with csp-endpoint name", async () => {
      vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com");
      const { middleware } = await import("@/middleware");
      const request = new NextRequest("https://kzq.example.com/products");
      const response = await middleware(request);
      const header = response.headers.get("Reporting-Endpoints");
      expect(header).toMatch(/^csp-endpoint="https:\/\//);
      expect(header).toContain("/api/csp-report");
    });
  });
});

// ============================================================
// Regression: other security headers still present
// ============================================================
describe("regression — other security headers still present", () => {
  it("sets all standard security headers alongside HSTS and Reporting-Endpoints", async () => {
    vi.stubEnv("CANONICAL_APP_ORIGIN", "https://kzq.example.com");
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("http://10.0.0.5/products", {
      headers: { "x-forwarded-proto": "https" },
    });
    const response = await middleware(request);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(response.headers.get("Strict-Transport-Security")).toContain(
      "max-age=31536000",
    );
    expect(response.headers.get("Reporting-Endpoints")).toContain(
      "csp-endpoint=",
    );
  });
});
