/**
 * Type declarations for lib/config/media-domains.mjs (KZQ-P2-003).
 *
 * The implementation is a dependency-free ESM module shared by Node
 * configs (next.config.mjs, scripts/*.mjs) and TypeScript consumers
 * (lib/validation/url.ts, lib/security/csp-policy.ts, tests). These
 * declarations keep TypeScript strict typing while the implementation
 * stays import-free.
 *
 * Keep the signatures in sync with media-domains.mjs.
 */

/** Canonical Supabase project host shape: <20-char project-ref>.supabase.co */
export declare const SUPABASE_PROJECT_HOST_PATTERN: RegExp;

/** Loopback host detection that resists case/dot/IPv6-bracket bypass. */
export function isLoopbackHost(hostname: string): boolean;

/** Validate a single MEDIA_CDN_DOMAINS entry → normalized hostname | null. */
export function validateCdnDomainEntry(raw: string): string | null;

/** Parse a comma-separated MEDIA_CDN_DOMAINS value → hostname allowlist. */
export function parseCdnDomains(raw: string): string[];

/**
 * Parse a Supabase / storage absolute URL.
 * protocol has NO trailing colon ("https"); hostname is lowercased.
 * Returns null for a malformed URL.
 */
export function parseSupabaseUrl(
  url: string,
): { protocol: string; hostname: string; port: string } | null;
