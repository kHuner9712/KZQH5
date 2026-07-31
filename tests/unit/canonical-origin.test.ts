import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CanonicalOrigin,
  CanonicalOriginConfig,
  defaultPortFor,
  getCanonicalOriginConfig,
  isCanonicalOriginConfigured,
  normalizePort,
  originsEqual,
} from "@/lib/config/canonical-origin";

// ============================================================
// KZQ-P1-012 — canonical-origin config module unit tests
// ------------------------------------------------------------
// The config module reads process.env.CANONICAL_APP_ORIGIN and
// CANONICAL_APP_ORIGIN_ALTERNATES on every call (no caching), so
// tests can flip configuration by setting/deleting env vars. We
// delete both vars in beforeEach/afterEach to guarantee isolation
// between cases.
// ============================================================

const ENV_KEYS = [
  "CANONICAL_APP_ORIGIN",
  "CANONICAL_APP_ORIGIN_ALTERNATES",
] as const;

function clearCanonicalEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(clearCanonicalEnv);
afterEach(clearCanonicalEnv);

describe("defaultPortFor", () => {
  it("returns 443 for https:", () => {
    expect(defaultPortFor("https:")).toBe("443");
  });

  it("returns 80 for http:", () => {
    expect(defaultPortFor("http:")).toBe("80");
  });

  it("returns empty string for unknown protocols", () => {
    expect(defaultPortFor("ftp:")).toBe("");
    expect(defaultPortFor("ws:")).toBe("");
  });

  it("is case-insensitive", () => {
    expect(defaultPortFor("HTTPS:")).toBe("443");
    expect(defaultPortFor("Http:")).toBe("80");
  });
});

describe("normalizePort", () => {
  it("returns the explicit port when present", () => {
    expect(normalizePort("8443", "https:")).toBe("8443");
  });

  it("lowercases the explicit port", () => {
    // Ports are numeric, but normalize must still be deterministic.
    expect(normalizePort("8443", "HTTPS:")).toBe("8443");
  });

  it("resolves the default when the port is empty", () => {
    expect(normalizePort("", "https:")).toBe("443");
    expect(normalizePort("", "http:")).toBe("80");
  });

  it("returns empty for an empty port and unknown protocol", () => {
    expect(normalizePort("", "ftp:")).toBe("");
  });
});

describe("getCanonicalOriginConfig — not configured", () => {
  it("returns empty origins and configured=false when env is unset", () => {
    const config = getCanonicalOriginConfig();
    expect(config.origins).toHaveLength(0);
    expect(config.configured).toBe(false);
  });

  it("returns empty origins when env is whitespace-only", () => {
    process.env.CANONICAL_APP_ORIGIN = "   ";
    const config = getCanonicalOriginConfig();
    expect(config.origins).toHaveLength(0);
    expect(config.configured).toBe(false);
  });

  it("isCanonicalOriginConfigured returns false", () => {
    expect(isCanonicalOriginConfigured()).toBe(false);
  });
});

describe("getCanonicalOriginConfig — primary origin parsing", () => {
  it("parses a plain https origin (default port 443)", () => {
    process.env.CANONICAL_APP_ORIGIN = "https://kzq.example.com";
    const config = getCanonicalOriginConfig();
    expect(config.configured).toBe(true);
    expect(config.origins).toHaveLength(1);
    const o = config.origins[0];
    expect(o.protocol).toBe("https:");
    expect(o.hostname).toBe("kzq.example.com");
    expect(o.port).toBe("443");
    expect(o.display).toBe("https://kzq.example.com");
  });

  it("parses an explicit default port and omits it from display", () => {
    process.env.CANONICAL_APP_ORIGIN = "https://kzq.example.com:443";
    const config = getCanonicalOriginConfig();
    const o = config.origins[0];
    expect(o.port).toBe("443");
    expect(o.display).toBe("https://kzq.example.com");
  });

  it("parses a non-default port", () => {
    process.env.CANONICAL_APP_ORIGIN = "https://kzq.example.com:8443";
    const config = getCanonicalOriginConfig();
    const o = config.origins[0];
    expect(o.port).toBe("8443");
    expect(o.display).toBe("https://kzq.example.com:8443");
  });

  it("parses http localhost with a dev port", () => {
    process.env.CANONICAL_APP_ORIGIN = "http://localhost:3000";
    const config = getCanonicalOriginConfig();
    const o = config.origins[0];
    expect(o.protocol).toBe("http:");
    expect(o.hostname).toBe("localhost");
    expect(o.port).toBe("3000");
    expect(o.display).toBe("http://localhost:3000");
  });

  it("resolves http default port 80", () => {
    process.env.CANONICAL_APP_ORIGIN = "http://kzq.example.com";
    const config = getCanonicalOriginConfig();
    expect(config.origins[0].port).toBe("80");
  });

  it("strips a trailing path/search/hash", () => {
    process.env.CANONICAL_APP_ORIGIN =
      "https://kzq.example.com/en/products?id=1#top";
    const config = getCanonicalOriginConfig();
    const o = config.origins[0];
    expect(o.hostname).toBe("kzq.example.com");
    expect(o.port).toBe("443");
    expect(o.display).toBe("https://kzq.example.com");
  });

  it("lowercases the hostname and protocol", () => {
    process.env.CANONICAL_APP_ORIGIN = "HTTPS://KZQ.EXAMPLE.COM";
    const config = getCanonicalOriginConfig();
    const o = config.origins[0];
    expect(o.protocol).toBe("https:");
    expect(o.hostname).toBe("kzq.example.com");
  });
});

describe("getCanonicalOriginConfig — alternates", () => {
  it("parses comma-separated alternates after the primary", () => {
    process.env.CANONICAL_APP_ORIGIN = "https://kzq.example.com";
    process.env.CANONICAL_APP_ORIGIN_ALTERNATES =
      "https://www.kzq.example.com,https://staging.kzq.example.com";
    const config = getCanonicalOriginConfig();
    expect(config.origins).toHaveLength(3);
    expect(config.origins[0].hostname).toBe("kzq.example.com");
    expect(config.origins[1].hostname).toBe("www.kzq.example.com");
    expect(config.origins[2].hostname).toBe("staging.kzq.example.com");
  });

  it("silently drops invalid alternate entries", () => {
    process.env.CANONICAL_APP_ORIGIN = "https://kzq.example.com";
    process.env.CANONICAL_APP_ORIGIN_ALTERNATES =
      "ftp://bad.example.com,https://good.example.com,not-a-url,";
    const config = getCanonicalOriginConfig();
    expect(config.origins).toHaveLength(2);
    expect(config.origins[1].hostname).toBe("good.example.com");
  });

  it("works with alternates only (no primary)", () => {
    process.env.CANONICAL_APP_ORIGIN_ALTERNATES = "https://alt.example.com";
    const config = getCanonicalOriginConfig();
    expect(config.configured).toBe(false);
    expect(config.origins).toHaveLength(1);
    expect(isCanonicalOriginConfigured()).toBe(true);
  });
});

describe("getCanonicalOriginConfig — invalid primary", () => {
  it("reports configured=true but yields no origins for a malformed primary", () => {
    process.env.CANONICAL_APP_ORIGIN = "not-a-valid-url";
    const config = getCanonicalOriginConfig();
    expect(config.configured).toBe(true);
    expect(config.origins).toHaveLength(0);
    expect(isCanonicalOriginConfigured()).toBe(false);
  });

  it("rejects a non-http(s) scheme", () => {
    process.env.CANONICAL_APP_ORIGIN = "ftp://kzq.example.com";
    const config = getCanonicalOriginConfig();
    expect(config.configured).toBe(true);
    expect(config.origins).toHaveLength(0);
  });

  it("rejects a javascript: scheme", () => {
    process.env.CANONICAL_APP_ORIGIN = "javascript:void(0)";
    const config = getCanonicalOriginConfig();
    expect(config.origins).toHaveLength(0);
  });
});

describe("originsEqual", () => {
  const canonical: CanonicalOrigin = {
    protocol: "https:",
    hostname: "kzq.example.com",
    port: "443",
    display: "https://kzq.example.com",
  };

  function url(u: string): URL {
    return new URL(u);
  }

  it("matches an identical origin", () => {
    expect(originsEqual(url("https://kzq.example.com"), canonical)).toBe(true);
  });

  it("matches an explicit default port against an implicit one", () => {
    expect(
      originsEqual(url("https://kzq.example.com:443"), canonical),
    ).toBe(true);
  });

  it("is case-insensitive on hostname", () => {
    expect(
      originsEqual(url("https://KZQ.EXAMPLE.COM"), canonical),
    ).toBe(true);
  });

  it("rejects a protocol mismatch", () => {
    expect(originsEqual(url("http://kzq.example.com"), canonical)).toBe(false);
  });

  it("rejects a hostname mismatch", () => {
    expect(originsEqual(url("https://evil.example.com"), canonical)).toBe(false);
  });

  it("rejects a non-default explicit port against the default", () => {
    expect(
      originsEqual(url("https://kzq.example.com:8080"), canonical),
    ).toBe(false);
  });

  it("rejects a subdomain mismatch", () => {
    expect(
      originsEqual(url("https://admin.kzq.example.com"), canonical),
    ).toBe(false);
  });
});

// Static contract: the exported types exist and the functions are callable.
describe("module exports", () => {
  it("exports the expected public API", () => {
    expect(typeof defaultPortFor).toBe("function");
    expect(typeof normalizePort).toBe("function");
    expect(typeof getCanonicalOriginConfig).toBe("function");
    expect(typeof isCanonicalOriginConfigured).toBe("function");
    expect(typeof originsEqual).toBe("function");
  });

  it("CanonicalOriginConfig type is structurally compatible", () => {
    const config: CanonicalOriginConfig = {
      origins: [],
      configured: false,
    };
    expect(config.origins).toHaveLength(0);
  });
});
