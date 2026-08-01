/**
 * Minimal TOTP (RFC 6238) code generator for staging E2E tests.
 *
 * KZQ-P1-022-f: the admin MFA E2E flow needs a real TOTP code to pass
 * `auth.mfa.challenge()` + `auth.mfa.verify()`. The enrollment step
 * exposes the base32 secret once in the UI; this helper derives the
 * 6-digit code from it so the test can drive the challenge without a
 * third-party OTP dependency.
 *
 * Implementation notes:
 *   - HMAC-SHA1 + 30s time step + 6 digits (the default TOTP profile that
 *     Google Authenticator / Supabase Auth use).
 *   - `stepOffset` retries against the previous/next 30s window so tests
 *     tolerate ±1 step clock drift (the same tolerance authenticator apps
 *     implement), instead of masking failures.
 *   - Uses Node's built-in crypto only — no new dependency.
 */

import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_WINDOW_SECONDS = 30;
const TOTP_DIGITS = 6;

/** Decode an RFC 4648 base32 string (ignoring spaces, dashes and padding). */
function base32Decode(input: string): Buffer {
  const normalized = input.replace(/[\s=-]/g, "").toUpperCase();
  if (normalized.length === 0) {
    throw new Error("TOTP secret is empty");
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`TOTP secret contains invalid base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generate the current TOTP code for `secret`.
 *
 * @param secret      base32 TOTP secret (as shown by the enrollment UI)
 * @param stepOffset  window offset to retry (±1 tolerates clock drift)
 */
export function generateTotp(secret: string, stepOffset = 0): string {
  const key = base32Decode(secret);
  const counter =
    Math.floor(Date.now() / 1000 / TOTP_WINDOW_SECONDS) + stepOffset;

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}
