import { describe, expect, it, vi } from "vitest";
import { classifyProtectedReadResult } from "../../scripts/lib/protected-read-verification.mjs";

describe("protected read verification", () => {
  it("accepts an explicit PostgreSQL grant denial", () => {
    expect(
      classifyProtectedReadResult({ data: null, error: { code: "42501" } }),
    ).toEqual({ ok: true, mode: "grant-denied" });
  });

  it("accepts an empty RLS-filtered result", () => {
    expect(classifyProtectedReadResult({ data: [], error: null })).toEqual({
      ok: true,
      mode: "rls-filtered",
    });
  });

  it("rejects visible protected data without exposing it", () => {
    const log = vi.spyOn(console, "log");
    const result = classifyProtectedReadResult({
      data: [{ id: "hidden" }],
      error: null,
    });

    expect(result).toEqual({ ok: false, mode: "visible-data" });
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects a schema cache error", () => {
    expect(
      classifyProtectedReadResult({ data: null, error: { code: "PGRST205" } }),
    ).toEqual({ ok: false, mode: "unexpected-error" });
  });

  it("rejects a network-style error without a code", () => {
    expect(
      classifyProtectedReadResult({ data: null, error: { transient: true } }),
    ).toEqual({ ok: false, mode: "unexpected-error" });
  });

  it("rejects null data without an error", () => {
    expect(classifyProtectedReadResult({ data: null, error: null })).toEqual({
      ok: false,
      mode: "unexpected-error",
    });
  });

  it("rejects non-array data without an error", () => {
    expect(
      classifyProtectedReadResult({ data: { protected: true }, error: null }),
    ).toEqual({ ok: false, mode: "unexpected-error" });
  });
});
