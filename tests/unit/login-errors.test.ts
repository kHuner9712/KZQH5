import { describe, expect, it } from "vitest";
import {
  LOGIN_ERROR_MESSAGES,
  mapLoginError,
} from "@/lib/security/login-errors";

// ============================================================
// KZQ-P1-020: admin login error standardization — pure mapping
//
// Verifies that mapLoginError NEVER returns the raw provider error
// text and always returns one of the fixed Chinese messages.
// ============================================================

describe("mapLoginError — credential errors", () => {
  it("maps the invalid_credentials code to the fixed Chinese message", () => {
    expect(
      mapLoginError({ code: "invalid_credentials", message: "Invalid login credentials", status: 400 }),
    ).toBe(LOGIN_ERROR_MESSAGES.INVALID_CREDENTIALS);
  });

  it("maps the raw 'Invalid login credentials' message text", () => {
    expect(mapLoginError({ message: "Invalid login credentials" })).toBe(
      LOGIN_ERROR_MESSAGES.INVALID_CREDENTIALS,
    );
  });

  it("maps 'Wrong password' message text (case-insensitive)", () => {
    expect(mapLoginError({ message: "Wrong password" })).toBe(
      LOGIN_ERROR_MESSAGES.INVALID_CREDENTIALS,
    );
  });

  it("maps a real AuthApiError-shaped object", () => {
    const err = new Error("Invalid login credentials");
    (err as { code?: string }).code = "invalid_credentials";
    expect(mapLoginError(err)).toBe(LOGIN_ERROR_MESSAGES.INVALID_CREDENTIALS);
  });
});

describe("mapLoginError — email confirmation", () => {
  it("maps the email_not_confirmed code", () => {
    expect(mapLoginError({ code: "email_not_confirmed", message: "Email not confirmed" })).toBe(
      LOGIN_ERROR_MESSAGES.EMAIL_NOT_CONFIRMED,
    );
  });

  it("maps the 'Email not confirmed' message text", () => {
    expect(mapLoginError({ message: "Email not confirmed" })).toBe(
      LOGIN_ERROR_MESSAGES.EMAIL_NOT_CONFIRMED,
    );
  });
});

describe("mapLoginError — rate limiting", () => {
  it("maps 'For security purposes, you can only request this after 30 seconds'", () => {
    expect(
      mapLoginError({
        message:
          "For security purposes, you can only request this after 30 seconds.",
      }),
    ).toBe(LOGIN_ERROR_MESSAGES.RATE_LIMITED);
  });

  it("maps 'Too many requests'", () => {
    expect(mapLoginError({ message: "Too many requests" })).toBe(
      LOGIN_ERROR_MESSAGES.RATE_LIMITED,
    );
  });
});

describe("mapLoginError — unknown / malformed input", () => {
  it("falls back to the generic message for unknown provider errors", () => {
    expect(mapLoginError({ message: "Some unexpected provider error" })).toBe(
      LOGIN_ERROR_MESSAGES.GENERIC,
    );
  });

  it("falls back to generic for null", () => {
    expect(mapLoginError(null)).toBe(LOGIN_ERROR_MESSAGES.GENERIC);
  });

  it("falls back to generic for undefined", () => {
    expect(mapLoginError(undefined)).toBe(LOGIN_ERROR_MESSAGES.GENERIC);
  });

  it("falls back to generic for a plain string", () => {
    expect(mapLoginError("Invalid login credentials")).toBe(
      LOGIN_ERROR_MESSAGES.GENERIC,
    );
  });

  it("falls back to generic for a non-object primitive", () => {
    expect(mapLoginError(42)).toBe(LOGIN_ERROR_MESSAGES.GENERIC);
  });

  it("falls back to generic when message is not a string", () => {
    expect(mapLoginError({ message: 123 })).toBe(LOGIN_ERROR_MESSAGES.GENERIC);
  });

  it("falls back to generic when code is present but unknown", () => {
    expect(mapLoginError({ code: "some_future_code", message: "x" })).toBe(
      LOGIN_ERROR_MESSAGES.GENERIC,
    );
  });
});

describe("mapLoginError — no raw provider text leaks", () => {
  const RAW_PHRASES = [
    "Invalid login credentials",
    "Email not confirmed",
    "For security purposes",
    "Too many requests",
    "wrong password",
  ];

  it("never returns a message containing raw provider text", () => {
    const errors: unknown[] = [
      { code: "invalid_credentials", message: "Invalid login credentials" },
      { message: "Email not confirmed" },
      { message: "For security purposes, you can only request this after 30 seconds." },
      { message: "Too many requests" },
      new Error("Wrong password"),
      { message: "arbitrary internal detail: pg-pool-3 timeout" },
    ];
    for (const err of errors) {
      const result = mapLoginError(err);
      for (const phrase of RAW_PHRASES) {
        expect(result.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
      // The result must always be one of the fixed whitelist strings.
      expect(Object.values(LOGIN_ERROR_MESSAGES)).toContain(result);
    }
  });
});
