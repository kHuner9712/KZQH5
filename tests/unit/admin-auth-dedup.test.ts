import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// KZQ-P2-001: getVerifiedAdmin request-level memoization
// ------------------------------------------------------------
// React `cache()` semantics (react.react-server.development.js:575-618):
//   - With a request dispatcher (Next.js RSC / Route Handler context) the
//     memoization is keyed per-request (AsyncLocalStorage) — repeated calls
//     in the SAME request share one result, and results NEVER leak across
//     requests/users.
//   - WITHOUT a dispatcher (plain Node / vitest direct calls) `cache()`
//     PASSES THROUGH: every call executes for real. That is the safe lower
//     bound — identity is never cached across calls.
//
// vitest has no React request dispatcher, so this spec replaces `cache`
// with a scope simulator that reproduces the documented semantics (a
// per-scope Map, pass-through when no scope is active) and verifies the
// real getVerifiedAdmin behavior against it:
//   1) same request scope → single getUser() + single admin_profiles query;
//   2) a new request scope → verification runs again (no cross-request leak);
//   3) no request scope → pass-through (never caches across calls).
// Plus a static source contract locking the cache() wrapper in place.
// ============================================================

const { mockCache, setCacheScope } = vi.hoisted(() => {
  // Simulates React cache(): per-scope Map when a scope is active,
  // pass-through (no caching) when it is not.
  let scope: Map<Function, unknown> | null = null;
  const mockCache = vi.fn(
    (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]): unknown => {
        if (!scope) return fn(...args);
        if (!scope.has(fn)) {
          scope.set(fn, fn(...args));
        }
        return scope.get(fn);
      },
  );
  return {
    mockCache,
    setCacheScope: (s: Map<Function, unknown> | null) => {
      scope = s;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: mockCache };
});

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: vi.fn(),
}));

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";

// Test fixtures: no real email, UUID, token, or database error text.
const mockUser = { id: "test-user-id", email: null } as any;
const profileA = { id: "test-user-id", email: null, role: "admin" } as any;
const profileB = { id: "test-user-id", email: null, role: "super_admin" } as any;

/** Session client with an aal1 session and no verified factor (passes). */
function makeSessionClient(user: unknown) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
          data: {
            currentLevel: "aal1",
            nextLevel: "aal1",
            currentAuthenticationMethods: [],
          },
          error: null,
        }),
      },
    },
  };
}

function makeAdminClient(profile: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: profile, error: null }),
        }),
      }),
    }),
  };
}

describe("KZQ-P2-001: getVerifiedAdmin request-level memoization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no request scope (pass-through, like vitest / plain Node).
    setCacheScope(null);
  });

  it("is wrapped with React cache() (static source contract)", () => {
    const source = readFileSync("lib/services/admin-auth.ts", "utf-8");
    expect(source).toMatch(/import \{ cache \} from "react"/);
    expect(source).toMatch(/export const getVerifiedAdmin = cache\(/);
    // Same pattern as the existing lib/queries/cms.ts precedent.
    const cms = readFileSync("lib/queries/cms.ts", "utf-8");
    expect(cms).toMatch(/export const fetchSiteSettings = cache\(/);
  });

  it("executes the expensive verification once per request scope (repeated calls dedup)", async () => {
    setCacheScope(new Map());
    const sessionClient = makeSessionClient(mockUser);
    const adminClient = makeAdminClient(profileA);
    vi.mocked(createServerSupabaseClient).mockReturnValue(sessionClient as any);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(adminClient as any);

    const first = await getVerifiedAdmin();
    const second = await getVerifiedAdmin();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Same request scope → getUser / AAL probe / profile query run once.
    expect(sessionClient.auth.getUser).toHaveBeenCalledTimes(1);
    expect(
      sessionClient.auth.mfa.getAuthenticatorAssuranceLevel,
    ).toHaveBeenCalledTimes(1);
    expect(adminClient.from).toHaveBeenCalledTimes(1);
    // Both callers share the identical verified result (same reference).
    if (first.ok && second.ok) {
      expect(second.profile).toBe(first.profile);
    }
  });

  it("never shares the verified identity across request scopes", async () => {
    // Request 1: admin profile.
    setCacheScope(new Map());
    const sessionClient1 = makeSessionClient(mockUser);
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      sessionClient1 as any,
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(profileA) as any,
    );
    const first = await getVerifiedAdmin();

    // Request 2: brand-new scope + a different profile (different role).
    vi.clearAllMocks();
    setCacheScope(new Map());
    const sessionClient2 = makeSessionClient(mockUser);
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      sessionClient2 as any,
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(profileB) as any,
    );
    const second = await getVerifiedAdmin();

    // The second request runs the full verification again — it must NOT
    // reuse the first request's cached identity.
    expect(sessionClient2.auth.getUser).toHaveBeenCalledTimes(1);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.profile).not.toBe(first.profile);
      expect(second.profile.role).toBe("super_admin");
    }
  });

  it("passes through without caching when there is no request scope (safe lower bound)", async () => {
    setCacheScope(null);
    const sessionClient = makeSessionClient(mockUser);
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      sessionClient as any,
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(profileA) as any,
    );

    await getVerifiedAdmin();
    await getVerifiedAdmin();

    // No request context → every call executes for real. Identity is never
    // cached across calls (the React cache() no-dispatcher behavior).
    expect(sessionClient.auth.getUser).toHaveBeenCalledTimes(2);
  });
});
