// ============================================================
// KZQ-P2-003: Single source of truth for media domain rules.
// ------------------------------------------------------------
// Pure ESM config module (NO Next.js runtime dependency, NO imports
// of any kind) shared by every consumer that decides which hosts are
// allowed for Supabase storage / CDN media:
//   - next.config.mjs                       (image remotePatterns)
//   - lib/validation/url.ts                 (runtime media URL validator)
//   - lib/security/csp-policy.ts            (img-src / connect-src)
//   - scripts/check-release-readiness.mjs   (deployment host checks)
//   - tests
//
// Before KZQ-P2-003 each consumer duplicated the Supabase project-host
// regex, the CDN entry validator, and the loopback detection. This module
// is the ONE place those rules are defined so they cannot drift.
//
// IMPORTANT:
//   - It must stay dependency-free and import-free so Node ESM configs
//     (next.config.mjs, scripts/*.mjs) can require it directly.
//   - It must NOT be imported from client components.
//   - TypeScript consumers get their types from media-domains.d.mts.
// ============================================================

/** Canonical Supabase project host shape: <20-char project-ref>.supabase.co */
export const SUPABASE_PROJECT_HOST_PATTERN = /^[a-z0-9]{20}\.supabase\.co$/;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Loopback host detection that resists bypass. Normalizes the hostname
 * before comparing:
 *   - lowercases (defensive; callers usually already lowercase)
 *   - strips a single trailing dot (DNS root label: "localhost." ≡ "localhost")
 *   - strips IPv6 brackets ("[::1]" → "::1")
 */
export function isLoopbackHost(hostname) {
  let h = String(hostname).toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return LOOPBACK_HOSTS.has(h);
}

/**
 * Validate a single MEDIA_CDN_DOMAINS entry. Returns the normalized
 * hostname when valid, null when invalid.
 *
 * Rules:
 *   - hostname only (no protocol, port, path, query, credentials)
 *   - must be a valid DNS name (letters, digits, hyphens, dots)
 *   - must NOT be an IP literal
 *   - must NOT be a bare TLD (".com", "supabase.co")
 */
export function validateCdnDomainEntry(raw) {
  const trimmed = String(raw || "").trim().toLowerCase();
  if (!trimmed) return null;
  // Reject anything that looks like a URL (protocol, port, path, query).
  if (/[:/?#@]/.test(trimmed)) return null;
  // Reject bare IPs.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return null;
  // Reject IPv6 / bracketed hosts.
  if (trimmed.startsWith("[") || trimmed.endsWith("]")) return null;
  // Must contain at least one dot and be a valid DNS name.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) return null;
  // Reject all-segments-empty or leading/trailing dot.
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) return null;
  // Reject ".." sequences.
  if (trimmed.includes("..")) return null;
  return trimmed;
}

/**
 * Parse a comma-separated MEDIA_CDN_DOMAINS value into the normalized
 * hostname allowlist. Invalid entries are dropped (callers decide
 * whether to treat an all-invalid input as a config error).
 */
export function parseCdnDomains(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of String(raw).split(",")) {
    const domain = validateCdnDomainEntry(part);
    if (domain) out.push(domain);
  }
  return out;
}

/**
 * Parse a Supabase / storage absolute URL into its normalized parts.
 * Returns null for a malformed URL.
 *
 * @returns {{ protocol: string, hostname: string, port: string } | null}
 *   protocol has NO trailing colon ("https"); hostname is lowercased;
 *   port is the explicit port string ("" when implicit).
 */
export function parseSupabaseUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return {
      protocol: parsed.protocol.replace(":", ""),
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port,
    };
  } catch {
    return null;
  }
}
