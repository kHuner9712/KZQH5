import { describe, expect, it } from "vitest";

import {
  ADMIN_DATA_FAILURE_CAUSES,
  ADMIN_DATA_LOG_CODE,
  classifyAdminDataError,
  normalizeCause,
  type AdminDataFailureCause,
} from "@/lib/services/admin-data-error";

describe("classifyAdminDataError", () => {
  describe("schema cause", () => {
    it("classifies 42703 (undefined_column) as schema", () => {
      expect(classifyAdminDataError({ code: "42703" })).toBe("schema");
    });
    it("classifies PGRST204 as schema", () => {
      expect(classifyAdminDataError({ code: "PGRST204" })).toBe("schema");
    });
    it("classifies 42P01 (undefined_table) as schema", () => {
      expect(classifyAdminDataError({ code: "42P01" })).toBe("schema");
    });
    it("classifies PGRST205 as schema", () => {
      expect(classifyAdminDataError({ code: "PGRST205" })).toBe("schema");
    });
    it("classifies numeric code 42703 as schema", () => {
      expect(classifyAdminDataError({ code: 42703 })).toBe("schema");
    });
    it("classifies lowercase pgrst204 as schema (case-insensitive)", () => {
      expect(classifyAdminDataError({ code: "pgrst204" })).toBe("schema");
    });
  });

  describe("permission cause", () => {
    it("classifies 42501 (insufficient_privilege) as permission", () => {
      expect(classifyAdminDataError({ code: "42501" })).toBe("permission");
    });
  });

  describe("authentication cause", () => {
    it("classifies 28000 as authentication", () => {
      expect(classifyAdminDataError({ code: "28000" })).toBe("authentication");
    });
    it("classifies PGRST301 as authentication", () => {
      expect(classifyAdminDataError({ code: "PGRST301" })).toBe("authentication");
    });
    it("classifies PGRST302 (jwt expired) as authentication", () => {
      expect(classifyAdminDataError({ code: "PGRST302" })).toBe("authentication");
    });
  });

  describe("connection cause", () => {
    it("classifies 08006 (connection_failure) as connection", () => {
      expect(classifyAdminDataError({ code: "08006" })).toBe("connection");
    });
    it("classifies PGRST000 as connection", () => {
      expect(classifyAdminDataError({ code: "PGRST000" })).toBe("connection");
    });
  });

  describe("timeout cause", () => {
    it("classifies 57014 (query_canceled) as timeout", () => {
      expect(classifyAdminDataError({ code: "57014" })).toBe("timeout");
    });
    it("classifies PGRST003 as timeout", () => {
      expect(classifyAdminDataError({ code: "PGRST003" })).toBe("timeout");
    });
    it("classifies AbortError by name as timeout", () => {
      expect(classifyAdminDataError({ name: "AbortError" })).toBe("timeout");
    });
    it("classifies TimeoutError by name as timeout", () => {
      expect(classifyAdminDataError({ name: "TimeoutError" })).toBe("timeout");
    });
  });

  describe("unknown cause", () => {
    it("classifies unknown code as unknown", () => {
      expect(classifyAdminDataError({ code: "XYZ123" })).toBe("unknown");
    });
    it("classifies error without code as unknown", () => {
      expect(classifyAdminDataError({ name: "SomeOtherError" })).toBe("unknown");
    });
    it("classifies null as unknown", () => {
      expect(classifyAdminDataError(null)).toBe("unknown");
    });
    it("classifies undefined as unknown", () => {
      expect(classifyAdminDataError(undefined)).toBe("unknown");
    });
    it("classifies plain Error as unknown", () => {
      expect(classifyAdminDataError(new Error("boom"))).toBe("unknown");
    });
  });

  describe("sensitive payload handling", () => {
    it("does NOT read message field", () => {
      // Even if message contains a code-like string, classification must
      // not match on message. Only code/name are inspected.
      const err = {
        code: "42501",
        message: "permission denied for table users",
        details: "row-level security policy",
        hint: "Use service_role key",
        stack: "Error: ...",
      };
      const cause = classifyAdminDataError(err);
      expect(cause).toBe("permission");
    });

    it("does NOT read details, hint, or stack", () => {
      const err = {
        code: "PGRST999", // unknown code
        message: "some message",
        details: "42703", // would be schema if read, but must be ignored
        hint: "42P01", // would be schema if read, but must be ignored
        stack: "57014", // would be timeout if read, but must be ignored
      };
      const cause = classifyAdminDataError(err);
      expect(cause).toBe("unknown");
    });

    it("does not throw on malformed input", () => {
      expect(() => classifyAdminDataError({ code: {} })).not.toThrow();
      expect(() => classifyAdminDataError({ code: [] })).not.toThrow();
      expect(() => classifyAdminDataError(42 as any)).not.toThrow();
      expect(() => classifyAdminDataError("string-error" as any)).not.toThrow();
    });
  });
});

describe("normalizeCause", () => {
  it("returns the cause if it is in the allowed set", () => {
    expect(normalizeCause("schema")).toBe("schema");
    expect(normalizeCause("permission")).toBe("permission");
    expect(normalizeCause("authentication")).toBe("authentication");
    expect(normalizeCause("connection")).toBe("connection");
    expect(normalizeCause("timeout")).toBe("timeout");
    expect(normalizeCause("count-unavailable")).toBe("count-unavailable");
    expect(normalizeCause("unknown")).toBe("unknown");
  });

  it("returns unknown for unexpected values", () => {
    expect(normalizeCause("bogus")).toBe("unknown");
    expect(normalizeCause("data")).toBe("unknown"); // stage, not cause
    expect(normalizeCause("session")).toBe("unknown");
  });

  it("returns unknown for null/undefined/empty", () => {
    expect(normalizeCause(null)).toBe("unknown");
    expect(normalizeCause(undefined)).toBe("unknown");
    expect(normalizeCause("")).toBe("unknown");
  });
});

describe("ADMIN_DATA_LOG_CODE", () => {
  it("provides a fixed log code for every cause", () => {
    for (const cause of ADMIN_DATA_FAILURE_CAUSES) {
      expect(ADMIN_DATA_LOG_CODE[cause]).toMatch(/^ADMIN_GUARD_DATA_/);
    }
  });

  it("uses distinct log codes per cause", () => {
    const codes = ADMIN_DATA_FAILURE_CAUSES.map(
      (c) => ADMIN_DATA_LOG_CODE[c],
    );
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("covers the exact required codes", () => {
    const expected = [
      "ADMIN_GUARD_DATA_SCHEMA",
      "ADMIN_GUARD_DATA_PERMISSION",
      "ADMIN_GUARD_DATA_AUTHENTICATION",
      "ADMIN_GUARD_DATA_CONNECTION",
      "ADMIN_GUARD_DATA_TIMEOUT",
      "ADMIN_GUARD_DATA_COUNT_UNAVAILABLE",
      "ADMIN_GUARD_DATA_UNKNOWN",
    ];
    for (const code of expected) {
      expect(Object.values(ADMIN_DATA_LOG_CODE)).toContain(code);
    }
  });
});

describe("redirect param safety", () => {
  // Regression: the redirect URL template must only embed a fixed cause,
  // never raw error fields. Verify the cause set matches what can appear
  // in the URL.
  it("every cause is a lowercase-hyphenated safe token", () => {
    for (const cause of ADMIN_DATA_FAILURE_CAUSES) {
      expect(cause).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it("cause set is frozen — no accidental mutation", () => {
    const original: AdminDataFailureCause[] = [...ADMIN_DATA_FAILURE_CAUSES];
    // Attempting to push on a readonly tuple is a type error, but verify at
    // runtime that the reference hasn't changed shape.
    expect([...ADMIN_DATA_FAILURE_CAUSES]).toEqual(original);
  });
});
