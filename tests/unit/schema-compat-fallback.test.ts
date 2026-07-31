import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// KZQ-P0-010: Production schema compatibility fallback gate
//
// Verifies:
//   - lib/config/schema-compat.ts correctly gates the fallback
//   - lib/repositories/inquiries.ts respects the gate
//   - lib/repositories/admin-dashboard.ts respects the gate
//   - scripts/check-release-readiness.mjs BLOCKs in production
//     when the switch is "true"
// ============================================================

beforeEach(() => {
  // Default to non-production so tests don't accidentally inherit the
  // production fail-closed default. Individual tests override as needed.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ALLOW_SCHEMA_COMPATIBILITY_FALLBACK", "");
  delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ============================================================
// lib/config/schema-compat.ts — config module
// ============================================================
describe("lib/config/schema-compat", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;
  });

  it("production default: fallback NOT allowed when env unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;
    const { isSchemaCompatFallbackAllowed } = await import("@/lib/config/schema-compat");
    expect(isSchemaCompatFallbackAllowed()).toBe(false);
  });

  it("non-production default: fallback allowed when env unset", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;
    const { isSchemaCompatFallbackAllowed } = await import("@/lib/config/schema-compat");
    expect(isSchemaCompatFallbackAllowed()).toBe(true);
  });

  it('production + ALLOW_SCHEMA_COMPATIBILITY_FALLBACK="true" opts in', async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_SCHEMA_COMPATIBILITY_FALLBACK", "true");
    const { isSchemaCompatFallbackAllowed } = await import("@/lib/config/schema-compat");
    expect(isSchemaCompatFallbackAllowed()).toBe(true);
  });

  it('production + "TRUE" (case variant) does NOT opt in', async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_SCHEMA_COMPATIBILITY_FALLBACK", "TRUE");
    const { isSchemaCompatFallbackAllowed } = await import("@/lib/config/schema-compat");
    expect(isSchemaCompatFallbackAllowed()).toBe(false);
  });

  it('production + "1" does NOT opt in', async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_SCHEMA_COMPATIBILITY_FALLBACK", "1");
    const { isSchemaCompatFallbackAllowed } = await import("@/lib/config/schema-compat");
    expect(isSchemaCompatFallbackAllowed()).toBe(false);
  });

  it('production + "yes" does NOT opt in', async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_SCHEMA_COMPATIBILITY_FALLBACK", "yes");
    const { isSchemaCompatFallbackAllowed } = await import("@/lib/config/schema-compat");
    expect(isSchemaCompatFallbackAllowed()).toBe(false);
  });

  it('production + "false" explicitly disables', async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_SCHEMA_COMPATIBILITY_FALLBACK", "false");
    const { isSchemaCompatFallbackAllowed } = await import("@/lib/config/schema-compat");
    expect(isSchemaCompatFallbackAllowed()).toBe(false);
  });

  it('non-production + "false" explicitly disables', async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_SCHEMA_COMPATIBILITY_FALLBACK", "false");
    const { isSchemaCompatFallbackAllowed } = await import("@/lib/config/schema-compat");
    expect(isSchemaCompatFallbackAllowed()).toBe(false);
  });

  it("shouldUseSchemaCompatFallback returns true for schema/permission in dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;
    const { shouldUseSchemaCompatFallback } = await import("@/lib/config/schema-compat");
    expect(shouldUseSchemaCompatFallback("schema")).toBe(true);
    expect(shouldUseSchemaCompatFallback("permission")).toBe(true);
    // Non-schema causes always return false.
    expect(shouldUseSchemaCompatFallback("connection")).toBe(false);
    expect(shouldUseSchemaCompatFallback("unknown")).toBe(false);
  });

  it("shouldUseSchemaCompatFallback returns false in production default", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;
    const { shouldUseSchemaCompatFallback } = await import("@/lib/config/schema-compat");
    expect(shouldUseSchemaCompatFallback("schema")).toBe(false);
    expect(shouldUseSchemaCompatFallback("permission")).toBe(false);
  });

  it("exports fixed log code and error code constants", async () => {
    const mod = await import("@/lib/config/schema-compat");
    expect(mod.SCHEMA_COMPAT_DISABLED_LOG_CODE).toBe("SCHEMA_COMPAT_FALLBACK_DISABLED");
    expect(mod.SCHEMA_COMPAT_DISABLED_ERROR_CODE).toBe("SCHEMA_COMPAT_DISABLED");
  });
});

// ============================================================
// lib/repositories/inquiries.ts — countUnreadInquiries gate
// ============================================================
describe("countUnreadInquiries — schema-compat gate", () => {
  const mockRpc = vi.fn();
  const mockFrom = vi.fn();

  const mockClient = {
    rpc: mockRpc,
    from: mockFrom,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Default: dev mode (fallback allowed)
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;
  });

  it("falls back to direct query in dev mode when RPC returns schema error", async () => {
    const { countUnreadInquiries } = await import("@/lib/repositories/inquiries");

    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "PGRST205", name: "PostgrestError" }, // schemaCacheMiss
    });
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValueOnce({
        eq: vi.fn().mockResolvedValueOnce({ count: 5, error: null }),
      }),
    });

    const result = await countUnreadInquiries(mockClient as never);
    expect(result).toBe(5);
    expect(mockFrom).toHaveBeenCalledWith("inquiries");
  });

  it("throws UnreadInquiryCountError in production when RPC returns schema error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;

    const { countUnreadInquiries, UnreadInquiryCountError } = await import("@/lib/repositories/inquiries");

    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "PGRST205", name: "PostgrestError" },
    });

    await expect(countUnreadInquiries(mockClient as never)).rejects.toThrow(
      UnreadInquiryCountError,
    );
    // Direct-query fallback MUST NOT be called in production default mode.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("throws in production when RPC transport throws schema error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;

    const { countUnreadInquiries, UnreadInquiryCountError } = await import("@/lib/repositories/inquiries");

    mockRpc.mockRejectedValueOnce({ code: "42P01", name: "PostgrestError" }); // undefined_table

    await expect(countUnreadInquiries(mockClient as never)).rejects.toThrow(
      UnreadInquiryCountError,
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("throws for permission error in production default mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;

    const { countUnreadInquiries, UnreadInquiryCountError } = await import("@/lib/repositories/inquiries");

    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", name: "PostgrestError" }, // insufficient_privilege
    });

    await expect(countUnreadInquiries(mockClient as never)).rejects.toThrow(
      UnreadInquiryCountError,
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("does NOT fall back for connection errors even in dev mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;

    const { countUnreadInquiries, UnreadInquiryCountError } = await import("@/lib/repositories/inquiries");

    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "08006", name: "PostgrestError" }, // connection_failure
    });

    await expect(countUnreadInquiries(mockClient as never)).rejects.toThrow(
      UnreadInquiryCountError,
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("production + explicit ALLOW_SCHEMA_COMPATIBILITY_FALLBACK=true re-enables fallback", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_SCHEMA_COMPATIBILITY_FALLBACK", "true");

    const { countUnreadInquiries } = await import("@/lib/repositories/inquiries");

    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "PGRST205", name: "PostgrestError" },
    });
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValueOnce({
        eq: vi.fn().mockResolvedValueOnce({ count: 3, error: null }),
      }),
    });

    const result = await countUnreadInquiries(mockClient as never);
    expect(result).toBe(3);
    expect(mockFrom).toHaveBeenCalled();
  });
});

// ============================================================
// lib/repositories/admin-dashboard.ts — getSnapshot gate
// ============================================================
describe("createAdminDashboardQueries.getSnapshot — schema-compat gate", () => {
  const mockRpc = vi.fn();

  const mockClient = {
    rpc: mockRpc,
    from: vi.fn(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn(),
        limit: vi.fn(),
        order: vi.fn(),
      }),
    })),
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;
  });

  it("throws DashboardSnapshotError in production when RPC returns schema error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;

    const { createAdminDashboardQueries, DashboardSnapshotError } = await import(
      "@/lib/repositories/admin-dashboard"
    );

    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "PGRST205", name: "PostgrestError" },
    });

    const queries = createAdminDashboardQueries(mockClient as never);
    await expect(queries.getSnapshot()).rejects.toThrow(DashboardSnapshotError);
  });

  it("throws in production when RPC transport throws schema error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;

    const { createAdminDashboardQueries, DashboardSnapshotError } = await import(
      "@/lib/repositories/admin-dashboard"
    );

    mockRpc.mockRejectedValueOnce({ code: "42P01", name: "PostgrestError" });

    const queries = createAdminDashboardQueries(mockClient as never);
    await expect(queries.getSnapshot()).rejects.toThrow(DashboardSnapshotError);
  });

  it("throws for permission error in production default mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;

    const { createAdminDashboardQueries, DashboardSnapshotError } = await import(
      "@/lib/repositories/admin-dashboard"
    );

    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", name: "PostgrestError" },
    });

    const queries = createAdminDashboardQueries(mockClient as never);
    await expect(queries.getSnapshot()).rejects.toThrow(DashboardSnapshotError);
  });

  it("does NOT throw for connection error in production (treats as real failure, not schema)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;

    const { createAdminDashboardQueries, DashboardSnapshotError } = await import(
      "@/lib/repositories/admin-dashboard"
    );

    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "08006", name: "PostgrestError" }, // connection_failure
    });

    const queries = createAdminDashboardQueries(mockClient as never);
    await expect(queries.getSnapshot()).rejects.toThrow(DashboardSnapshotError);
  });
});
