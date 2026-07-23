// ============================================================
// Site indexing switch
//
// EdgeOne is the official runtime platform; Vercel is deprecated
// and may only be used as a temporary technical preview. Until the
// EdgeOne production domain has passed acceptance, the public site
// must NOT be indexed by search engines — otherwise unfinished
// pages, placeholder copy and demo contact details would be crawled.
//
// `NEXT_PUBLIC_SITE_INDEXING_ENABLED` controls indexing globally:
//   - unset / empty / any value other than literal "true"  -> noindex
//   - strictly "true" (case-sensitive)                     -> allow indexing
//
// "TRUE", "True", "1", "yes" are intentionally NOT accepted. The
// switch must be turned on deliberately, with the exact string "true",
// only after the production domain is verified.
//
// Effects when indexing is disabled:
//   - page metadata outputs `noindex, nofollow`
//   - /robots.txt disallows all crawling
//   - /api/health reports `indexingEnabled: false`
//   - sitemap.xml may still be generated, but robots.txt never advertises it
//
// This module is safe to import from both server and client components
// because it only reads a NEXT_PUBLIC_ env var (inlined at build time).
// ============================================================

export function isIndexingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SITE_INDEXING_ENABLED === "true";
}
