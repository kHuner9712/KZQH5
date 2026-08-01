// ============================================================
// KZQ-P1-022-b: Admin MFA enrollment error standardization
// ------------------------------------------------------------
// The admin MFA enrollment UI (components/admin/MfaEnrollment.tsx)
// must NEVER display the raw Supabase Auth error message (English,
// provider-specific, may expose internal details). This module is
// the ONLY place that maps any MFA error to a fixed Chinese message.
//
// Rules:
//   - The raw error message / code is NEVER returned to the caller.
//   - Classification is best-effort via error.code (preferred) and
//     message keywords; anything unrecognized maps to a generic
//     fixed message.
//   - The returned strings are the fixed whitelist below.
//
// This is a pure, dependency-free module (no Next.js runtime, no
// Supabase client) so it is safe to import from the client MFA
// component and from unit tests.
// ============================================================

/** Fixed Chinese messages — the ONLY strings shown to the user. */
export const MFA_ERROR_MESSAGES = {
  /** The submitted TOTP verification code is invalid. */
  INVALID_CODE: "验证码不正确，请重新输入",
  /** The account already has a verified MFA factor enrolled. */
  ALREADY_ENROLLED: "该账号已启用 MFA，请勿重复绑定",
  /** The session expired before the MFA operation completed. */
  SESSION_EXPIRED: "会话已过期，请重新登录后再试",
  /** Any other MFA failure — generic, no provider detail. */
  GENERIC: "操作失败，请稍后重试",
  /** Client-side initialization / unexpected exception. */
  UNEXPECTED: "操作异常，请稍后重试",
} as const;

export type MfaErrorMessage =
  (typeof MFA_ERROR_MESSAGES)[keyof typeof MFA_ERROR_MESSAGES];

interface ErrorLike {
  code?: unknown;
  message?: unknown;
}

function readStringField(err: unknown, field: "code" | "message"): string | null {
  if (!err || typeof err !== "object") return null;
  const value = (err as ErrorLike)[field];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

/**
 * Map any MFA error (Supabase Auth error or unexpected exception)
 * to a fixed Chinese message.
 *
 *   - error.code wins when it is a known Supabase Auth code.
 *   - Otherwise message keywords are matched (case-insensitive).
 *   - Anything unrecognized returns MFA_ERROR_MESSAGES.GENERIC.
 *
 * The raw message is never surfaced.
 */
export function mapMfaError(err: unknown): MfaErrorMessage {
  const code = readStringField(err, "code")?.toLowerCase() ?? null;
  if (code === "invalid_code" || code === "otp_expired") {
    return MFA_ERROR_MESSAGES.INVALID_CODE;
  }
  if (code === "factor_already_enrolled") {
    return MFA_ERROR_MESSAGES.ALREADY_ENROLLED;
  }
  if (
    code === "session_expired" ||
    code === "jwt_expired" ||
    code === "bad_jwt"
  ) {
    return MFA_ERROR_MESSAGES.SESSION_EXPIRED;
  }

  const message = readStringField(err, "message");
  if (message) {
    const normalized = message.toLowerCase();
    if (
      /invalid (totp )?code|verification code|incorrect.*code|totp.*fail|invalid factor/i.test(
        normalized,
      )
    ) {
      return MFA_ERROR_MESSAGES.INVALID_CODE;
    }
    if (
      /already.*enrolled|already.*verified|factor.*exist|duplicate/i.test(
        normalized,
      )
    ) {
      return MFA_ERROR_MESSAGES.ALREADY_ENROLLED;
    }
    if (
      /session.*expired|token.*expired|jwt.*expired|not authenticated|auth required/i.test(
        normalized,
      )
    ) {
      return MFA_ERROR_MESSAGES.SESSION_EXPIRED;
    }
  }

  return MFA_ERROR_MESSAGES.GENERIC;
}
