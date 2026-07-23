import { afterEach, describe, expect, it, vi } from "vitest";
import { isIndexingEnabled } from "@/lib/site-indexing";

describe("isIndexingEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when env var is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    expect(isIndexingEnabled()).toBe(false);
  });

  it("returns false when env var is 'false'", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "false");
    expect(isIndexingEnabled()).toBe(false);
  });

  it("returns true only when env var is strictly 'true'", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "true");
    expect(isIndexingEnabled()).toBe(true);
  });

  it("does NOT fuzzy-match 'TRUE' as true (case-sensitive)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "TRUE");
    expect(isIndexingEnabled()).toBe(false);
  });

  it("does NOT fuzzy-match 'True' as true", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "True");
    expect(isIndexingEnabled()).toBe(false);
  });

  it("does NOT fuzzy-match '1' as true", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "1");
    expect(isIndexingEnabled()).toBe(false);
  });

  it("does NOT fuzzy-match 'yes' as true", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "yes");
    expect(isIndexingEnabled()).toBe(false);
  });

  it("defaults to noindex in demo mode unless explicitly 'true'", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    expect(isIndexingEnabled()).toBe(false);
  });

  it("can be explicitly enabled in demo mode", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "true");
    expect(isIndexingEnabled()).toBe(true);
  });

  it("defaults to noindex in Vercel environment unless explicitly 'true'", () => {
    // Simulate Vercel production environment (no explicit indexing flag)
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    expect(isIndexingEnabled()).toBe(false);
  });

  it("can be enabled in Vercel if explicitly set (not recommended)", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "true");
    expect(isIndexingEnabled()).toBe(true);
  });

  it("defaults to noindex in EdgeOne environment unless explicitly 'true'", () => {
    vi.stubEnv("EDGEONE", "true");
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    expect(isIndexingEnabled()).toBe(false);
  });
});
