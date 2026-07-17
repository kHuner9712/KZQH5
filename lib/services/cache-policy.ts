/**
 * Pure validator for health endpoint Cache-Control headers.
 *
 * The application sets `no-store`, but the EdgeOne CDN may rewrite it to
 * `public,max-age=0,must-revalidate`. Both are safe non-cacheable strategies
 * for a runtime health endpoint that must never be positively cached.
 */

export function isHealthCacheControlSafe(
  headerValue: string | null | undefined,
): boolean {
  if (!headerValue) return false;
  const value = headerValue.trim().toLowerCase();
  if (!value) return false;

  // immutable is never safe for a health endpoint
  if (/\bimmutable\b/.test(value)) return false;

  // positive max-age allows positive caching
  const maxAgeMatch = value.match(/\bmax-age=(\d+)\b/);
  if (maxAgeMatch && Number(maxAgeMatch[1]) > 0) return false;

  // positive s-maxage allows shared-cache caching
  const sMaxAgeMatch = value.match(/\bs-maxage=(\d+)\b/);
  if (sMaxAgeMatch && Number(sMaxAgeMatch[1]) > 0) return false;

  // no-store always disables caching
  if (/\bno-store\b/.test(value)) return true;

  // max-age=0 combined with must-revalidate forces revalidation
  const hasMaxAgeZero = maxAgeMatch !== null && Number(maxAgeMatch[1]) === 0;
  const hasMustRevalidate = /\bmust-revalidate\b/.test(value);
  if (hasMaxAgeZero && hasMustRevalidate) return true;

  return false;
}
