import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison to mitigate timing side-channels when
 * comparing secrets (bearer tokens, API keys). Returns true only when
 * the two strings are byte-equal AND have the same length.
 *
 * Behavior:
 *   - When lengths differ, we still perform a comparison against a
 *     same-length mirror of the longer string so the timing profile
 *     does not leak length information.
 *   - When either argument is empty, returns false.
 *
 * @param a - The user-supplied value (e.g., from the Authorization header).
 * @param b - The server-known secret (e.g., from process.env).
 */
export function safeSecretEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Compare against a same-length mirror to keep timing roughly constant.
    // The result is always false because lengths differ.
    const mirror = Buffer.alloc(aBuf.length, 0);
    try {
      timingSafeEqual(aBuf, mirror);
    } catch {
      // ignore — comparison result is already false
    }
    return false;
  }
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}
