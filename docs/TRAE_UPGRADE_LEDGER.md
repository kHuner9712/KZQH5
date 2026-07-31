# KZQH5 Upgrade Ledger

This ledger is the single source of truth for the staged upgrade program defined
in the project upgrade brief. Each row is verified against the current code on
`main` before status is assigned. Status assignments must not be trusted
blindly — re-verify against real code before starting any task.

## Current Baseline

- Repository: https://github.com/kHuner9712/KZQH5
- Base branch: `main`
- Audited commit: `c544e5a309fe45dbd5e25179a9ee062fda0be212` (PR #42 security hardening)
- Node version (engines): `20.x` (local runtime v24.15.0 used for tooling only)
- Next.js version: `15.5.21`
- Supabase client version: `@supabase/supabase-js 2.109.0`, `@supabase/ssr 0.12.0`
- Last updated: 2026-07-31 (KZQ-P0-005-a completed)

## Status Values

- `pending` — problem verified to still exist; not yet started
- `in_progress` — partially addressed; remaining work required
- `blocked` — cannot proceed without external decision/input
- `completed` — verified resolved in current code
- `superseded` — resolved by a different merged change; no longer applicable

## Verification Method

Every status in this ledger was assigned by auditing the real code at the
audited commit above, not by trusting prior conversation history. Evidence
column records the file and line where the decision was made.

## Task Table

| ID | Priority | Workstream | Task | Status | Branch | Commit | Acceptance | Notes |
|----|----------|------------|------|--------|--------|--------|------------|-------|
| KZQ-P0-001 | P0 | Epic A 两阶段上传 | Verify `complete_temp_upload_finalize` RPC business return value (`ok` field) | completed | `trae/p0-001-finalize-rpc-return-value` | (this commit) | `npm run typecheck && npm run lint && npx vitest run tests/unit/two-phase-upload-service.test.ts` → PASS (21/21) | Fixed `lib/services/two-phase-upload.ts:461-525`: now destructures `data`, validates `ok===true`, handles transport error/null/malformed/`ok:false`; RPC failure now compensates by deleting moved final object, enqueues cleanup if compensation fails, calls failFinalize, returns `FINALIZE_RPC_FAILED`; never returns success on RPC failure. Added 8 tests covering all 9 required scenarios. `mapErrorCode` updated to map `FINALIZE_RPC_FAILED`→500 |
| KZQ-P0-002 | P0 | Epic A 两阶段上传 | Correct signed upload URL lifecycle model (DB expiry vs Supabase capability TTL) | completed | `trae/p0-002-signed-url-lifecycle` | (this commit) | `npm run typecheck && npm run lint && npx vitest run tests/unit/two-phase-upload-service.test.ts tests/unit/two-phase-upload-client.test.ts tests/unit/migration-temp-uploads-safety.test.ts` → PASS (28+20=48) | Renamed `SIGNED_UPLOAD_URL_TTL_SECONDS`→`TEMP_UPLOAD_AUTHORIZATION_WINDOW_SECONDS` in `lib/services/two-phase-upload.ts:85`; added docblock distinguishing 3 lifetimes (business window 5min / signed-URL capability TTL server-controlled 1h / cleanup protection period); updated `docs/TWO_PHASE_UPLOAD_DESIGN.md:97-108` and Future Work section :248-261 documenting cleanup dispatcher MUST wait for both windows before deleting temp objects; fixed stale "5-minute TTL" comment in `app/api/admin/storage/upload/authorize/route.ts:18`; added test verifying `expiresAt` is the business window deadline. No migration needed — cleanup dispatcher not yet implemented; protection-period guard documented for future implementation |
| KZQ-P0-003 | P0 | Epic A 两阶段上传 | Bind upload token to authorizing admin (verify actor_id on finalize) | completed | `trae/p0-003-bind-upload-actor` | (this commit) | `npm run typecheck && npm run lint && npx vitest run tests/unit/two-phase-upload-service.test.ts tests/unit/migration-temp-uploads-safety.test.ts && npm run check:migration-immutability:ci` → PASS | New forward-only migration `20260731020000_bind_temp_upload_actor.sql` drops old `claim_temp_upload_for_finalize(uuid)` and creates `claim_temp_upload_for_finalize(uuid, text)` that verifies `p_actor_id` against `row.actor_id`; rejects with `invalid_actor`/`actor_not_bound`/`actor_mismatch`; SECURITY INVOKER, empty search_path, EXECUTE to service_role ONLY. Updated `types/database.ts` RPC signature, `lib/services/two-phase-upload.ts` to pass `p_actor_id`, `finalize/route.ts` mapErrorCode for 403. Added 5 actor-binding service tests + 12 migration safety tests. Super-admin override NOT implemented (requires explicit business need + audit design — deferred) |
| KZQ-P0-004 | P0 | Epic A 两阶段上传 | Final extension from verified MIME, not original filename | completed | `trae/p0-004-mime-extension-mapping` | (this commit) | `npm run typecheck && npm run lint && npx vitest run tests/unit/storage-validation.test.ts tests/unit/two-phase-upload-service.test.ts tests/unit/storage-audit-compensation.test.ts tests/unit/admin-storage-upload-route.test.ts` → PASS (122+47=169 tests) | New shared `getExtensionForMimeType(mimeType)` in `lib/validation/storage.ts` — single source of truth for MIME→canonical extension (PDF→.pdf, JPEG→.jpg, PNG→.png, WebP→.webp). Two-stage `two-phase-upload.ts:368` now uses `getExtensionForMimeType(declaredMimeType)` instead of `getExtensionFromFilename(row.declared_filename)`; removed local `getExtensionFromFilename` helper. Single-stage `storage-upload.ts:189` now uses `getExtensionForMimeType(mimeType)` instead of `fileExt || MIME_DEFAULT_EXT[mimeType]`; removed redundant `MIME_DEFAULT_EXT` map; filename extension still cross-checked via `validateMimeExtensionConsistency` (defense in depth). Original filename retained on temp_uploads row for display/audit only. Added 7 `getExtensionForMimeType` unit tests + 8 two-stage MIME-derived extension tests (wrong ext, no ext, double ext, all 4 MIME types, filename-ignored). No migration required |
| KZQ-P0-005 | P0 | Epic A 两阶段上传 | Unify single-stage and two-stage storage saga (workstream — split into atomic sub-tasks) | in_progress | — | — | per sub-task | Workstream split into sub-tasks a-g below. Sub-task a (unified validation) completed. Remaining: b (unified final path generation), c (unified audit-start), d (unified audit-complete), e (unified compensation), f (unified cleanup/reconciliation), g (unified storage object reference registration) |
| KZQ-P0-005-a | P0 | Epic A 两阶段上传 | Unify upload file validation (shared `validateUploadFile`) | completed | `trae/p0-005a-unify-validation` | `ff530b5` | `npm run typecheck && npm run lint && npx vitest run tests/unit/storage-validation.test.ts tests/unit/two-phase-upload-service.test.ts tests/unit/two-phase-upload-client.test.ts tests/unit/storage-audit-compensation.test.ts tests/unit/admin-storage-upload-route.test.ts` → PASS (typecheck OK, lint OK, 71+21+14+30+27=163 tests passed, verified 2026-07-31) | New shared `validateUploadFile()` in `lib/validation/storage.ts` — single entry point for MIME + size + magic bytes + ext consistency, returns MIME-derived ext. Single-stage `storage-upload.ts` now delegates to it via `validateSingleStageUploadFile` wrapper (maps shared error codes to AdminWriteErrorCode); removed inline `validateUploadFile` body and unused imports (`extractFileExtension`, `getExtensionForMimeType`). Two-stage `two-phase-upload.ts` authorize phase now uses shared `validateFileSize` instead of inline size check. Both paths already shared `validateMimeType`, `verifyMagicBytes`, `getExtensionForMimeType` via imports from `@/lib/validation/storage`. Added 11 `validateUploadFile` unit tests + updated `storage-audit-compensation` mock to include `validateUploadFile`. No behavior change — same validation rules, now in one place |
| KZQ-P0-005-b | P0 | Epic A 两阶段上传 | Unify final path generation | pending | — | — | per sub-task | Both paths already share `generatePrivateStoragePath` / `generatePublicStoragePath` via `storage-upload.ts` exports. Audit if further unification needed |
| KZQ-P0-010 | P0 | Epic B 数据库版本 | Production schema fallback explicit (`ALLOW_SCHEMA_COMPATIBILITY_FALLBACK`) | pending | — | — | `npm run typecheck && npm run lint && npx vitest run tests/unit/release-readiness.test.ts` | `lib/repositories/inquiries.ts:206-222` and `lib/repositories/admin-dashboard.ts:137-159` silently fall back to direct table queries when RPC undeployed (added by PR #41); no env gate, no operator signal |
| KZQ-P0-011 | P0 | Epic B 数据库 | Strengthen release readiness DB contract | pending | — | — | `npm run check:release-readiness && npx vitest run tests/unit/release-readiness.test.ts` | `scripts/check-release-readiness.mjs:588-604` checks RPC existence + anon/authenticated grants via `verify_schema_readiness()`; MISSING: RPC param/return signature contracts, explicit RLS/policy/revoke verification, service-role function privileges, migration ledger SHA-256 consistency (only checks files present at :737-760) |
| KZQ-P1-001 | P1 | Epic C 后台 CSP | Clean up CSP implementation vs docs conflict (fix source of truth, do not switch mode) | pending | — | — | `npx vitest run tests/unit/release-readiness.test.ts` | `scripts/check-release-readiness.mjs:321-327` stale comment lists `CSP still Report-Only` as blocker, but implemented gate at :487-495 allows `CSP_ENFORCING=true`; comment contradicts logic |
| KZQ-P1-002 | P1 | Epic C 后台 CSP | Switch admin CSP to Enforcing | pending | — | — | `npm run typecheck && npm run lint && npm run test:e2e:demo` | `middleware.ts:65` admin routes unconditionally emit `Content-Security-Policy-Report-Only`; enforcing header never emitted; `check-release-readiness.mjs:475` confirms "Admin routes: ALWAYS Report-Only". Precondition: CSP violation audit not yet done |
| KZQ-P1-003 | P1 | Epic C 后台 CSP | Remove unnecessary `unsafe-eval` in public CSP | pending | — | — | `npx vitest run tests/unit/csp-policy.test.ts && npm run test:e2e:demo` | `lib/security/csp-policy.ts:165` public CSP still has `'unsafe-eval'` in script-src; inline comment at :154 admits it is retained speculatively ("may need it") without proven requirement |
| KZQ-P1-004 | P1 | Epic C 后台 CSP | Auth cookie & XSS risk assessment (workstream — split into atomic sub-tasks) | pending | — | — | per sub-task | `lib/supabase/middleware-session.ts:128` `httpOnly:false` (matches @supabase/ssr defaults); CSP Report-Only default (`middleware.ts:86`); `dangerouslySetInnerHTML` used in 5 places for JSON-LD; no Trusted Types. Must split before execution |
| KZQ-P1-010 | P1 | Epic D 限流与 Origin | Pre-auth coarse rate limiting | pending | — | — | `npx vitest run tests/unit/admin-write-boundary.test.ts` | `lib/security/admin-write-boundary.ts:159` `getVerifiedAdmin()` (runs `auth.getUser()` at `admin-auth.ts:66` + profile query at :100) runs BEFORE global rate limit at `:176` and per-admin limit at `:198`; unauthenticated attackers consume no quota |
| KZQ-P1-011 | P1 | Epic D 限流与 Origin | Production distributed rate limiting boundary | pending | — | — | `npm run check:release-readiness && npx vitest run tests/unit/rate-limit.test.ts` | `lib/services/rate-limit.ts:58-190` only `MemoryRateLimiter`; all factories return memory instances; no Redis/KV/Postgres RPC; header comment defers to EdgeOne WAF which is not code-verified |
| KZQ-P1-012 | P1 | Epic D 限流与 Origin | Strict canonical origin validation (`CANONICAL_APP_ORIGIN`) | pending | — | — | `npx vitest run tests/unit/http-security.test.ts` | `lib/security/http-security.ts:251-298` `isSameOrigin` compares Origin against `x-forwarded-host`/`host`; NO `CANONICAL_APP_ORIGIN` env var exists; port-mismatch bug IS handled (:292-297) but no canonical allowlist |
| KZQ-P1-013 | P1 | Epic D 限流与 Origin | HSTS & CSP reporting endpoint external protocol | pending | — | — | `npx vitest run tests/unit/middleware.test.ts` | `middleware.ts:113-118` HSTS set on HTTPS only (good); `:106` `new URL(CSP_REPORT_PATH, request.url)` derives Reporting-Endpoints from forwarded host, NOT canonical origin — can produce `http://` URLs |
| KZQ-P1-020 | P1 | Epic E 管理员身份 | Admin login error standardization | pending | — | — | `npx vitest run tests/unit/login-form.test.ts` (to be added) | `components/admin/LoginForm.tsx:46` `setError(signInError.message \|\| "登录失败…")` leaks raw Supabase error to UI; `:53` leaks exception `err.message`; login is client-side only (no server route to standardize) |
| KZQ-P1-021 | P1 | Epic E 管理员身份 | Admin login brute force protection | pending | — | — | `npm run check:release-readiness` | No server-side login API route; login via client-side `supabase.auth.signInWithPassword` in `LoginForm.tsx:40`; no dedicated login rate-limit bucket in `rate-limit.ts`; no captcha |
| KZQ-P1-022 | P1 | Epic E 管理员身份 | Admin MFA / AAL2 (workstream — split into 6 atomic sub-tasks) | pending | — | — | per sub-task | Grep for `mfa\|aal2\|totp\|enrolled_factors\|authenticator-assurance` found 0 real matches; MFA completely absent. Must split: 1) audit, 2) enrollment, 3) challenge, 4) server guard, 5) step-up, 6) E2E+docs |
| KZQ-P2-001 | P2 | Epic F 性能结构 | Admin verify request-level dedup | pending | — | — | `npx vitest run tests/unit/admin-auth.test.ts` (to be added) | `app/admin/(protected)/layout.tsx:31` + `app/admin/(protected)/page.tsx:28` both call `getVerifiedAdmin()`; `admin-auth.ts` has no React `cache()` or request-scoped memoization; `auth.getUser()` + `admin_profiles` query run multiple times per request |
| KZQ-P2-002 | P2 | Epic F 性能结构 | Dashboard query convergence | in_progress | — | — | `npx vitest run tests/unit/admin-dashboard.test.ts` | Primary path uses single `get_admin_dashboard_snapshot` RPC (`admin-dashboard.ts:141`); 5-query fallback at `:193-237` still retained for schema/permission error — fallback removal pending KZQ-P0-010 |
| KZQ-P2-003 | P2 | Epic F 性能结构 | Unified media domain config | pending | — | — | `npx vitest run tests/unit/media-domain-config.test.ts` (to be added) | No shared config module; `next.config.mjs:134-135`, `lib/security/csp-policy.ts:33,54`, `scripts/check-release-readiness.mjs:706` each independently read `NEXT_PUBLIC_SUPABASE_URL`/`MEDIA_CDN_DOMAINS`; no `lib/config/media-domains.ts` |
| KZQ-P2-010 | P2 | Epic H 仓库治理 | Clean up superseded draft PRs #31, #32, #33 | pending | — | — | `gh pr view 31,32,33` | GitHub PRs #31, #32, #33 reportedly still OPEN+DRAFT; their work superseded by merged PRs #34/#35/#41/#42; needs `gh` verification then close with explanation |
| KZQ-P2-011 | P2 | Epic H 仓库治理 | Remove deprecated Vercel integration & docs | pending | — | — | `npx vitest run tests/unit/release-readiness.test.ts` | 17 files still reference Vercel: `README.md`, `.env.example`, `docs/LAUNCH_CHECKLIST.md`, `docs/EDGEONE_COMPATIBILITY_MATRIX.md`, `DEPLOYMENT.md`, `scripts/check-release-readiness.mjs:261`, `lib/supabase/middleware-session.ts:9` |
| KZQ-P2-012 | P2 | Epic H 仓库治理 | Supply chain security (workstream — split into atomic sub-tasks: CodeQL, secret scanning, Dependabot, SBOM, license audit, GH Actions permissions) | in_progress | — | — | per sub-task | `.github/dependabot.yml` PRESENT (npm + github-actions weekly); `.github/workflows/ci.yml:8-9` top-level `permissions: contents: read`; actions SHA-pinned (:46,51). MISSING: `codeql.yml`, `sbom.yml`, secret scanning config, license audit. Dependabot + permissions baseline done; CodeQL/SBOM/secret-scanning sub-tasks pending |
| KZQ-UPG-001 | UPG | Epic G 框架升级 | Node 20 → 22 | pending | — | — | `npm run typecheck && npm run lint && npm run test:unit && npm run build:demo` | `package.json:5-6` engines `node:20.x`; `.github/workflows/ci.yml` uses `node-version:20` in all jobs; `@types/node:^20.16.11`; must confirm EdgeOne Node support first |
| KZQ-UPG-002 | UPG | Epic G 框架升级 | Migrate ESLint to Flat Config (`eslint.config.mjs`) | pending | — | — | `npm run lint` | `.eslintrc.json` exists (legacy); no `eslint.config.mjs`; `package.json:14` runs `next lint` (removed in Next 16); tracked in `docs/NEXT16_UPGRADE_PLAN.md` Phase 3 |
| KZQ-UPG-003 | UPG | Epic G 框架升级 | PDF.js & Turbopack compatibility | completed | — | — | `npm run sync:pdfjs-worker && npm run build:demo` | `next.config.mjs:226` `transpilePackages:["pdfjs-dist"]`; :227-243 webpack config only sets `resolve.fallback` for Node builtins (no pdfjs-specific alias); `scripts/sync-pdfjs-worker.mjs` syncs worker to `public/lib/pdfjs/pdf.worker.min.mjs`. Code is Turbopack-compatible. Note: runtime PDF preview verification recommended before Next 16 upgrade |
| KZQ-UPG-004 | UPG | Epic G 框架升级 | Next.js 16 upgrade | pending | — | — | Release Gate (full) | `package.json:44` next `15.5.21`; `docs/NEXT16_UPGRADE_PLAN.md:3` "Status: DRAFT — DO NOT EXECUTE YET"; pre-flight checklist unchecked. Blocked by UPG-001, UPG-002, UPG-003 (UPG-003 done) |

## Workstream Split Requirements

The following tasks are workstreams and MUST be split into atomic sub-tasks
before any code work begins. Each sub-task becomes its own row (appending a
suffix such as `-a`, `-b`) and is executed one per round.

- **KZQ-P0-005** — split into: unified validation; unified final path
  generation; unified audit-start; unified audit-complete; unified
  compensation; unified cleanup/reconciliation; unified storage object
  reference registration.
- **KZQ-P1-004** — split into: Supabase SSR cookie compatibility audit;
  CSP enforce task; output encoding / dangerous HTML ban; client-side
  dependency audit; Trusted Types feasibility.
- **KZQ-P1-022** — split into: data & Auth capability audit; enrollment;
  challenge; server guard; sensitive operation step-up; E2E & docs.
- **KZQ-P2-012** — split into: CodeQL; secret scanning config;
  Dependabot/Renovate tuning; SBOM; license audit; GitHub Actions
  permissions minimization.

## Next Task Selection

Per the priority order `P0 → P1 → P2 → Framework Upgrade`, and within each
priority by Task ID order, the next atomic task to execute is:

**KZQ-P0-005-b** — Unify final path generation.

KZQ-P0-005-a (unified validation) is completed. KZQ-P0-005-b audits whether
the two upload paths share the same final path generation logic. Both paths
already import `generatePrivateStoragePath` / `generatePublicStoragePath`
from `storage-upload.ts`, so this sub-task may verify that no drift exists
and mark it `completed` or `superseded` without code changes.

## Acceptance Commands Reference

- Atomic task: typically `npm run typecheck && npm run lint` plus the
  task-specific vitest target recorded in the Acceptance column.
- Migration task: add `npm run check:migration-immutability:ci` and
  `npm run test:database`.
- Build config task: add `npm run build:demo` (or production-contract build).
- Full Release Gate (only when an Epic completes, a framework upgrade lands,
  or staging/production handoff): `npm ci && npm run
  check:migration-immutability:ci && npm run typecheck && npm run lint && npm
  run test:unit && npm run test:database && npm run build:demo && npm run
  build:production && npm run test:e2e:demo && npm audit --omit=dev
  --audit-level=high && git diff --check`.
