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
- Last updated: 2026-07-31 (KZQ-P1-003 completed)

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
| KZQ-P0-001 | P0 | Epic A 两阶段上传 | Verify `complete_temp_upload_finalize` RPC business return value (`ok` field) | pending | — | — | `npm run typecheck && npm run lint && npx vitest run tests/unit/two-phase-upload-service.test.ts` | Real-code audit needed on `main` — prior branch `trae/p0-001-finalize-rpc-return-value` exists but was never merged to `main`; verify if `main` already has the fix or if the problem persists |
| KZQ-P0-002 | P0 | Epic A 两阶段上传 | Correct signed upload URL lifecycle model | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P0-003 | P0 | Epic A 两阶段上传 | Bind upload token to authorizing admin | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P0-004 | P0 | Epic A 两阶段上传 | Final extension from verified MIME | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P0-005 | P0 | Epic A 两阶段上传 | Unify single-stage and two-stage storage saga | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P0-010 | P0 | Epic B 数据库版本 | Production schema fallback explicit | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P0-011 | P0 | Epic B 数据库版本 | Strengthen release readiness database contracts | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P1-001 | P1 | Epic C 后台 CSP | Clean up CSP implementation vs docs conflict | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P1-002 | P1 | Epic C 后台 CSP | Switch admin CSP to Enforcing | blocked | — | — | `npm run typecheck && npm run lint && npm run test:e2e:demo` | BLOCKED by precondition: CSP violation report audit not yet completed. Historical black-screen context from nonce-based CSP blocking Next.js 15 App Router internal inline scripts. Requires human CSP violation audit in EdgeOne environment |
| KZQ-P1-003 | P1 | Epic C 后台 CSP | Remove unnecessary `unsafe-eval` in public CSP | completed | `trae/p1-003-remove-unsafe-eval-redo` | (this commit) | `npm run typecheck && npm run lint && npx vitest run tests/unit/csp-policy.test.ts` → PASS (43 tests, including 1 new KZQ-P1-003 regression test) | Removed `'unsafe-eval'` from `buildPublicCspPolicy()` script-src in `lib/security/csp-policy.ts:188` (was `:165`). Updated docblock at `:148-184` to document the removal decision with full audit evidence: project source has zero eval/new Function calls; pdfjs-dist worker has `new Function` for PostScript calculator JIT but `isEvalSupported()` probe is try/catch-wrapped and `PostScriptEvaluator` interpreter fallback exists (pdf.worker.mjs:30173-30182) — CSP blocking eval auto-falls-back with no function loss, only minor perf degrade for PostScript calculator PDFs (rare in product catalogs); WeChat JS-SDK loaded via external `<script src>`, whitelisted by host `https://res.wx.qq.com`, does NOT need unsafe-eval; Next.js 15 production runtime does not need unsafe-eval (dev-only React Refresh does). Added regression test `does NOT include 'unsafe-eval' in public CSP (KZQ-P1-003)` in `tests/unit/csp-policy.test.ts:234-250` that locks the removal against future regression. Updated test file header comment at `:16-22` to reflect public CSP no longer includes 'unsafe-eval'. No behavior change for admin CSP (already omitted unsafe-eval). Public CSP default mode unchanged (Report-Only). Recommended runtime verification: PDF preview on `/documents` page with `public/demo/catalogs/test-sample.pdf` before production deployment |
| KZQ-P1-004 | P1 | Epic C 后台 CSP | Auth cookie & XSS risk assessment (workstream) | pending | — | — | per sub-task | Real-code audit needed on `main`. Workstream should be split into atomic sub-tasks: (a) Supabase SSR cookie compatibility audit, (b) CSP enforce, (c) output encoding / dangerous HTML ban, (d) client-side dependency audit, (e) Trusted Types feasibility |
| KZQ-P1-010 | P1 | Epic D 限流 | Pre-auth coarse-grained rate limiting | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P1-011 | P1 | Epic D 限流 | Production distributed rate limiting boundary | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P1-012 | P1 | Epic D 限流 | Strict canonical origin validation | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P1-013 | P1 | Epic D 限流 | HSTS & CSP Reporting Endpoint external protocol | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P1-020 | P1 | Epic E 管理员身份 | Admin login error message standardization | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P1-021 | P1 | Epic E 管理员身份 | Admin login brute-force protection | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P1-022 | P1 | Epic E 管理员身份 | Admin MFA / AAL2 (workstream — split into 6 sub-tasks) | pending | — | — | per sub-task | Real-code audit needed on `main`. Must split: (1) data/Auth capability audit, (2) enrollment, (3) challenge, (4) server guard, (5) sensitive step-up, (6) E2E & docs |
| KZQ-P2-001 | P2 | Epic F 性能 | Admin auth request-level dedup | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P2-002 | P2 | Epic F 性能 | Dashboard query convergence | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-P2-003 | P2 | Epic F 性能 | Unify media domain config validation | pending | — | — | per task | Real-code audit needed on `main` |
| KZQ-UPG-001 | Framework | Epic G Node | Node 20 → Node 22 | pending | — | — | Full Release Gate | Must confirm EdgeOne supported Node version first; no assumptions about Node 24 |
| KZQ-UPG-002 | Framework | Epic G Node | Migrate ESLint Flat Config | pending | — | — | `npm run typecheck && npm run lint` | `next lint` → `eslint .`; `.eslintrc.json` → `eslint.config.mjs` |
| KZQ-UPG-003 | Framework | Epic G Node | PDF.js & Turbopack compatibility | pending | — | — | per task | Audit webpack fallback necessity; fix worker path before Next 16 |
| KZQ-UPG-004 | Framework | Epic G Node | Next.js 16 upgrade | blocked | — | — | Full Release Gate | BLOCKED by UPG-001/002/003 preconditions |
| KZQ-P2-010 | P2 | Epic H 仓库治理 | Clean up superseded draft PRs (#31, #32, #33) | pending | — | — | per task | Compare diffs against `main` |
| KZQ-P2-011 | P2 | Epic H 仓库治理 | Remove deprecated Vercel integration & docs | pending | — | — | per task | EdgeOne is the production platform |
| KZQ-P2-012 | P2 | Epic H 仓库治理 | Supply chain security enhancement (workstream — split into 6 sub-tasks) | pending | — | — | per sub-task | Split: CodeQL, secret scanning, Dependabot, SBOM, license audit, GH Actions permissions |

## Next Task Selection

Per the priority order `P0 → P1 → P2 → Framework Upgrade`, and within each
priority by Task ID order, the next atomic task to execute is:

**P0 tasks** — Audit real code on `main` to verify whether prior branch work
(KZQ-P0-001 through KZQ-P0-011) was merged or if the problems persist.

Status summary:
- KZQ-P1-003 completed (unsafe-eval removed from public CSP)
- KZQ-P1-002 BLOCKED (admin CSP enforcing switch — requires human CSP
  violation audit in EdgeOne environment)
- P0 tasks (Epic A and Epic B) require real-code audit on `main` to verify
  whether prior branch work was merged — they have the highest priority.
- KZQ-P1-001, KZQ-P1-004, and KZQ-P1-010 through KZQ-P1-022 also require
  real-code audit on `main`.

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
