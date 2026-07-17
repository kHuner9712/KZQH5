import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Supabase client factories before importing the module under test.
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: vi.fn(),
}));

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { failureStage, getVerifiedAdmin } from "@/lib/services/admin-auth";

// Test fixtures: no real email, UUID, token, or database error text.
const mockUser = { id: "test-user-id", email: null } as any;
const mockProfile = { id: "test-user-id", email: null } as any;

function makeSessionClient(opts: {
  user?: any;
  error?: any;
  throw?: boolean;
}) {
  if (opts.throw) {
    return {
      auth: {
        getUser: vi.fn().mockRejectedValue(new Error("getUser threw")),
      },
    };
  }
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.user ?? null },
        error: opts.error ?? null,
      }),
    },
  };
}

function makeAdminClient(opts: {
  profile?: any;
  error?: any;
}) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: opts.profile ?? null,
            error: opts.error ?? null,
          }),
        }),
      }),
    }),
  };
}

describe("getVerifiedAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. returns session-verification-failed when auth.getUser returns an error", async () => {
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ error: new Error("auth error") }) as any,
    );
    const result = await getVerifiedAdmin();
    expect(result).toEqual({
      ok: false,
      reason: "session-verification-failed",
    });
  });

  it("2. returns session-missing when user is null and no error", async () => {
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: null }) as any,
    );
    const result = await getVerifiedAdmin();
    expect(result).toEqual({ ok: false, reason: "session-missing" });
  });

  it("3. returns admin-client-unavailable when createAdminSupabaseClient throws", async () => {
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: mockUser }) as any,
    );
    vi.mocked(createAdminSupabaseClient).mockImplementation(() => {
      throw new Error("env var missing");
    });
    const result = await getVerifiedAdmin();
    expect(result).toEqual({
      ok: false,
      reason: "admin-client-unavailable",
    });
  });

  it("4. returns profile-query-failed when profile query returns an error", async () => {
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: mockUser }) as any,
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient({ error: new Error("query error") }) as any,
    );
    const result = await getVerifiedAdmin();
    expect(result).toEqual({
      ok: false,
      reason: "profile-query-failed",
    });
  });

  it("5. returns profile-missing when profile data is null", async () => {
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: mockUser }) as any,
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient({ profile: null }) as any,
    );
    const result = await getVerifiedAdmin();
    expect(result).toEqual({ ok: false, reason: "profile-missing" });
  });

  it("6. returns ok=true when user and profile are both valid", async () => {
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: mockUser }) as any,
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient({ profile: mockProfile }) as any,
    );
    const result = await getVerifiedAdmin();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user).toBe(mockUser);
      expect(result.profile).toBe(mockProfile);
      expect(result.client).toBeDefined();
    }
  });
});

describe("failureStage", () => {
  it("7. maps a countUnreadInquiries failure to stage=data", () => {
    // Even when admin verification succeeded, a downstream data-read
    // failure must map to the external stage "data".
    const okResult = {
      ok: true,
      user: mockUser,
      profile: mockProfile,
      client: {},
    } as any;
    expect(failureStage(okResult, true)).toBe("data");
  });

  it("8. never exposes internal reasons in the stage value", () => {
    const reasons = [
      "session-missing",
      "session-verification-failed",
      "admin-client-unavailable",
      "profile-query-failed",
      "profile-missing",
    ] as const;
    // Only these three external stage values (plus null) are allowed.
    const allowedStages = new Set(["session", "profile", "data", null]);

    for (const reason of reasons) {
      const result = { ok: false, reason } as any;
      const stage = failureStage(result);

      // Stage must be one of the allowed external values.
      expect(allowedStages.has(stage)).toBe(true);

      // The internal reason string must never appear in the stage value.
      expect(String(stage)).not.toContain(reason);
    }

    // A successful verification with no data error returns null (no redirect).
    const okResult = {
      ok: true,
      user: mockUser,
      profile: mockProfile,
      client: {},
    } as any;
    expect(failureStage(okResult, false)).toBeNull();
  });
});
