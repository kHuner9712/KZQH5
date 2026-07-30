import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { isSameOrigin, isAllowedFetchSite } from "@/lib/services/http-security";

// ============================================================
// isSameOrigin — CDN / TLS-termination aware Origin validation
// ------------------------------------------------------------
// Browser fetch() always sets the Origin header on cross-origin
// and same-origin credentialed requests. The header is browser-
// controlled and cannot be spoofed by JavaScript, so when the
// hostname matches the request host the request is genuinely
// same-origin.
//
// CDN/reverse-proxy deployments (EdgeOne, Cloudflare, Nginx)
// terminate TLS at the edge and forward HTTP internally. The
// browser's Origin is always "https://..." while the internal
// x-forwarded-proto may be "http". Therefore isSameOrigin MUST
// compare ONLY the hostname (and port when both are explicit),
// never the protocol.
//
// These tests verify:
//   1. Missing Origin is rejected (fail-closed).
//   2. Malformed Origin is rejected.
//   3. Missing Host is rejected.
//   4. CDN/TLS-termination scenario: https Origin + http internal
//      host with the SAME hostname MUST be accepted.
//   5. Same-host direct HTTPS request is accepted.
//   6. Different hostname is rejected.
//   7. Different port (both explicit) is rejected.
//   8. x-forwarded-host takes precedence over host.
//   9. Case-insensitive hostname comparison.
//  10. Origin without explicit port matches host with default port.
// ============================================================

function buildRequest(opts: {
  url: string;
  origin?: string;
  host?: string;
  xForwardedHost?: string;
  xForwardedProto?: string;
}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers["origin"] = opts.origin;
  if (opts.host !== undefined) headers["host"] = opts.host;
  if (opts.xForwardedHost !== undefined)
    headers["x-forwarded-host"] = opts.xForwardedHost;
  if (opts.xForwardedProto !== undefined)
    headers["x-forwarded-proto"] = opts.xForwardedProto;
  return new NextRequest(opts.url, {
    method: "POST",
    headers,
  });
}

describe("isSameOrigin — fail-closed cases", () => {
  it("1. rejects when Origin header is missing", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      host: "kzq.example.com",
    });
    expect(isSameOrigin(request)).toBe(false);
  });

  it("2. rejects when Origin header is malformed", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "not-a-valid-url",
      host: "kzq.example.com",
    });
    expect(isSameOrigin(request)).toBe(false);
  });

  it("3. rejects when host and x-forwarded-host are both missing", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "https://kzq.example.com",
    });
    expect(isSameOrigin(request)).toBe(false);
  });
});

describe("isSameOrigin — CDN / TLS-termination scenarios", () => {
  it("4. accepts https Origin with http-internal host (EdgeOne TLS termination)", () => {
    // EdgeOne terminates TLS at the edge. Browser sends Origin: https://...
    // but internally the request is forwarded over http. The protocol MUST
    // NOT be compared — only the hostname matters.
    const request = buildRequest({
      url: "http://kzq.example.com/api/admin/products",
      origin: "https://kzq.example.com",
      host: "kzq.example.com",
      xForwardedProto: "http",
    });
    expect(isSameOrigin(request)).toBe(true);
  });

  it("5. accepts same-host direct HTTPS request (no CDN)", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "https://kzq.example.com",
      host: "kzq.example.com",
      xForwardedProto: "https",
    });
    expect(isSameOrigin(request)).toBe(true);
  });

  it("6. accepts when x-forwarded-proto is missing (Origin still has hostname match)", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "https://kzq.example.com",
      host: "kzq.example.com",
    });
    expect(isSameOrigin(request)).toBe(true);
  });
});

describe("isSameOrigin — rejection cases", () => {
  it("7. rejects when hostname differs", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "https://evil.example.org",
      host: "kzq.example.com",
    });
    expect(isSameOrigin(request)).toBe(false);
  });

  it("8. rejects cross-site Origin with different hostname", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "https://attacker.com",
      host: "kzq.example.com",
    });
    expect(isSameOrigin(request)).toBe(false);
  });

  it("9. rejects when both ports are explicit and differ", () => {
    const request = buildRequest({
      url: "https://kzq.example.com:443/api/admin/products",
      origin: "https://kzq.example.com:8080",
      host: "kzq.example.com:443",
    });
    expect(isSameOrigin(request)).toBe(false);
  });

  it("10. rejects subdomain mismatch (different hostnames)", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "https://admin.kzq.example.com",
      host: "kzq.example.com",
    });
    expect(isSameOrigin(request)).toBe(false);
  });
});

describe("isSameOrigin — x-forwarded-host precedence", () => {
  it("11. uses x-forwarded-host over host when both are present", () => {
    // CDN scenario: x-forwarded-host is the public hostname (matches Origin),
    // while the internal host is the upstream origin server.
    const request = buildRequest({
      url: "http://10.0.0.5/api/admin/products",
      origin: "https://kzq.example.com",
      host: "10.0.0.5",
      xForwardedHost: "kzq.example.com",
      xForwardedProto: "http",
    });
    expect(isSameOrigin(request)).toBe(true);
  });

  it("12. rejects when x-forwarded-host differs from Origin hostname", () => {
    const request = buildRequest({
      url: "http://10.0.0.5/api/admin/products",
      origin: "https://kzq.example.com",
      host: "10.0.0.5",
      xForwardedHost: "evil.example.org",
      xForwardedProto: "http",
    });
    expect(isSameOrigin(request)).toBe(false);
  });
});

describe("isSameOrigin — port handling", () => {
  it("13. accepts when neither Origin nor host has an explicit port", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "https://kzq.example.com",
      host: "kzq.example.com",
    });
    expect(isSameOrigin(request)).toBe(true);
  });

  it("14. accepts when only Origin has explicit port matching default", () => {
    // Origin "https://example.com:443" vs host "example.com"
    // — port 443 is the default for https, so this is a match.
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "https://kzq.example.com:443",
      host: "kzq.example.com",
    });
    expect(isSameOrigin(request)).toBe(true);
  });

  it("15. accepts when only host has explicit port matching default", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      origin: "https://kzq.example.com",
      host: "kzq.example.com:443",
    });
    expect(isSameOrigin(request)).toBe(true);
  });

  it("16. accepts when both have the same explicit port", () => {
    const request = buildRequest({
      url: "https://kzq.example.com:8443/api/admin/products",
      origin: "https://kzq.example.com:8443",
      host: "kzq.example.com:8443",
    });
    expect(isSameOrigin(request)).toBe(true);
  });
});

describe("isSameOrigin — case-insensitive hostname", () => {
  it("17. accepts when hostname case differs but the host is the same", () => {
    const request = buildRequest({
      url: "https://KZQ.Example.COM/api/admin/products",
      origin: "https://kzq.example.com",
      host: "KZQ.Example.COM",
    });
    expect(isSameOrigin(request)).toBe(true);
  });

  it("18. accepts mixed-case x-forwarded-host", () => {
    const request = buildRequest({
      url: "http://10.0.0.5/api/admin/products",
      origin: "https://kzq.example.com",
      host: "10.0.0.5",
      xForwardedHost: "KZQ.EXAMPLE.COM",
      xForwardedProto: "http",
    });
    expect(isSameOrigin(request)).toBe(true);
  });
});

// ============================================================
// isAllowedFetchSite — Sec-Fetch-Site validation (smoke tests)
// ============================================================
describe("isAllowedFetchSite — Sec-Fetch-Site header", () => {
  it("allows missing Sec-Fetch-Site (non-browser client)", () => {
    const request = buildRequest({
      url: "https://kzq.example.com/api/admin/products",
      host: "kzq.example.com",
    });
    expect(isAllowedFetchSite(request)).toBe(true);
  });

  it("allows same-origin", () => {
    const request = new NextRequest(
      "https://kzq.example.com/api/admin/products",
      {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      },
    );
    expect(isAllowedFetchSite(request)).toBe(true);
  });

  it("allows none (user-typed navigation)", () => {
    const request = new NextRequest(
      "https://kzq.example.com/api/admin/products",
      {
        method: "POST",
        headers: { "sec-fetch-site": "none" },
      },
    );
    expect(isAllowedFetchSite(request)).toBe(true);
  });

  it("rejects cross-site", () => {
    const request = new NextRequest(
      "https://kzq.example.com/api/admin/products",
      {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      },
    );
    expect(isAllowedFetchSite(request)).toBe(false);
  });

  it("rejects same-site (subdomain CSRF)", () => {
    const request = new NextRequest(
      "https://kzq.example.com/api/admin/products",
      {
        method: "POST",
        headers: { "sec-fetch-site": "same-site" },
      },
    );
    expect(isAllowedFetchSite(request)).toBe(false);
  });
});
