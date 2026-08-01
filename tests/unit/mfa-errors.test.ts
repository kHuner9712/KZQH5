import { describe, expect, it } from "vitest";
import {
  MFA_ERROR_MESSAGES,
  mapMfaError,
} from "@/lib/security/mfa-errors";

// ============================================================
// KZQ-P1-022-b: admin MFA enrollment error standardization
//
// Verifies that mapMfaError NEVER returns the raw provider error
// text and always returns one of the fixed Chinese messages.
// ============================================================

describe("mapMfaError — invalid verification code", () => {
  it("maps the invalid_code code to the fixed Chinese message", () => {
    expect(
      mapMfaError({ code: "invalid_code", message: "Invalid code", status: 400 }),
    ).toBe(MFA_ERROR_MESSAGES.INVALID_CODE);
  });

  it("maps the otp_expired code to the fixed Chinese message", () => {
    expect(mapMfaError({ code: "otp_expired", message: "OTP has expired" })).toBe(
      MFA_ERROR_MESSAGES.INVALID_CODE,
    );
  });

  it("maps the raw 'Invalid TOTP code' message text", () => {
    expect(mapMfaError({ message: "Invalid TOTP code" })).toBe(
      MFA_ERROR_MESSAGES.INVALID_CODE,
    );
  });

  it("maps 'Invalid code. Try again' message text (case-insensitive)", () => {
    expect(mapMfaError({ message: "Invalid code. Try again" })).toBe(
      MFA_ERROR_MESSAGES.INVALID_CODE,
    );
  });
});

describe("mapMfaError — already enrolled", () => {
  it("maps the factor_already_enrolled code", () => {
    expect(
      mapMfaError({ code: "factor_already_enrolled", message: "Factor already enrolled" }),
    ).toBe(MFA_ERROR_MESSAGES.ALREADY_ENROLLED);
  });

  it("maps the 'already enrolled' message text", () => {
    expect(mapMfaError({ message: "A factor of this type has already been enrolled" })).toBe(
      MFA_ERROR_MESSAGES.ALREADY_ENROLLED,
    );
  });
});

describe("mapMfaError — session expiry", () => {
  it("maps the session_expired code", () => {
    expect(mapMfaError({ code: "session_expired", message: "Session expired" })).toBe(
      MFA_ERROR_MESSAGES.SESSION_EXPIRED,
    );
  });

  it("maps the jwt_expired code", () => {
    expect(mapMfaError({ code: "jwt_expired", message: "JWT expired" })).toBe(
      MFA_ERROR_MESSAGES.SESSION_EXPIRED,
    );
  });

  it("maps the 'not authenticated' message text", () => {
    expect(mapMfaError({ message: "Not authenticated" })).toBe(
      MFA_ERROR_MESSAGES.SESSION_EXPIRED,
    );
  });
});

describe("mapMfaError — unknown / malformed input", () => {
  it("falls back to the generic message for unknown provider errors", () => {
    expect(mapMfaError({ message: "Some unexpected provider error" })).toBe(
      MFA_ERROR_MESSAGES.GENERIC,
    );
  });

  it("falls back to generic for null", () => {
    expect(mapMfaError(null)).toBe(MFA_ERROR_MESSAGES.GENERIC);
  });

  it("falls back to generic for undefined", () => {
    expect(mapMfaError(undefined)).toBe(MFA_ERROR_MESSAGES.GENERIC);
  });

  it("falls back to generic for a plain string", () => {
    expect(mapMfaError("Invalid TOTP code")).toBe(MFA_ERROR_MESSAGES.GENERIC);
  });

  it("falls back to generic for a non-object primitive", () => {
    expect(mapMfaError(42)).toBe(MFA_ERROR_MESSAGES.GENERIC);
  });

  it("falls back to generic when code is present but unknown", () => {
    expect(mapMfaError({ code: "some_future_code", message: "x" })).toBe(
      MFA_ERROR_MESSAGES.GENERIC,
    );
  });
});

describe("mapMfaError — no raw provider text leaks", () => {
  const RAW_PHRASES = [
    "Invalid TOTP code",
    "already been enrolled",
    "Session expired",
    "OTP has expired",
    "Factor already enrolled",
  ];

  it("never returns a message containing raw provider text", () => {
    const errors: unknown[] = [
      { code: "invalid_code", message: "Invalid TOTP code" },
      { code: "otp_expired", message: "OTP has expired" },
      { code: "factor_already_enrolled", message: "Factor already enrolled" },
      { code: "session_expired", message: "Session expired" },
      { message: "Invalid code. Try again" },
      { message: "A factor of this type has already been enrolled" },
      { message: "Not authenticated" },
      new Error("Invalid TOTP code"),
    ];
    for (const err of errors) {
      const result = mapMfaError(err);
      for (const phrase of RAW_PHRASES) {
        expect(result.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
      // The result must always be one of the fixed whitelist strings.
      expect(Object.values(MFA_ERROR_MESSAGES)).toContain(result);
    }
  });
});
