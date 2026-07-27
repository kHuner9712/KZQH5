# Next.js 16 Upgrade Plan

> Status: **DRAFT — DO NOT EXECUTE YET.**
>
> This document is a forward plan only. The current security and
> reliability hardening pass (Work Packages A–H) must land on `main`
> and run in production without incidents **before** any Next.js 16
> work begins. Upgrade work happens on a separate long-lived branch
> (`upgrade/next16`) and must not block security fixes.

## 1. Why a separate upgrade

Next.js 16 changes several stable primitives this codebase depends on.
A rushed in-place upgrade would risk:

- breaking the Auth middleware contract that Work Package C established
- regressing the PDF.js worker isolation shipped in PR #22
- re-introducing prefetch storms (PR #22 eliminated them with `prefetch={false}`)
- silently widening the CSP surface that Work Package G tightened
- invalidating the migration immutability baseline

A separate branch with explicit acceptance gates per phase is the only
safe path.

## 2. Upgrade scope

The upgrade covers, in execution order:

1. `middleware.ts` → `proxy.ts`
2. `next lint` → ESLint CLI + Flat Config
3. `.eslintrc` (legacy) → `eslint.config.js` (Flat Config)
4. PDF.js 6 + Turbopack compatibility
5. `unstable_cache` → `use cache` (Cache Components opt-in)
6. Cache Components (per-route, conservative)
7. React Compiler (opt-in, with `bun`/`npm` build integration)
8. Node minimum version bump
9. Rollback plan
10. Phased acceptance criteria

Each phase is independently mergeable. If any phase fails acceptance,
we stop and reassess — we do not continue stacking changes.

## 3. Phase 1 — `middleware.ts` → `proxy.ts`

### Why

Next.js 16 renames the root middleware entry to `proxy.ts`. The old
`middleware.ts` continues to work in a deprecated mode but is slated
for removal in 17.

### Scope

- Rename `middleware.ts` → `proxy.ts`
- Update the exported symbol if required (verify against the 16 RC
  release notes at upgrade time — the API was still in flux as of the
  last public preview)
- Keep the `matcher` config identical (Work Package C tuned it to
  avoid running on static assets, images, and the PDF worker)
- Re-run the Auth Session refresh tests from Work Package C:
  - unauthenticated admin access redirects
  - valid admin session is refreshed and cookies are set on response
  - tampered/expired session is rejected
  - public ISR pages do **not** become dynamic
  - Demo mode still works

### Risk

The `proxy.ts` change touches the request pipeline. A subtle
behavioral difference (e.g. matcher semantics) could silently turn
cached public pages into dynamic ones and tank ISR performance.

### Acceptance gate

- All Work Package C tests pass unchanged
- `Cache-Control` headers on `/en`, `/en/products`, `/products/[slug]`
  still include `s-maxage` (verify via `curl -I`)
- Lighthouse ISR score on `/en` does not regress
- No new dynamic-route entries appear in `.next/routes-manifest.json`

## 4. Phase 2 — `next lint` → ESLint CLI

### Why

`next lint` is removed in 16. The migration moves linting to the
ESLint CLI directly.

### Scope

- Replace `npm run lint` script: `next lint` → `eslint .`
- Install `eslint` and the project's eslint config as dev dependencies
  (already done — verify versions are 16-compatible)
- Update CI workflow `.github/workflows/ci.yml` lint step
- Update pre-commit hooks (none currently — none to update)
- Verify `eslint-config-next` 16 matches the project's expectations

### Risk

ESLint CLI does not auto-load Next.js's recommended rules the same
way `next lint` does. Some rules may need explicit enabling.

### Acceptance gate

- `npm run lint` exits 0 on current `main`
- No new lint errors compared to `next lint` baseline
- CI lint step still runs in under 60s

## 5. Phase 3 — `.eslintrc` → Flat Config

### Why

ESLint 9 (required by Next.js 16) drops legacy `.eslintrc` support.
Flat Config (`eslint.config.js`) is the only supported format.

### Scope

- Convert `.eslintrc.json` (or `.eslintrc`) → `eslint.config.js`
- Move `next/core-web-vitals` and `next/typescript` presets to flat
  config equivalents
- Preserve all custom rules currently in `.eslintrc`
- Verify `eslint-config-next` 16 exports a flat-config-compatible
  entry point

### Risk

Some legacy plugins may not be flat-config compatible. Audit each
plugin before migration.

### Acceptance gate

- `eslint.config.js` exists and is valid
- `npm run lint` still passes
- All previously-disabled rules (via inline `// eslint-disable-next-line`)
  continue to work

## 6. Phase 4 — PDF.js 6 + Turbopack

### Why

PDF.js 6 already ships in the current build. Next.js 16 makes
Turbopack the default bundler for dev and prod builds. The current
`transpilePackages: ["pdfjs-dist"]` webpack config may not apply under
Turbopack.

### Scope

- Audit `next.config.mjs` `webpack` callback — it should be a no-op
  under Turbopack or moved to `turbopack` config
- Verify PDF.js worker still loads via `next/dynamic` with `ssr: false`
  (Work Package for PR #22 fixed this; verify the fix still holds)
- Run the documents E2E tests (`tests/e2e/demo-documents.spec.ts`) under
  Turbopack

### Risk

Turbopack has different module resolution rules. `pdfjs-dist/legacy/build/pdf.mjs`
deep imports may resolve differently.

### Acceptance gate

- `npm run build` succeeds under Turbopack
- Documents page renders without `pdfjs-dist` worker errors
- All E2E tests in `tests/e2e/demo-documents.spec.ts` pass

## 7. Phase 5 — `unstable_cache` → `use cache`

### Why

Next.js 16 promotes `use cache` to stable. `unstable_cache` is
deprecated.

### Scope

- Audit current `unstable_cache` usage (check `lib/queries/cms.ts`,
  `lib/repositories/*.ts`, `lib/services/*.ts`)
- Replace each `unstable_cache` call with the `use cache` directive
- Verify cache tags still invalidate correctly after CMS saves
- Work Package F established `React.cache()` for per-render dedup —
  that stays unchanged (it's a React primitive, not a Next.js one)

### Risk

`use cache` semantics differ from `unstable_cache`:
- `use cache` requires all args to be serializable
- Cache tags work differently (must be declared explicitly)
- Behaviour with Auth cookies is stricter (good — Work Package F
  already forbids Auth-cookie contamination of public cache keys)

### Acceptance gate

- No `unstable_cache` references remain in the codebase
- CMS save → public page revalidate cycle still works
- No cache leaks across requests (verify via load test: same URL
  returns different content before/after a CMS save)

## 8. Phase 6 — Cache Components

### Why

Next.js 16 introduces Cache Components for finer-grained caching.
This is **opt-in** and only enabled after the previous phases land.

### Scope

- Enable `experimental.cacheComponents` on a single non-critical page
  (e.g. `/en/blog` if it exists, otherwise `/en/about`)
- Verify PPR (Partial Prerendering) behaviour
- Do NOT enable on:
  - Auth-gated admin pages
  - Inquiry submission pages
  - Any page that reads Auth cookies

### Risk

Cache Components can leak Auth state into cached HTML if misconfigured.
Work Package C's middleware already isolates Auth cookies, but
enabling Cache Components on Auth-gated pages is still high risk.

### Acceptance gate

- The opt-in page renders correctly
- Auth state does not leak (test: log in as admin, load the page, log
  out, load the page again — must not see admin UI)
- Lighthouse score improves or stays the same

## 9. Phase 7 — React Compiler

### Why

React Compiler optimizes re-renders automatically. It's opt-in and
requires React 19 (already installed).

### Scope

- Install `babel-plugin-react-compiler`
- Enable in `next.config.mjs` via `reactCompiler: true`
- Run the codemod `npx react-compiler-codemod` on the components
- Review each `useMemo`/`useCallback` — many can be removed

### Risk

The compiler is conservative but not perfect. Some patterns (e.g.
mutation of refs during render) cause build errors.

### Acceptance gate

- All unit tests pass
- All E2E tests pass
- No new console warnings
- Bundle size does not increase by more than 5%

## 10. Phase 8 — Node minimum version

### Why

Next.js 16 requires Node 20+. The project's `engines.node` is already
`20.x`, so this is a verification step, not a migration.

### Scope

- Verify `package.json` `engines.node` is `20.x` or higher
- Verify CI uses Node 20 (already set in `actions/setup-node@v4.4.0`)
- Verify EdgeOne runtime supports the chosen Node version

### Acceptance gate

- `node --version` on CI is `v20.x` or higher
- `npm ci` succeeds
- EdgeOne build does not warn about Node version

## 11. Rollback plan

If any phase causes a production incident:

1. **Revert the merge commit** on `main` immediately
2. **Re-deploy the previous known-good build** via EdgeOne rollback
3. **Update this document** with the post-mortem and the new
   acceptance gate that would have caught the issue
4. **Do not retry** the phase until the post-mortem is complete

Each phase is a single PR with a clear revert path. We do not stack
multiple phases in one PR — that makes rollback impossible.

## 12. Phased acceptance criteria

| Phase | Branch | Acceptance gate | Owner |
|-------|--------|-----------------|-------|
| 1 | `upgrade/next16/proxy` | Work Package C tests pass | TBD |
| 2 | `upgrade/next16/eslint-cli` | Lint passes, CI green | TBD |
| 3 | `upgrade/next16/flat-config` | Lint passes, no new errors | TBD |
| 4 | `upgrade/next16/turbopack` | Build + documents E2E pass | TBD |
| 5 | `upgrade/next16/use-cache` | Cache invalidation works | TBD |
| 6 | `upgrade/next16/cache-components` | Auth isolation verified | TBD |
| 7 | `upgrade/next16/react-compiler` | All tests pass | TBD |
| 8 | `upgrade/next16/node-version` | CI green | TBD |

## 13. Out of scope for this upgrade

The following are explicitly NOT part of the Next.js 16 upgrade:

- Database migrations (frozen baseline unaffected)
- Migration immutability hash (must remain stable across the upgrade)
- Supabase Auth session refresh logic (Work Package C — must still work)
- CSP policy (Work Package G — must remain enforcing)
- Readiness probe contract (Work Package G — must remain stable)
- Outbox dispatcher (Work Package E — must remain stable)
- Demo mode behaviour (must remain unchanged)

## 14. Pre-flight checklist

Before starting Phase 1:

- [ ] All Work Packages A–H merged to `main`
- [ ] Production has run for at least 2 weeks without security incidents
- [ ] Backup of current `main` branch taken
- [ ] `upgrade/next16` long-lived branch created from latest `main`
- [ ] This document reviewed and approved by the team
- [ ] Rollback procedure tested in Staging

## 15. References

- Next.js 16 upgrade guide (verify against official docs at upgrade time)
- Work Package C: Supabase Auth Session refresh
- Work Package F: Public data layer caching
- Work Package G: CSP and media URL hardening
- PR #22: PDF viewer isolation and prefetch storm fix
