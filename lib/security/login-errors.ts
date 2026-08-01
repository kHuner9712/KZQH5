// ============================================================
// KZQ-P1-020: Admin login error standardization
// ------------------------------------------------------------
// The admin login form (app/admin/login/LoginForm.tsx) previously
// displayed `signInError.message` / `err.message` directly to the
// user. Those strings come from Supabase Auth (English, provider
// specific) and may expose internal details. This module is the
// ONLY place that maps any login error to a fixed Chinese message.
//
// Rules:
//   - The raw error message / code is NEVER returned to the caller.
//   - Classification is best-effort via error.code (preferred) and
//     message keywords; anything unrecognized maps to a generic
//     fixed message.
//   - The returned strings are the fixed whitelist below.
//
// This is a pure, dependency-free module (no Next.js runtime, no
// Supabase client) so it is safe to import from the client login
// component and from unit tests.
// ============================================================

/** Fixed Chinese messages — the ONLY strings shown to the user. */
export const LOGIN_ERROR_MESSAGES = {
  /** Invalid email/password combination. */
  INVALID_CREDENTIALS: "邮箱或密码错误，请重新输入",
  /** Account exists but email not verified. */
  EMAIL_NOT_CONFIRMED: "邮箱尚未验证，请先完成邮箱验证后再登录",
  /** Rate-limited / too many attempts. */
  RATE_LIMITED: "尝试次数过多，请稍后再试",
  /** Any other auth failure — generic, no provider detail. */
  GENERIC: "登录失败，请检查邮箱和密码后重试",
  /** Client-side initialization exception (not an auth failure). */
  UNEXPECTED: "登录异常，请稍后重试",
} as const;

export type LoginErrorMessage =
  (typeof LOGIN_ERROR_MESSAGES)[keyof typeof LOGIN_ERROR_MESSAGES];

interface ErrorLike {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

function readStringField(err: unknown, field: "code" | "message"): string | null {
  if (!err || typeof err !== "object") return null;
  const value = (err as ErrorLike)[field];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

/**
 * Map any login error (Supabase Auth error or unexpected exception)
 * to a fixed Chinese message.
 *
 *   - error.code wins when it is a known Supabase Auth code.
 *   - Otherwise message keywords are matched (case-insensitive).
 *   - Anything unrecognized returns LOGIN_ERROR_MESSAGES.GENERIC.
 *
 * The raw message is never surfaced.
 */
export function mapLoginError(err: unknown): LoginErrorMessage {
  const code = readStringField(err, "code")?.toLowerCase() ?? null;
  if (code === "invalid_credentials") {
    return LOGIN_ERROR_MESSAGES.INVALID_CREDENTIALS;
  }
  if (code === "email_not_confirmed") {
    return LOGIN_ERROR_MESSAGES.EMAIL_NOT_CONFIRMED;
  }

  const message = readStringField(err, "message");
  if (message) {
    const normalized = message.toLowerCase();
    if (
      /invalid login credentials|wrong password|invalid email|bad credentials/i.test(
        normalized,
      )
    ) {
      return LOGIN_ERROR_MESSAGES.INVALID_CREDENTIALS;
    }
    if (/email not confirmed/i.test(normalized)) {
      return LOGIN_ERROR_MESSAGES.EMAIL_NOT_CONFIRMED;
    }
    if (/too many|rate limit|for security purposes|attempts/i.test(normalized)) {
      return LOGIN_ERROR_MESSAGES.RATE_LIMITED;
    }
  }

  return LOGIN_ERROR_MESSAGES.GENERIC;
}
