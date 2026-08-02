import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SUPABASE_PROJECT_HOST_PATTERN,
  isLoopbackHost,
  parseCdnDomains,
  parseSupabaseUrl,
  validateCdnDomainEntry,
} from "@/lib/config/media-domains.mjs";

// ============================================================
// KZQ-P2-003: unified media domain config — single source of truth
// ------------------------------------------------------------
// lib/config/media-domains.mjs is the ONE place the Supabase project-host
// regex, CDN entry validation, URL parsing and loopback detection live.
// This spec verifies the config matrix AND that every consumer
// (next.config.mjs, lib/validation/url.ts, lib/security/csp-policy.ts,
// scripts/check-release-readiness.mjs) imports the shared module instead
// of re-defining the rules (which would let config and runtime drift).
// ============================================================

const root = process.cwd();

describe("KZQ-P2-003: media domain config matrix", () => {
  it("SUPABASE_PROJECT_HOST_PATTERN matches only canonical project-ref hosts", () => {
    expect(SUPABASE_PROJECT_HOST_PATTERN.test("abcdefghijklmnopqrst.supabase.co")).toBe(true);
    expect(SUPABASE_PROJECT_HOST_PATTERN.test("a1b2c3d4e5f6g7h8i9j0.supabase.co")).toBe(true);

    // Wrong ref length / shape.
    expect(SUPABASE_PROJECT_HOST_PATTERN.test("short.supabase.co")).toBe(false);
    expect(SUPABASE_PROJECT_HOST_PATTERN.test("ABCDEFGHIJKLMNOPQRST.supabase.co")).toBe(false);
    expect(SUPABASE_PROJECT_HOST_PATTERN.test("abcdefghijklmnopqrst.supabase.com")).toBe(false);
    expect(SUPABASE_PROJECT_HOST_PATTERN.test("abcdefghijklmnopqrst.supabase.co.evil.com")).toBe(false);
    expect(SUPABASE_PROJECT_HOST_PATTERN.test("a-bcdefghijklmnopqrst.supabase.co")).toBe(false);
    // Wildcard / subdomain is NOT canonical.
    expect(SUPABASE_PROJECT_HOST_PATTERN.test("**" )).toBe(false);
    expect(SUPABASE_PROJECT_HOST_PATTERN.test("*.supabase.co")).toBe(false);
  });

  it("validateCdnDomainEntry accepts hostname-only entries and normalizes case", () => {
    expect(validateCdnDomainEntry("cdn.example.com")).toBe("cdn.example.com");
    expect(validateCdnDomainEntry("  IMG.KZQ.COM.CN  ")).toBe("img.kzq.com.cn");
    expect(validateCdnDomainEntry("kzq-static.example.com")).toBe("kzq-static.example.com");
  });

  it("validateCdnDomainEntry rejects protocols, ports, paths, IPs and bare TLDs", () => {
    for (const bad of [
      "https://cdn.example.com",
      "cdn.example.com:8443",
      "cdn.example.com/path",
      "cdn.example.com?x=1",
      "user@cdn.example.com",
      "192.168.1.1",
      "example",
      ".example.com",
      "example.com.",
      "example..com",
      "[::1]",
      "",
      "   ",
    ]) {
      expect(validateCdnDomainEntry(bad)).toBeNull();
    }
  });

  it("parseCdnDomains parses a comma list and drops invalid entries", () => {
    expect(parseCdnDomains("cdn.a.com, CDN.B.com ,bad")).toEqual([
      "cdn.a.com",
      "cdn.b.com",
    ]);
    expect(parseCdnDomains("")).toEqual([]);
    expect(parseCdnDomains("https://x.com, y.com")).toEqual(["y.com"]);
  });

  it("parseSupabaseUrl returns normalized protocol/hostname/port", () => {
    expect(parseSupabaseUrl("https://abcdefghijklmnopqrst.supabase.co")).toEqual({
      protocol: "https",
      hostname: "abcdefghijklmnopqrst.supabase.co",
      port: "",
    });
    expect(parseSupabaseUrl("HTTPS://localhost:8443")).toEqual({
      protocol: "https",
      hostname: "localhost",
      port: "8443",
    });
    expect(parseSupabaseUrl("http://127.0.0.1")).toEqual({
      protocol: "http",
      hostname: "127.0.0.1",
      port: "",
    });
    expect(parseSupabaseUrl("not a url")).toBeNull();
    expect(parseSupabaseUrl("")).toBeNull();
  });

  it("isLoopbackHost resists case / trailing dot / IPv6 bracket bypass", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("localhost.")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("supabase.co")).toBe(false);
    expect(isLoopbackHost("127.0.0.2")).toBe(false);
  });
});

describe("KZQ-P2-003: every consumer imports the shared module (no drift)", () => {
  it("next.config.mjs imports media-domains and defines no duplicate rules", () => {
    const next = readFileSync(`${root}/next.config.mjs`, "utf-8");
    expect(next).toMatch(/import \{[^}]*isLoopbackHost[^}]*\} from "\.\/lib\/config\/media-domains\.mjs"/);
    expect(next).toMatch(/SUPABASE_PROJECT_HOST_PATTERN/);
    // No re-declaration of the regex or the CDN validator.
    expect(next).not.toMatch(/const SUPABASE_PROJECT_HOST_PATTERN =/);
    expect(next).not.toMatch(/function validateCdnDomainEntry/);
    // CI mock-backend bypass is preserved (3-condition guard).
    expect(next).toMatch(/BUILD_MOCK_BACKEND_FLAG && IS_CI && IS_LOOPBACK_SUPABASE_HOST/);
    expect(next).toMatch(/BUILD_MOCK_BACKEND=true is only allowed in CI/);
  });

  it("lib/validation/url.ts imports media-domains and defines no duplicate rules", () => {
    const url = readFileSync(`${root}/lib/validation/url.ts`, "utf-8");
    expect(url).toMatch(/from "@\/lib\/config\/media-domains\.mjs"/);
    expect(url).not.toMatch(/const SUPABASE_PROJECT_HOST_PATTERN =/);
    expect(url).not.toMatch(/function validateCdnDomainEntry/);
    expect(url).not.toMatch(/function isLoopbackHost/);
  });

  it("lib/security/csp-policy.ts imports media-domains and defines no duplicate rules", () => {
    const csp = readFileSync(`${root}/lib/security/csp-policy.ts`, "utf-8");
    expect(csp).toMatch(/from "@\/lib\/config\/media-domains\.mjs"/);
    expect(csp).not.toMatch(/const SUPABASE_PROJECT_HOST_PATTERN =/);
    expect(csp).not.toMatch(/const LOOPBACK_HOSTS/);
  });

  it("scripts/check-release-readiness.mjs imports media-domains and defines no duplicate isLoopbackHost", () => {
    const readiness = readFileSync(`${root}/scripts/check-release-readiness.mjs`, "utf-8");
    expect(readiness).toMatch(/from "\.\.\/lib\/config\/media-domains\.mjs"/);
    expect(readiness).not.toMatch(/function isLoopbackHost/);
  });
});
